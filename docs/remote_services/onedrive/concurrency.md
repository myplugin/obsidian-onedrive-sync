# OneDrive Concurrency Mechanisms

> Reference for how OneDrive / Microsoft Graph supports concurrent-write
> safety, and how this plugin uses each mechanism (current state after the
> If-Match concurrency-guard implementation). Distilled from the design spec
> (`docs/superpowers/specs/2026-09-20-onedrive-if-match-concurrency-guard-design.md`
> §4) plus the shipped code.

## etag / cTag (version numbers)

- **`eTag`**: a version identifier OneDrive automatically maintains for every
  driveItem, e.g. `"012345819293.1"`. It is **opaque** — compare
  byte-for-byte, never parse or construct it.
  - `eTag` = "eTag for the **entire item (metadata + content)**" → changes
    when metadata **or** content changes.
  - `cTag` = "eTag for the **content** of the item" → changes only when
    content changes; **folders do not return cTag**.
- Source: <https://learn.microsoft.com/en-us/graph/api/resources/driveitem>
- Persistence: an intrinsic item property stored on OneDrive, returned with
  item metadata, and automatically rotated whenever the item changes.
- App Folder reliability: **verified** — this plugin's stat call
  (`src/fsOnedrive.ts`, `$select=cTag,eTag,...`) returns `eTag` for App
  Folder content. `appRoot` is just a special-folder alias for
  `/Apps/{AppName}`; the write endpoints are the ordinary driveItem
  endpoints, with no scope-level differences.

**How this plugin uses it:** `fromDriveItemToEntity` (`src/driveItemConvert.ts`)
maps `driveItem.eTag` onto the internal `Entity.etag` — for walk/delta
results, stat results, and write responses alike. The etag captured during the
sync walk is sent as the `If-Match` value on that round's writes; the etag
from a write response is persisted into the `prevSync` record so the NEXT
round's `If-Match` starts from a fresh value.

## If-Match / If-None-Match (optimistic concurrency preconditions)

- Sending `If-Match: <etag>` on an upload/modify makes OneDrive perform
  "check version + write" as **one atomic operation**: match → write and
  rotate to a new etag; mismatch → **HTTP `412 Precondition Failed`, nothing
  is written**. (`If-None-Match: *` is the inverse guard: "fail if it already
  exists".)
- **createUploadSession: explicitly documented** — `if-match` /
  `if-none-match` appear in the request-header table:
  <https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession>
- **PATCH (driveItem update): explicitly documented**:
  <https://learn.microsoft.com/en-us/graph/api/driveitem-update> (move as
  well:
  <https://github.com/microsoftgraph/microsoft-graph-docs-contrib/blob/main/api-reference/v1.0/api/driveitem-move.md>)
- **PUT `:/content`: documentation gap** — the request-header table at
  <https://learn.microsoft.com/en-us/graph/api/driveitem-put-content> lists
  only `Authorization` / `Content-Type`; `If-Match` is **not documented**
  there. It is the same underlying driveItem write operation and is expected
  to honor the precondition, but that is undocumented behavior — treat
  412-on-PUT as confirmed only by manual verification against the real
  service.

**How this plugin uses it** (all conversions produce the coded error
`remoteEtagMismatchError(key)` with `.code === "REMOTE_ETAG_MISMATCH"`, from
`src/fsOnedrive.ts`):

| Write path | If-Match sent? | 412 handling |
|---|---|---|
| small-file `PUT :/content` (`_putArrayBuffer`) | yes, whenever the walk produced an etag | `res.status === 412` → coded error |
| large-file `createUploadSession` (`_postJson` from `_writeFileFromRoot`) | yes, at session creation (documented support) | Obsidian `request()` surfaces 412 in the thrown error; classified via `classifyOneDriveWriteError` |
| large-file fragment PUTs (`_putUint8ArrayByRange`) | **no** — fragments go to the pre-authenticated session URL, which does not accept extra headers | defensive only: a 412 (session invalidated by a concurrent write) → same coded error |
| mtime `PATCH` after small-file PUT (`_patchJson`) | **no** (MVP choice) | conservative: any 412-class failure is converted (`classifyOneDriveWriteError`) — prefer a rare false-positive merge over a missed conflict; the proper fix (PATCH with the PUT response's fresh etag) is a possible follow-up |

The coded error propagates through `_retryOnTransientError` immediately
(rethrown — it is not 429/5xx). In `src/sync.ts`, the push branch of
`dispatchOperationToActualV3` catches `.code === "REMOTE_ETAG_MISMATCH"` and
re-routes the entry to the exact same path as a walk-time-detected conflict
(`handleConflictModifiedSmartConflict` → `mergeFile` for mergeable markdown,
`tryDuplicateFile` otherwise). Because 412 means OneDrive **atomically
rejected** the write (nothing written remotely, local untouched), the
re-route starts from a clean state on both sides. After the sync, `main.ts`
shows a Notice and appends one line per resolved conflict to
`<vault>/.remotely-save-onedrive-conflicts.log` (a per-device file, excluded
from sync by `checkIsSkipItemOrNotByName`).

## @microsoft.graph.conflictBehavior (NAME collision, not content version)

- `fail` / `replace` / `rename` decide what happens when an item with the
  same **name** already exists. This is **not** a content-version
  precondition.
- **Orthogonal to, and coexists with, `If-Match`**: createUploadSession
  Example 7 documents that `conflictBehavior` and `if-match` "can be used ...
  in the same call":
  <https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession>
- Semantics: `If-Match` is the version gate and takes precedence — on etag
  mismatch the service returns 412 and `replace` never runs.

**How this plugin uses it:** `conflictBehavior: "replace"` remains on all
write paths (unchanged); the If-Match gate sits in front of it. For files the
walk never saw (new uploads, no etag), no If-Match is sent and `replace`
behaves exactly as before.

## delta (change tracking)

- The `/delta` endpoint tracks **all** changes under the App Folder
  regardless of which client made them → device B's delta includes device A's
  uploads. The only question is **timing**: whether A's upload landed before
  B's delta query. That eventual-consistency window is exactly why delta
  alone cannot prevent lost updates, and why the If-Match guard exists.
- The `deltaLink` is **per-device** state (`src/localdb.ts` — deliberately
  kept out of `data.json`, which syncs across devices).
- The optimized delta `$select` (`src/syncOptimize.ts`) now **includes**
  `eTag` — added for the If-Match precondition (without it, delta-walked
  entities carry no etag and the guard stays inactive for files unchanged
  since the last sync). `cTag` is still dropped (absent for folders; eTag
  covers metadata + content). Transition note: a persisted deltaLink carries
  the `$select` it was created with, so links minted before this change keep
  omitting eTag until a fresh full enumeration mints a new link.

**How this plugin uses it:** delta powers the incremental remote walk; the
`If-Match` value comes from the walked entities' `etag` (Task 1 mapping), and
each write response refreshes it into `prevSync`.

## /versions (version history)

- Per-file version history with rollback:
  <https://learn.microsoft.com/en-us/graph/api/driveitem-list-versions>
- **Not used by this plugin** (heavier; limited support for personal App
  Folders). Kept as a fallback idea and as a manual recovery avenue for
  users via the OneDrive web UI.

## Production reference implementations

- PnP SDK, `packages/graph/files/resumableUpload.ts`: `createUploadSession`
  with both `If-Match` and `conflictBehavior`.
- `simstudioai/sim`, `apps/sim/lib/internal/microsoft-word/client.ts`:
  `replaceContentIfUnchanged(...)` sends `if-match`.
- `rocketride-org/rocketride-server`, `nodes/.../word/client.py`:
  `upload_docx` uses `If-Match` "so concurrent edits fail readably, not
  last-writer-wins".

## See also

- Repo lesson on re-auditing response contracts when call modes change:
  `docs/lessons/onedrive-delta-parentreference-path.md`
- Design spec (full decision log):
  `docs/superpowers/specs/2026-09-20-onedrive-if-match-concurrency-guard-design.md`
