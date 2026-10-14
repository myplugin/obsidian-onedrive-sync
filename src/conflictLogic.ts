// License: PolyForm Strict 1.0.0 (source-available). See LICENSE.pro.

import isEqual from "lodash/isEqual";
// import {
//   makePatches,
//   applyPatches,
//   stringifyPatches,
//   parsePatch,
// } from "@sanity/diff-match-patch";
import { type ILCSResult, LCS, mergeDigIn } from "node-diff3";
import type { Entity } from "./baseTypes";
import { copyFile } from "./copyLogic";
import type { FakeFs } from "./fsAll";
const MERGABLE_SIZE = 1000 * 1000; // 1 MB

export function isMergable(a: Entity, b?: Entity) {
  if (b !== undefined && a.key !== b.key) {
    return false;
  }

  return (
    !a.key!.endsWith("/") &&
    a.sizeRaw <= MERGABLE_SIZE &&
    (a.key!.endsWith(".md") || a.key!.endsWith(".markdown"))
  );
}

/**
 * slightly modify to adjust in markdown context
 * @param a
 * @param o
 * @param b
 */
function mergeDigInModified(a: string, o: string, b: string) {
  const { conflict, result } = mergeDigIn(a, o, b, {
    stringSeparator: /\n/,
  });
  for (let index = 0; index < result.length; ++index) {
    if (["<<<<<<<", "=======", ">>>>>>>"].includes(result[index])) {
      result[index] = "`" + result[index] + "`";
    }
  }
  return {
    conflict,
    result,
  };
}

function getLCSText(a: string, b: string) {
  const aa = a.split("\n");
  const bb = b.split("\n");
  let raw: ILCSResult | null = LCS(aa, bb);

  const k: string[] = [];

  while (raw !== null && raw !== undefined && raw.buffer1index !== -1) {
    k.unshift(aa[raw.buffer1index]);
    raw = raw.chain;
  }

  return k.join("\n");
}

/**
 * It's tricky. We find LCS then pretend it's the original text
 * @param a
 * @param b
 * @returns
 */
export function twoWayMerge(a: string, b: string): string {
  const aa = a.trim();
  const bb = b.trim();
  if (aa === "" && bb === "") {
    return aa.length >= bb.length ? a : b;
  }
  if (bb === "") {
    return a;
  }
  if (aa === "") {
    return b;
  }

  // const c = getLCSText(a, b);
  // const patches = makePatches(c, a);
  // const [d] = applyPatches(patches, b);
  const c = getLCSText(a, b); //.trim();
  // console.debug(`(start) LCS Text:`);
  // console.debug(c);
  // console.debug(`(end) LCS Text.`);
  const d = mergeDigInModified(a, c, b).result.join("\n");
  return d;
}

/**
 * Originally three way merge.
 * @param a
 * @param b
 * @param orig
 * @returns
 */
export function threeWayMerge(a: string, b: string, orig: string) {
  return mergeDigInModified(a, orig, b).result.join("\n");
}

/**
 * The pure content-computation part of mergeFile: read both sides, then
 * two-way / three-way merge them in memory. Extracted so the dirty-buffer
 * guard (see writeDupCopyForDirtyOpen and its callers in sync.ts) can put
 * the SAME merged content into a .dup conflict copy without mergeFile
 * writing anything to the local file or the remote.
 */
export async function computeMergedContent(
  key: string,
  left: FakeFs,
  right: FakeFs,
  contentOrig: ArrayBuffer | null | undefined
): Promise<ArrayBuffer> {
  const [contentLeft, contentRight] = await Promise.all([
    left.readFile(key),
    right.readFile(key),
  ]);

  let newArrayBuffer: ArrayBuffer | undefined = undefined;
  const decoder = new TextDecoder("utf-8");

  if (isEqual(contentLeft, contentRight)) {
    // we are lucky enough
    newArrayBuffer = contentLeft;
    // TODO: save the write
  } else {
    if (contentOrig === null || contentOrig === undefined) {
      const newText = twoWayMerge(
        decoder.decode(contentLeft),
        decoder.decode(contentRight)
      );
      // no need to worry about the offset here because the array is new and not sliced
      newArrayBuffer = new TextEncoder().encode(newText).buffer;
    } else {
      const newText = threeWayMerge(
        decoder.decode(contentLeft),
        decoder.decode(contentRight),
        decoder.decode(contentOrig)
      );
      newArrayBuffer = new TextEncoder().encode(newText).buffer;
    }
  }

  return newArrayBuffer;
}

export async function mergeFile(
  key: string,
  left: FakeFs,
  right: FakeFs,
  contentOrig: ArrayBuffer | null | undefined
) {
  // console.debug(
  //   `mergeFile: key=${key}, left=${left.kind}, right=${right.kind}`
  // );
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in mergeFile`);
  }

  if (!key.endsWith(".md") && !key.endsWith(".markdown")) {
    throw Error(`currently only support markdown files in mergeFile`);
  }

  const newArrayBuffer = await computeMergedContent(
    key,
    left,
    right,
    contentOrig
  );

  const mtime = Date.now();

  // left (local) must wait for the right
  // because the mtime might be different after upload
  // upload firstly
  const rightEntity = await right.writeFile(key, newArrayBuffer, mtime, mtime);
  // write local secondly
  await left.writeFile(
    key,
    newArrayBuffer,
    rightEntity.mtimeCli ?? mtime,
    rightEntity.ctimeCli ?? rightEntity.mtimeCli ?? mtime
  );

  return {
    entity: rightEntity,
    content: newArrayBuffer,
  };
}

export function getFileRenameForDup(key: string) {
  if (
    key === "" ||
    key === "." ||
    key === ".." ||
    key === "/" ||
    key.endsWith("/")
  ) {
    throw Error(`we cannot rename key=${key}`);
  }

  const segsPath = key.split("/");
  const name = segsPath[segsPath.length - 1];
  const segsName = name.split(".");

  if (segsName.length === 0) {
    throw Error(`we cannot rename key=${key}`);
  } else if (segsName.length === 1) {
    // name = "kkk" without any dot
    segsPath[segsPath.length - 1] = `${name}.dup`;
  } else if (segsName.length === 2) {
    if (segsName[0] === "") {
      // name = ".kkkk" with leading dot
      segsPath[segsPath.length - 1] = `${name}.dup`;
    } else if (segsName[1] === "") {
      // name = "kkkk." with tailing dot
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup`;
    } else {
      // name = "aaa.bbb" normally
      segsPath[segsPath.length - 1] = `${segsName[0]}.dup.${segsName[1]}`;
    }
  } else {
    // name = "[...].bbb.ccc"
    const firstPart = segsName.slice(0, segsName.length - 1).join(".");
    const thirdPart = segsName[segsName.length - 1];
    segsPath[segsPath.length - 1] = `${firstPart}.dup.${thirdPart}`;
  }
  const res = segsPath.join("/");
  return res;
}

function arraysAreEqual(arr1: ArrayBuffer, arr2: ArrayBuffer) {
  if (arr1.byteLength !== arr2.byteLength) {
    return false;
  }
  const u1 = new Uint8Array(arr1);
  const u2 = new Uint8Array(arr2);

  for (let i = 0; i < u1.byteLength; ++i) {
    if (u1[i] !== u2[i]) {
      return false;
    }
  }

  return true;
}

/**
 * 1. download remote
 * 2. compare
 * 3. if the same, update local but not upload
 * 4. if not the same, rename local and save remote
 */
async function tryDuplicateFileForSameSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<void>,
  downloadCallback: (entity: Entity | undefined) => Promise<void>
) {
  console.debug(`tryDuplicateFileForSameSizes: ${key}`);

  // 1. download
  const remoteContent = await fsRemote.readFile(key);

  // 2. compare
  const localContent = await fsLocal.readFile(key);
  const eq = arraysAreEqual(localContent, remoteContent);

  if (eq) {
    // 3. if the same, update local but not upload
    // read meta of remote, as if we have downloaded the file
    console.debug(`tryDuplicateFileForSameSizes: ${key} content equal`);
    const entityRemote = await fsRemote.stat(key);

    // write
    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);

    // no uploadCallback here
  } else {
    // 4. if not the same, rename local and save remote
    console.debug(`tryDuplicateFileForSameSizes: ${key} content not equal`);

    await fsLocal.rename(key, key2);

    const entityRemote = await fsRemote.stat(key);
    const downloadResultEntity = await fsLocal.writeFile(
      key,
      remoteContent,
      entityRemote.mtimeCli ?? Date.now(),
      entityRemote.mtimeCli ?? Date.now()
    );
    await downloadCallback(downloadResultEntity);

    const entityLocal = await fsLocal.stat(key2); // key2 here!
    const uploadResultEntity = await fsRemote.writeFile(
      key2, // key2 here!
      localContent,
      entityLocal.mtimeCli ?? Date.now(),
      entityLocal.mtimeCli ?? Date.now()
    );
    await uploadCallback(uploadResultEntity);
  }
}

/**
 * local: x.md -> x.dup.md -> upload to remote
 * remote: x.md -> download to local -> using original name x.md
 */
async function tryDuplicateFileForDiffSizes(
  key: string,
  key2: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<void>,
  downloadCallback: (entity: Entity | undefined) => Promise<void>
) {
  console.debug(`tryDuplicateFileForDiffSizes: ${key}`);

  await fsLocal.rename(key, key2);

  /**
   * x.dup.md -> upload to remote
   */
  async function f1() {
    const k = await copyFile(key2, fsLocal, fsRemote);
    await uploadCallback(k.entity);
    return k.entity;
  }

  /**
   * x.md -> download to local
   */
  async function f2() {
    const k = await copyFile(key, fsRemote, fsLocal);
    await downloadCallback(k.entity);
    return k.entity;
  }

  const [resUpload, resDownload] = await Promise.all([f1(), f2()]);

  return {
    upload: resUpload,
    download: resDownload,
  };
}

/**
 * Find the first unused ".dup" name of key: tries key.dup.ext, then
 * key.dup.dup.ext, ... until stat reports the candidate doesn't exist.
 */
async function findUsableDupKey(key: string, fsLocal: FakeFs) {
  let key2 = getFileRenameForDup(key);
  let usable = false;
  do {
    try {
      const s = await fsLocal.stat(key2);
      if (s === null || s === undefined) {
        throw Error(`not exist $${key2}`);
      }
      console.debug(`key2=${key2} exists, cannot use for new file`);
      key2 = getFileRenameForDup(key2);
      console.debug(`key2=${key2} is prepared for next try`);
    } catch {
      // not exists, exactly what we want
      console.debug(`key2=${key2} doesn't exist, usable for new file`);
      usable = true;
    }
  } while (!usable);
  return key2;
}

export async function tryDuplicateFile(
  key: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  uploadCallback: (entity: Entity | undefined) => Promise<void>,
  downloadCallback: (entity: Entity | undefined) => Promise<void>
) {
  const key2 = await findUsableDupKey(key, fsLocal);

  const localSize = await fsLocal.stat(key);
  const remoteSize = await fsRemote.stat(key);

  if (
    localSize !== undefined &&
    remoteSize !== undefined &&
    localSize.sizeRaw === remoteSize.sizeRaw
  ) {
    return await tryDuplicateFileForSameSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  } else {
    return await tryDuplicateFileForDiffSizes(
      key,
      key2,
      fsLocal,
      fsRemote,
      uploadCallback,
      downloadCallback
    );
  }
}

// Tolerance for the cross-run "is the existing dup copy still fresh"
// comparison below: absorbs filesystem mtime rounding and small clock
// differences between the local device and the remote server.
const DUP_MTIME_TOLERANCE_MS = 2000;

/**
 * Dirty-buffer guard helper.
 *
 * Writes the remote content of `key` (or an explicitly provided content,
 * e.g. a precomputed merge result) to a free ".dup" copy, INSTEAD of
 * overwriting the local file `key` which is open in an editor with unsaved
 * changes. The local file `key` is never touched here.
 *
 * Anti-loop across sync runs: walks the existing dup chain of `key`
 * (x.dup.md, x.dup.dup.md, ...). If a dup copy already exists and is at
 * least as new as the remote mtime (within DUP_MTIME_TOLERANCE_MS), nothing
 * is written, so repeated syncs while the file stays dirty-open don't keep
 * producing new copies. If the remote genuinely changed since the newest
 * dup copy, a fresh copy is written under the next free chain name.
 *
 * The dup copy is written with the REMOTE mtime as its own mtime, which
 * makes the freshness comparison immune to cross-device clock skew.
 *
 * Deliberately creates NO prev-sync record and uploads nothing: callers
 * skip the "mark synced" bookkeeping for `key` so a later run retries the
 * operation once the editor buffer is saved. The dup copy itself will be
 * synced upwards as a normal local-created file in a later run (the same
 * net effect tryDuplicateFile achieves immediately, one run delayed).
 */
export async function writeDupCopyForDirtyOpen(
  key: string,
  fsLocal: FakeFs,
  fsRemote: FakeFs,
  opts?: { content?: ArrayBuffer; remoteMtime?: number }
): Promise<{ written: boolean; dupKey?: string; entity?: Entity }> {
  if (key.endsWith("/")) {
    throw Error(`should not call ${key} in writeDupCopyForDirtyOpen`);
  }

  let remoteMtime = opts?.remoteMtime;
  if (remoteMtime === undefined) {
    try {
      const s = await fsRemote.stat(key);
      remoteMtime = s?.mtimeCli ?? s?.mtimeSvr;
    } catch {
      remoteMtime = undefined;
    }
  }

  // walk the dup chain: remember the newest existing dup mtime, and stop
  // at the first free name (which becomes the write target if needed)
  let newestDupMtime: number | undefined = undefined;
  let dupKey = getFileRenameForDup(key);
  for (;;) {
    let s: Entity | undefined = undefined;
    try {
      const t = await fsLocal.stat(dupKey);
      if (t !== null && t !== undefined) {
        s = t;
      }
    } catch {
      // not exists: end of the chain, dupKey is free
    }
    if (s === undefined) {
      break;
    }
    const m = s.mtimeCli ?? s.mtimeSvr;
    if (m !== undefined) {
      if (newestDupMtime === undefined || m > newestDupMtime) {
        newestDupMtime = m;
      }
    }
    dupKey = getFileRenameForDup(dupKey);
  }

  if (
    newestDupMtime !== undefined &&
    (remoteMtime === undefined ||
      newestDupMtime >= remoteMtime - DUP_MTIME_TOLERANCE_MS)
  ) {
    console.debug(
      `writeDupCopyForDirtyOpen: an up-to-date dup copy of ${key} already exists, skip rewriting`
    );
    return { written: false };
  }

  const content = opts?.content ?? (await fsRemote.readFile(key));
  const mtime = remoteMtime ?? Date.now();
  const entity = await fsLocal.writeFile(dupKey, content, mtime, mtime);
  console.debug(
    `writeDupCopyForDirtyOpen: ${key} is dirty-open, wrote its remote content to ${dupKey} instead`
  );
  return { written: true, dupKey: dupKey, entity: entity };
}
