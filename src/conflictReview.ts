// License: Apache-2.0 (see src/LICENSE)

/**
 * Conflict review sidebar: the "unresolved conflicts" view.
 *
 * Data source is the vault-root conflict log (.onedrive-sync-conflicts.log,
 * see conflictLog.ts). On every refresh the log is parsed, deduplicated to
 * the latest entry per file key, and each entry is re-checked against the
 * live vault state to decide whether it is still UNRESOLVED:
 *  - disposition "merged":     the file still contains `<<<<<<<` … `>>>>>>>`
 *                              conflict markers (user resolved = markers
 *                              edited away -> item disappears).
 *  - disposition "duplicated": the local ".dup" copy still exists (user
 *                              resolved = copy deleted/merged -> item
 *                              disappears).
 *  - "kept_local" / "kept_remote" leave nothing to review and are skipped.
 *
 * The view is opened automatically after a sync that produced conflicts
 * (revealConflictLeaf, called from main.ts) or manually via the command
 * palette; when the last item is resolved and a refresh finds an empty
 * list, the leaf detaches itself. No history browsing — current unresolved
 * items only.
 *
 * Desktop + mobile parity: only workspace/vault APIs are used, no window
 * or Node APIs.
 */

import {
  type App,
  ButtonComponent,
  ItemView,
  Notice,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import { CONFLICT_LOG_FILENAME, type ConflictLogEntry } from "./conflictLog";
import type { TransItemType } from "./i18n";
import { getFileRenameForDup } from "./mergeUtils";

export const VIEW_TYPE_CONFLICT_REVIEW = "onedrive-sync-conflict-review";

// Conflict markers as they literally appear inside merged markdown files:
// backtick-wrapped, one per line (written by conflictLogic.ts's smart
// conflict merge). Keep in sync with conflictLogic.ts / mergeUtils.ts.
const CONFLICT_START = "`<<<<<<<`";
const CONFLICT_BASE = "`=======`";
const CONFLICT_END = "`>>>>>>>`";

type TranslateFunc = (
  x: TransItemType,
  vars?: Record<string, string>
) => string;

/** Minimal adapter shape (exists/read) — keeps the collectors testable. */
export interface ConflictReviewAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

function optionalField(v: string): string | undefined {
  return v === "" || v === "?" ? undefined : v;
}

/**
 * Inverse of formatConflictLogLine:
 *   "ISO_TS KEY walkEtag=? writeEtag=? disposition=? [result=?]"
 * The key (a vault path) and the result file may contain spaces, so fields
 * are located by their "k=v" prefixes: the key is everything between the
 * timestamp and the first "walkEtag=" token, and "result=" (always last in
 * the formatted line) takes the rest of the line. Malformed lines return
 * undefined and are skipped.
 */
export function parseConflictLogLine(
  line: string
): ConflictLogEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  const tokens = trimmed.split(" ");
  const ts = new Date(tokens[0]);
  if (Number.isNaN(ts.getTime())) {
    return undefined;
  }

  let i = 1;
  const keyParts: string[] = [];
  while (i < tokens.length && !tokens[i].startsWith("walkEtag=")) {
    keyParts.push(tokens[i]);
    i++;
  }
  if (keyParts.length === 0) {
    return undefined;
  }

  let walkEtag: string | undefined = undefined;
  let writeEtag: string | undefined = undefined;
  let disposition: ConflictLogEntry["disposition"] | undefined = undefined;
  let resultFile: string | undefined = undefined;

  for (; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("walkEtag=")) {
      walkEtag = optionalField(tok.slice("walkEtag=".length));
    } else if (tok.startsWith("writeEtag=")) {
      writeEtag = optionalField(tok.slice("writeEtag=".length));
    } else if (tok.startsWith("disposition=")) {
      const d = tok.slice("disposition=".length);
      if (
        d === "merged" ||
        d === "duplicated" ||
        d === "kept_local" ||
        d === "kept_remote"
      ) {
        disposition = d;
      }
    } else if (tok.startsWith("result=")) {
      // last field; may contain spaces -> rest of the line
      resultFile = optionalField(
        tokens.slice(i).join(" ").slice("result=".length)
      );
      break;
    }
  }

  if (disposition === undefined) {
    return undefined;
  }
  return {
    ts,
    key: keyParts.join(" "),
    walkEtag,
    writeEtag,
    disposition,
    resultFile,
  };
}

/**
 * Parse the whole log, deduplicate per key keeping the entry with the
 * newest ts (later lines win ties — the log is append-only so file order
 * is chronological).
 */
export function parseConflictLog(text: string): ConflictLogEntry[] {
  const latest = new Map<string, ConflictLogEntry>();
  for (const line of text.split("\n")) {
    const e = parseConflictLogLine(line);
    if (e === undefined) {
      continue;
    }
    const prev = latest.get(e.key);
    if (prev === undefined || e.ts.getTime() >= prev.ts.getTime()) {
      latest.set(e.key, e);
    }
  }
  return [...latest.values()];
}

/** One `<<<<<<<` … `>>>>>>>` region: local side vs remote side lines. */
export interface ConflictMarkerBlock {
  localLines: string[];
  remoteLines: string[];
}

/** True when any conflict marker literal still appears in the text. */
export function hasConflictMarkers(text: string): boolean {
  return (
    text.includes(CONFLICT_START) ||
    text.includes(CONFLICT_BASE) ||
    text.includes(CONFLICT_END)
  );
}

/**
 * Extract every complete marker block from a merged file's text. The a side
 * (`<<<<<<<` -> `=======`) is the LOCAL content and the b side (`=======` ->
 * `>>>>>>>`) is the REMOTE content — matching computeMergedContent's
 * (left=local, right=remote) merge order. Unterminated trailing blocks are
 * dropped (hasConflictMarkers still reports them as unresolved).
 */
export function parseConflictMarkerBlocks(text: string): ConflictMarkerBlock[] {
  const blocks: ConflictMarkerBlock[] = [];
  let state: "outside" | "local" | "remote" = "outside";
  let localLines: string[] = [];
  let remoteLines: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (state === "outside") {
      if (t === CONFLICT_START) {
        state = "local";
        localLines = [];
        remoteLines = [];
      }
    } else if (state === "local") {
      if (t === CONFLICT_BASE) {
        state = "remote";
      } else if (t === CONFLICT_START) {
        // malformed nesting: restart the block
        localLines = [];
      } else {
        localLines.push(line);
      }
    } else {
      if (t === CONFLICT_END) {
        blocks.push({ localLines, remoteLines });
        state = "outside";
      } else {
        remoteLines.push(line);
      }
    }
  }
  return blocks;
}

/**
 * Replace every complete `<<<<<<<` … `=======` … `>>>>>>>` block with the
 * chosen side's lines (markers and the other side dropped); content outside
 * blocks is kept verbatim. Returns undefined when no complete block exists
 * (e.g. only stray markers from a partial manual edit, or an unterminated
 * trailing block) — callers must then leave the file unchanged.
 */
export function applyBlockToText(
  text: string,
  blockIndex: number,
  side: "local" | "remote"
): string | undefined {
  const out: string[] = [];
  let state: "outside" | "local" | "remote" = "outside";
  let localLines: string[] = [];
  let remoteLines: string[] = [];
  let cur = 0;
  let applied = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (state === "outside") {
      if (t === CONFLICT_START) {
        state = "local";
        localLines = [];
        remoteLines = [];
      } else {
        out.push(line);
      }
    } else if (state === "local") {
      if (t === CONFLICT_BASE) {
        state = "remote";
      } else if (t === CONFLICT_START) {
        // malformed nesting: restart the block (mirrors the parser above)
        localLines = [];
      } else {
        localLines.push(line);
      }
    } else {
      if (t === CONFLICT_END) {
        if (cur === blockIndex) {
          // resolve ONLY this block: drop the markers and keep the chosen side
          out.push(...(side === "local" ? localLines : remoteLines));
          applied = true;
        } else {
          // leave every other block untouched (markers + both sides intact),
          // so the user can resolve conflicts one block at a time
          out.push(CONFLICT_START);
          out.push(...localLines);
          out.push(CONFLICT_BASE);
          out.push(...remoteLines);
          out.push(CONFLICT_END);
        }
        cur++;
        state = "outside";
      } else {
        remoteLines.push(line);
      }
    }
  }
  if (!applied || state !== "outside") {
    return undefined;
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Unresolved-state collection
// ---------------------------------------------------------------------------

export type UnresolvedConflict =
  | {
      kind: "merged";
      key: string;
      blocks: ConflictMarkerBlock[];
    }
  | {
      kind: "duplicated";
      key: string;
      dupPath: string;
    };

/**
 * Read the conflict log and re-check every entry against live vault state;
 * return only the unresolved ones (latest entry per key wins). Missing log
 * file -> empty list.
 */
export async function collectUnresolvedConflicts(
  adapter: ConflictReviewAdapter
): Promise<UnresolvedConflict[]> {
  const logExists = await adapter
    .exists(CONFLICT_LOG_FILENAME)
    .catch(() => false);
  if (!logExists) {
    return [];
  }
  const text = await adapter.read(CONFLICT_LOG_FILENAME).catch(() => "");
  const entries = parseConflictLog(text);

  const out: UnresolvedConflict[] = [];
  for (const e of entries) {
    if (e.disposition === "merged") {
      const exists = await adapter.exists(e.key).catch(() => false);
      if (!exists) {
        continue; // file gone -> nothing left to review
      }
      const content = await adapter.read(e.key).catch(() => "");
      if (!hasConflictMarkers(content)) {
        continue; // markers edited away -> resolved
      }
      out.push({
        kind: "merged",
        key: e.key,
        blocks: parseConflictMarkerBlocks(content),
      });
    } else if (e.disposition === "duplicated") {
      let dupPath: string;
      try {
        dupPath = getFileRenameForDup(e.key);
      } catch {
        continue; // degenerate key
      }
      const dupExists = await adapter.exists(dupPath).catch(() => false);
      if (!dupExists) {
        continue; // .dup copy deleted/renamed back -> resolved
      }
      out.push({ kind: "duplicated", key: e.key, dupPath });
    }
    // kept_local / kept_remote: nothing to review
  }
  return out;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

export class ConflictReviewView extends ItemView {
  private t: TranslateFunc;
  private items: UnresolvedConflict[] = [];
  private hadItems = false;
  private refreshing = false;

  constructor(leaf: WorkspaceLeaf, t: TranslateFunc) {
    super(leaf);
    this.t = t;
  }

  getViewType(): string {
    return VIEW_TYPE_CONFLICT_REVIEW;
  }

  getDisplayText(): string {
    return this.t("conflict_view_title");
  }

  getIcon(): string {
    return "merge";
  }

  async onOpen(): Promise<void> {
    this.addAction("refresh-cw", this.t("conflict_view_refresh"), () => {
      void this.refresh().catch(console.error);
    });
    this.contentEl.empty();
    this.contentEl.addClass("rs-conflict-view");
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  /** Re-collect unresolved conflicts and re-render. Public: called by
   *  revealConflictLeaf on an already-open view. */
  async refresh(): Promise<void> {
    if (this.refreshing) {
      return;
    }
    this.refreshing = true;
    try {
      this.items = await collectUnresolvedConflicts(this.app.vault.adapter);
    } catch (e) {
      console.error("conflict review: refresh failed:", e);
    } finally {
      this.refreshing = false;
    }

    if (this.items.length > 0) {
      this.hadItems = true;
    }
    if (this.items.length === 0 && this.hadItems) {
      // Everything resolved -> the view has done its job: close it (design
      // rule: the sidebar only exists while conflicts are unresolved).
      for (const leaf of this.app.workspace.getLeavesOfType(
        VIEW_TYPE_CONFLICT_REVIEW
      )) {
        leaf.detach();
      }
      return;
    }
    this.render();
  }

  private render(): void {
    const t = this.t;
    const el = this.contentEl;
    el.empty();
    el.addClass("rs-conflict-view");

    if (this.items.length === 0) {
      const empty = el.createDiv({ cls: "rs-conflict-empty" });
      empty.createDiv({
        cls: "rs-conflict-empty-title",
        text: t("conflict_view_empty"),
      });
      empty.createDiv({
        cls: "rs-conflict-empty-desc",
        text: t("conflict_view_empty_desc"),
      });
      return;
    }

    el.createDiv({
      cls: "rs-conflict-summary",
      text: t("conflict_view_summary", { count: `${this.items.length}` }),
    });

    this.items.forEach((item, idx) => {
      this.renderItem(el, item, idx);
    });
  }

  private renderItem(
    parent: HTMLElement,
    item: UnresolvedConflict,
    idx: number
  ): void {
    const card = parent.createDiv({ cls: "rs-conflict-item" });
    // staggered entrance via CSS nth-child rules (see styles.css); the index
    // class caps at 8 so long lists stop delaying after the first screenful
    card.addClass(`rs-conflict-item-anim-${Math.min(idx + 1, 8)}`);

    const header = card.createDiv({ cls: "rs-conflict-item-header" });
    const pathEl = header.createSpan({
      cls: "rs-conflict-path",
      text: item.key,
    });
    pathEl.setAttribute("title", item.key);
    pathEl.addEventListener("click", () => {
      void this.openPath(item.key);
    });

    const body = card.createDiv({ cls: "rs-conflict-body" });
    if (item.kind === "merged") {
      this.renderMergedBody(body, item);
    } else {
      this.renderDuplicatedBody(body, item);
    }
  }

  private renderMergedBody(
    body: HTMLElement,
    item: Extract<UnresolvedConflict, { kind: "merged" }>
  ): void {
    const t = this.t;
    body.createDiv({
      cls: "rs-conflict-hint",
      text: t("conflict_view_merged_hint"),
    });

    if (item.blocks.length === 0) {
      // markers exist but no complete block could be parsed (partial edit)
      body.createDiv({
        cls: "rs-conflict-hint rs-conflict-hint-warn",
        text: t("conflict_view_markers_unparsed"),
      });
      return;
    }

    item.blocks.forEach((block, bi) => {
      if (item.blocks.length > 1) {
        body.createDiv({
          cls: "rs-conflict-block-label",
          text: t("conflict_view_block_label", { n: `${bi + 1}` }),
        });
      }
      const grid = body.createDiv({ cls: "rs-conflict-diff" });

      const colLocal = grid.createDiv({
        cls: "rs-conflict-diff-col rs-conflict-diff-col-local",
      });
      const headLocal = colLocal.createDiv({
        cls: "rs-conflict-diff-head",
      });
      headLocal.createSpan({ text: t("conflict_view_side_local") });
      // compact per-column apply button: file-level action (rewrites every
      // block in the file with this side), placed inline with the column
      // title so the choice sits right next to the content it keeps
      const applyBtnLocal = new ButtonComponent(headLocal)
        .setClass("mod-small")
        .setIcon("check")
        .setTooltip(t("conflict_view_apply_local"))
        .onClick(() => {
          void this.applyBlockSide(item, bi, "local");
        });
      applyBtnLocal.buttonEl.classList.add(
        "rs-conflict-apply-mini",
        "rs-conflict-apply-local"
      );
      const preLocal = colLocal.createEl("pre", {
        cls: "rs-conflict-diff-pre",
      });

      const colRemote = grid.createDiv({
        cls: "rs-conflict-diff-col rs-conflict-diff-col-remote",
      });
      const headRemote = colRemote.createDiv({
        cls: "rs-conflict-diff-head",
      });
      headRemote.createSpan({ text: t("conflict_view_side_remote") });
      const applyBtnRemote = new ButtonComponent(headRemote)
        .setClass("mod-small")
        .setIcon("check")
        .setTooltip(t("conflict_view_apply_remote"))
        .onClick(() => {
          void this.applyBlockSide(item, bi, "remote");
        });
      applyBtnRemote.buttonEl.classList.add(
        "rs-conflict-apply-mini",
        "rs-conflict-apply-remote"
      );
      const preRemote = colRemote.createEl("pre", {
        cls: "rs-conflict-diff-pre",
      });

      // highlight the lines unique to each side (set membership is enough:
      // both sides of a conflict block are, by construction, the diverging
      // runs — common lines were already merged outside the markers)
      const remoteSet = new Set(block.remoteLines);
      const localSet = new Set(block.localLines);
      for (const line of block.localLines) {
        preLocal.createDiv({
          cls: remoteSet.has(line)
            ? "rs-conflict-line"
            : "rs-conflict-line rs-conflict-line-local-changed",
          text: line,
        });
      }
      for (const line of block.remoteLines) {
        preRemote.createDiv({
          cls: localSet.has(line)
            ? "rs-conflict-line"
            : "rs-conflict-line rs-conflict-line-remote-changed",
          text: line,
        });
      }
    });
  }

  private renderDuplicatedBody(
    body: HTMLElement,
    item: Extract<UnresolvedConflict, { kind: "duplicated" }>
  ): void {
    const t = this.t;
    body.createDiv({
      cls: "rs-conflict-hint",
      text: t("conflict_view_dup_hint"),
    });

    const rows = body.createDiv({ cls: "rs-conflict-dup-rows" });

    // local version -> the .dup copy
    const rowLocal = rows.createDiv({ cls: "rs-conflict-dup-row" });
    rowLocal.createSpan({
      cls: "rs-conflict-dup-label",
      text: t("conflict_view_dup_local_label"),
    });
    const dupPathEl = rowLocal.createSpan({
      cls: "rs-conflict-dup-path",
      text: item.dupPath,
    });
    dupPathEl.addEventListener("click", () => {
      void this.openPath(item.dupPath);
    });
    new ButtonComponent(rowLocal)
      .setClass("mod-small")
      .setButtonText(t("conflict_view_open"))
      .onClick(() => {
        void this.openPath(item.dupPath);
      });
    // compact per-row apply button: keeps this row's version (see
    // applyDupSide) — inline with the row it acts on
    const applyDupLocalBtn = new ButtonComponent(rowLocal)
      .setClass("mod-small")
      .setIcon("check")
      .setTooltip(t("conflict_view_apply_local"))
      .onClick(() => {
        void this.applyDupSide(item, "local");
      });
    applyDupLocalBtn.buttonEl.classList.add(
      "rs-conflict-apply-mini",
      "rs-conflict-apply-local"
    );

    // remote version -> the original name
    const rowRemote = rows.createDiv({ cls: "rs-conflict-dup-row" });
    rowRemote.createSpan({
      cls: "rs-conflict-dup-label",
      text: t("conflict_view_dup_remote_label"),
    });
    const origPathEl = rowRemote.createSpan({
      cls: "rs-conflict-dup-path",
      text: item.key,
    });
    origPathEl.addEventListener("click", () => {
      void this.openPath(item.key);
    });
    new ButtonComponent(rowRemote)
      .setClass("mod-small")
      .setButtonText(t("conflict_view_open"))
      .onClick(() => {
        void this.openPath(item.key);
      });
    const applyDupRemoteBtn = new ButtonComponent(rowRemote)
      .setClass("mod-small")
      .setIcon("check")
      .setTooltip(t("conflict_view_apply_remote"))
      .onClick(() => {
        void this.applyDupSide(item, "remote");
      });
    applyDupRemoteBtn.buttonEl.classList.add(
      "rs-conflict-apply-mini",
      "rs-conflict-apply-remote"
    );
  }

  /**
   * Merged card: resolve a SINGLE conflict block (blockIndex) by keeping
   * only the chosen side and dropping its markers; every other block is
   * left untouched so the user can resolve conflicts one at a time. Goes
   * through vault.read/modify when the file is known to the vault (picks up
   * saved editor content, updates open editors and the vault cache), with
   * adapter.read/write as the fallback.
   */
  private async applyBlockSide(
    item: Extract<UnresolvedConflict, { kind: "merged" }>,
    blockIndex: number,
    side: "local" | "remote"
  ): Promise<void> {
    const t = this.t;
    try {
      const f = this.app.vault.getAbstractFileByPath(item.key);
      let applied: string | undefined = undefined;
      if (f instanceof TFile) {
        applied = applyBlockToText(
          await this.app.vault.read(f),
          blockIndex,
          side
        );
        if (applied === undefined) {
          new Notice(t("conflict_view_apply_failed_unparsed"));
          return;
        }
        await this.app.vault.modify(f, applied);
      } else {
        const adapter = this.app.vault.adapter;
        if (!(await adapter.exists(item.key))) {
          new Notice(t("conflict_view_file_missing", { path: item.key }));
          return;
        }
        applied = applyBlockToText(
          await adapter.read(item.key),
          blockIndex,
          side
        );
        if (applied === undefined) {
          new Notice(t("conflict_view_apply_failed_unparsed"));
          return;
        }
        await adapter.write(item.key, applied);
      }
      new Notice(
        side === "local"
          ? t("conflict_view_applied_local")
          : t("conflict_view_applied_remote")
      );
      await this.refresh();
    } catch (e) {
      console.error("conflict review: apply side failed:", e);
      new Notice(t("conflict_view_apply_failed"));
    }
  }

  /**
   * Duplicated card: "local" overwrites the original name with the .dup
   * copy's bytes (binary-safe, mirroring fsLocal.writeFile's adapter
   * writeBinary) then trashes the copy; "remote" keeps the original name
   * as-is and just trashes the copy. Both end with the .dup gone, so the
   * item resolves on refresh.
   */
  private async applyDupSide(
    item: Extract<UnresolvedConflict, { kind: "duplicated" }>,
    side: "local" | "remote"
  ): Promise<void> {
    const t = this.t;
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(item.dupPath))) {
        new Notice(t("conflict_view_file_missing", { path: item.dupPath }));
        await this.refresh();
        return;
      }
      if (side === "remote") {
        // refusing to trash the copy when the original is gone would
        // otherwise silently lose BOTH versions
        if (!(await adapter.exists(item.key))) {
          new Notice(t("conflict_view_apply_failed_original_missing"));
          return;
        }
        await this.trashPath(item.dupPath);
        new Notice(t("conflict_view_dup_applied_remote"));
      } else {
        const data = await adapter.readBinary(item.dupPath);
        await adapter.writeBinary(item.key, data);
        await this.trashPath(item.dupPath);
        new Notice(t("conflict_view_dup_applied_local"));
      }
      await this.refresh();
    } catch (e) {
      console.error("conflict review: apply side failed:", e);
      new Notice(t("conflict_view_apply_failed"));
    }
  }

  /** Delete to Obsidian's local trash (recoverable, same as fsLocal.rm's
   *  "obsidian" mode); fall back to a hard remove if trashing fails. */
  private async trashPath(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      await adapter.trashLocal(path);
    } catch {
      await adapter.remove(path);
    }
  }

  private async openPath(path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(f);
    } else {
      new Notice(this.t("conflict_view_file_missing", { path }));
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-reveal helper
// ---------------------------------------------------------------------------

/**
 * Open (or focus + refresh) the conflict review leaf in the left sidebar.
 * Called after a sync that produced conflicts, and by the manual command.
 * No ribbon icon is registered — this view only surfaces when needed.
 */
export async function revealConflictLeaf(app: App): Promise<void> {
  const workspace = app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE_CONFLICT_REVIEW);
  let leaf: WorkspaceLeaf;
  if (existing.length > 0) {
    leaf = existing[0];
  } else {
    // getLeftLeaf can return null in rare workspace states; fall back to a
    // fresh main-area leaf so the conflicts are never silently dropped.
    leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(true);
    await leaf.setViewState({
      type: VIEW_TYPE_CONFLICT_REVIEW,
      active: true,
    });
  }
  await workspace.revealLeaf(leaf);
  // an already-open view doesn't re-run onOpen: refresh it explicitly
  if (existing.length > 0 && leaf.view instanceof ConflictReviewView) {
    await leaf.view.refresh();
  }
}
