// License: Apache-2.0 (see src/LICENSE)

import type { DriveItem } from "@microsoft/microsoft-graph-types";
import type { Entity } from "./baseTypes";

/**
 * Detect whether a Graph driveItem is the vault's remote root folder — the
 * `remoteBaseDir` folder that sits directly under the approot special folder.
 *
 * ## Why this exists
 *
 * Microsoft Graph OFFICIALLY OMITS `parentReference.path` from delta
 * responses, and special folders (approot) never carry a navigable
 * `/drive/root:/...` path anyway. So when an item's parent IS approot (no
 * path), the only such item that can appear in the approot-rooted delta
 * `/drive/special/approot:/{remoteBaseDir}:/delta` is the `remoteBaseDir`
 * folder itself — i.e. the vault root. Recognizing it lets the converter map
 * it to `key: "/"` (which callers drop via `entity.key !== "/"`) instead of
 * throwing `"x.parentReference.path is undefined or null"`, which otherwise
 * surfaces as a noisy "skipping added/modified item (parse failed)" warning
 * on every sync that touches a root-level entry.
 *
 * Ref: https://learn.microsoft.com/en-us/graph/api/driveitem-delta
 * ("parentReference won't include a value for path … track items by id")
 *
 * @param item          Raw Graph driveItem (shape is loose; typed `any`
 *                      to match the rest of this converter seam).
 * @param remoteBaseDir The vault's remote base directory name.
 * @returns true when the item is the approot root folder (no parent path,
 *          name === remoteBaseDir, and it carries a `folder` facet).
 */
export function isApprootRootDriveItem(
  item: any,
  remoteBaseDir: string
): boolean {
  if (item == null || remoteBaseDir === "") {
    return false;
  }
  const parentReference = item.parentReference;
  // Has a navigable path → not the special-folder-root case we handle here.
  if (parentReference != null && parentReference.path != null) {
    return false;
  }
  // The root folder is named remoteBaseDir and is a folder (not a file that
  // happens to share the name).
  if (item.name !== remoteBaseDir) {
    return false;
  }
  if (!("folder" in item)) {
    return false;
  }
  return true;
}

const constructFromDriveItemToEntityError = (x: DriveItem) => {
  return `parentPath="${
    x.parentReference?.path ?? "(no parentReference or path)"
  }", selfName="${x.name}"`;
};

/**
 * Extract path-independent metadata from a Graph DriveItem. PURE.
 * Throws ONLY on missing lastModifiedDateTime when requireMtime=true.
 * Does NOT throw on missing parentReference.path (that's deriveKeyFromPath's
 * job) and does NOT check remoteItem/package (the caller does, to preserve
 * the historical throw order).
 */
export const extractDriveItemMetadata = (x: DriveItem, requireMtime = true) => {
  const isFolder = "folder" in x;
  const mtimeTry = x?.fileSystemInfo?.lastModifiedDateTime;
  if (requireMtime && (mtimeTry === undefined || mtimeTry === null)) {
    throw Error(`onedrive cannot parse mtime: ${JSON.stringify(x, null, 2)}`);
  }
  let ctimeTry = x?.fileSystemInfo?.createdDateTime;
  if (ctimeTry === undefined || ctimeTry === null) {
    ctimeTry = mtimeTry;
  }
  const mtimeSvr = mtimeTry ? Date.parse(mtimeTry) : undefined;
  return {
    mtimeSvr,
    mtimeCli: mtimeSvr,
    ctimeCli: ctimeTry ? Date.parse(ctimeTry) : mtimeSvr,
    size: isFolder ? 0 : x.size!,
    sizeRaw: isFolder ? 0 : x.size!,
    // Graph types eTag as NullableOption<string> (string | null); Entity.etag
    // is `string | undefined`, so coerce null -> undefined.
    etag: x.eTag ?? undefined,
    remoteId: (x as any).id,
    isFolder,
  };
};

/**
 * Build a recognizable error for "delta item is missing
 * parentReference.path" — the documented Graph delta shape ("track items
 * by id"). Carries a stable `.code = "ONEDRIVE_PATH_MISSING"` so the
 * id-fallback catch (fromDriveItemToEntityWithIdFallback) matches on
 * `.code` instead of a fragile message-string include — correcting the
 * historical "undefinded" typo in the message can no longer silently break
 * the fallback (re-throw instead of recovering). Mirrors
 * remoteEtagMismatchError / remoteNotFoundError in fsOnedrive.ts
 * (plain Error + `.code`).
 *
 * The message text is preserved verbatim so existing assert.throws regex
 * tests (/parentReference\.path is undefinded or null/) stay green.
 */
function pathMissingError(): Error {
  const err = new Error("x.parentReference.path is undefinded or null");
  (err as any).code = "ONEDRIVE_PATH_MISSING";
  return err;
}

/**
 * Derive the vault-relative key from parentReference.path + name. PURE.
 * Throws on missing parentReference.path (the approot root folder is
 * handled by the caller via isApprootRootDriveItem, NOT here). Returns the
 * key WITH a trailing slash when the item is a folder.
 *
 * The regex/prefix logic below is moved VERBATIM from the previous
 * fromDriveItemToEntity body; do not alter the matching branches.
 */
export const deriveKeyFromPath = (
  x: DriveItem,
  remoteBaseDir: string
): string => {
  if (
    x.parentReference === undefined ||
    x.parentReference === null ||
    x.parentReference.path === undefined ||
    x.parentReference.path === null
  ) {
    throw pathMissingError();
  }

  let key = "";

  // possible prefix:
  // pure english: /drive/root:/Apps/remotely-save/${remoteBaseDir}
  // or localized, e.g.: /drive/root:/应用/remotely-save/${remoteBaseDir}
  const FIRST_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/remotely-save\//g;

  // why?? /drive/root:/Apps/Graph
  const FIFTH_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/Graph\//g;

  // why again?? /drive/root:/Apps/Graph 1
  const SIXTH_COMMON_PREFIX_REGEX = /^\/drive\/root:\/[^\/]+\/Graph 1\//g;
  const SIXTH_COMMON_PREFIX_REGEX_V2 = /^\/drive\/root:\/[^\/]+\/Graph%201\//g;

  // or the root is absolute path /Livefolders,
  // e.g.: /Livefolders/应用/remotely-save/${remoteBaseDir}
  const SECOND_COMMON_PREFIX_REGEX = /^\/Livefolders\/[^\/]+\/remotely-save\//g;

  // another report, why???
  // /drive/root:/something/app/remotely-save/${remoteBaseDir}
  const THIRD_COMMON_PREFIX_REGEX =
    /^\/drive\/root:\/[^\/]+\/app\/remotely-save\//g;

  // another possibile prefix
  const FOURTH_COMMON_PREFIX_RAW = `/drive/items/`;

  // when to use decode?
  const remoteBaseDirEncoded = encodeURIComponent(remoteBaseDir);

  const fullPathOriginal = `${x.parentReference.path}/${x.name}`;
  const matchFirstPrefixRes = fullPathOriginal.match(FIRST_COMMON_PREFIX_REGEX);
  const matchFifthPrefixRes = fullPathOriginal.match(FIFTH_COMMON_PREFIX_REGEX);
  const matchSixthPrefixRes = fullPathOriginal.match(SIXTH_COMMON_PREFIX_REGEX);
  const matchSixthV2PrefixRes = fullPathOriginal.match(
    SIXTH_COMMON_PREFIX_REGEX_V2
  );

  const matchSecondPrefixRes = fullPathOriginal.match(
    SECOND_COMMON_PREFIX_REGEX
  );
  const matchThirdPrefixRes = fullPathOriginal.match(THIRD_COMMON_PREFIX_REGEX);

  // first
  if (
    matchFirstPrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchFirstPrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchFirstPrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchFirstPrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchFirstPrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchFirstPrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // fifth
  else if (
    matchFifthPrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchFifthPrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchFifthPrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchFifthPrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchFifthPrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchFifthPrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // sixth
  else if (
    matchSixthPrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchSixthPrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchSixthPrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchSixthPrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchSixthPrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchSixthPrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // sixth v2
  else if (
    matchSixthV2PrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchSixthV2PrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchSixthV2PrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchSixthV2PrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchSixthV2PrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchSixthV2PrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // second
  else if (
    matchSecondPrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchSecondPrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchSecondPrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchSecondPrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchSecondPrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchSecondPrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // third
  else if (
    matchThirdPrefixRes !== null &&
    fullPathOriginal.startsWith(`${matchThirdPrefixRes[0]}${remoteBaseDir}`)
  ) {
    const foundPrefix = `${matchThirdPrefixRes[0]}${remoteBaseDir}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  } else if (
    matchThirdPrefixRes !== null &&
    fullPathOriginal.startsWith(
      `${matchThirdPrefixRes[0]}${remoteBaseDirEncoded}`
    )
  ) {
    const foundPrefix = `${matchThirdPrefixRes[0]}${remoteBaseDirEncoded}`;
    key = fullPathOriginal.substring(foundPrefix.length + 1);
  }

  // fourth
  else if (x.parentReference.path.startsWith(FOURTH_COMMON_PREFIX_RAW)) {
    // it's something like
    // /drive/items/<some_id>!<another_id>:/${remoteBaseDir}/<subfolder>
    // with uri encoded!
    if (x.name === undefined || x.name === null) {
      throw Error(
        `OneDrive item no name variable while matching ${FOURTH_COMMON_PREFIX_RAW}`
      );
    }
    const parPath = decodeURIComponent(x.parentReference.path);
    key = parPath.substring(parPath.indexOf(":") + 1);
    if (key.startsWith(`/${remoteBaseDir}/`)) {
      key = key.substring(`/${remoteBaseDir}/`.length);
      key = `${key}/${x.name}`;
    } else if (key === `/${remoteBaseDir}`) {
      key = x.name;
    } else {
      throw Error(
        `file/folder with /drive/items/, no idea how to deal with it:
fullPathOriginal=${fullPathOriginal}
matchFirstPrefixRes=${matchFirstPrefixRes}
matchFifthPrefixRes=${matchFifthPrefixRes}
matchSixthPrefixRes=${matchSixthPrefixRes}
matchSixthV2PrefixRes=${matchSixthV2PrefixRes}
matchSecondPrefixRes=${matchSecondPrefixRes}
matchThirdPrefixRes=${matchThirdPrefixRes}
${constructFromDriveItemToEntityError(x)}`
      );
    }
  }

  // others
  else {
    throw Error(
      `file/folder, no idea how to deal with it without known prefix:
fullPathOriginal=${fullPathOriginal}
matchFirstPrefixRes=${matchFirstPrefixRes}
matchFifthPrefixRes=${matchFifthPrefixRes}
matchSixthPrefixRes=${matchSixthPrefixRes}
matchSixthV2PrefixRes=${matchSixthV2PrefixRes}
matchSecondPrefixRes=${matchSecondPrefixRes}
matchThirdPrefixRes=${matchThirdPrefixRes}
${constructFromDriveItemToEntityError(x)}`
    );
  }

  const isFolder = "folder" in x;
  if (isFolder) {
    key = `${key}/`;
  }
  return key;
};

/**
 * Convert a Graph DriveItem into the plugin's Entity. Behavior-preserving
 * refactor: now delegates to extractDriveItemMetadata + deriveKeyFromPath.
 * Throws on the same shapes as before, in the same order:
 *   1. approot root → early-return minimal entity (key "/")
 *   2. remoteItem / package / bundle → throw
 *   3. missing parentReference.path (non-root) → throw
 *   4. missing mtime (requireMtime=true) → throw
 * NEW: always sets remoteId from driveItem.id.
 *
 * This is a PURE function (no I/O, no side effects, no `obsidian`/`msal`
 * runtime imports) so it can be unit-tested directly against realistic delta
 * response shapes. Callers (`classifyDeltaItems`, the full-enumeration walk)
 * wrap this in try/catch so a throw degrades to a skip-with-warn rather than
 * crashing the sync.
 */
export const fromDriveItemToEntity = (
  x: DriveItem,
  remoteBaseDir: string,
  requireMtime = true
): Entity => {
  // 1. approot root → minimal entity (before metadata; root may lack mtime)
  if (isApprootRootDriveItem(x, remoteBaseDir)) {
    return {
      key: "/",
      keyRaw: "/",
      mtimeSvr: undefined,
      mtimeCli: undefined,
      ctimeCli: undefined,
      size: 0,
      sizeRaw: 0,
      synthesizedFile: false,
      remoteId: (x as any).id,
    };
  }
  // 2. remoteItem / package / bundle (before path, preserving order)
  // Shared items (remoteItem) belong to a different drive; their file/folder
  // facets are nested INSIDE remoteItem, not at top level. The approot-scoped
  // sync should never see them, but reject explicitly instead of misparsing
  // (which would yield size! = undefined and a garbage key).
  if ("remoteItem" in x) {
    throw Error(
      "driveItem carries remoteItem (shared item) — not supported in approot sync"
    );
  }
  // package/bundle items are neither files nor folders. The `"folder" in x`
  // check would misclassify them as files. Reject explicitly.
  if ("package" in x || "bundle" in x) {
    throw Error(
      "driveItem is a package/bundle — neither file nor folder, not supported in approot sync"
    );
  }
  // 3. path derivation (throws on path-missing, BEFORE mtime)
  const key = deriveKeyFromPath(x, remoteBaseDir);
  // 4. metadata (throws on missing mtime, AFTER path)
  const meta = extractDriveItemMetadata(x, requireMtime);
  return {
    key,
    keyRaw: key,
    mtimeSvr: meta.mtimeSvr,
    mtimeCli: meta.mtimeCli,
    ctimeCli: meta.ctimeCli,
    size: meta.size,
    sizeRaw: meta.sizeRaw,
    synthesizedFile: false,
    etag: meta.etag,
    remoteId: meta.remoteId,
  };
};

/**
 * Variant of fromDriveItemToEntity that falls back to an id→key lookup when
 * parentReference.path is missing (the documented delta shape —
 * https://learn.microsoft.com/en-us/graph/api/driveitem-delta: "track items
 * by id"). Covers the MODIFY case (item existed in the prev sync → its id is
 * in idToKeyMap → reuse the known keyRaw). New path-missing items (id not in
 * the map) re-throw → caller warns + skips + invalidates the deltaLink
 * (self-heal). The approot root folder bypasses the fallback (mapped to
 * key "/" as in fromDriveItemToEntity).
 */
export const fromDriveItemToEntityWithIdFallback = (
  x: DriveItem,
  remoteBaseDir: string,
  idToKeyMap?: Map<string, string>,
  requireMtime = true
): Entity => {
  // approot root → minimal entity (same as fromDriveItemToEntity)
  if (isApprootRootDriveItem(x, remoteBaseDir)) {
    return {
      key: "/",
      keyRaw: "/",
      mtimeSvr: undefined,
      mtimeCli: undefined,
      ctimeCli: undefined,
      size: 0,
      sizeRaw: 0,
      synthesizedFile: false,
      remoteId: (x as any).id,
    };
  }
  // remoteItem / package / bundle (same guards, same order)
  if ("remoteItem" in x) {
    throw Error(
      "driveItem carries remoteItem (shared item) — not supported in approot sync"
    );
  }
  if ("package" in x || "bundle" in x) {
    throw Error(
      "driveItem is a package/bundle — neither file nor folder, not supported in approot sync"
    );
  }
  // path derivation, with id-fallback on path-missing
  let key: string;
  try {
    key = deriveKeyFromPath(x, remoteBaseDir);
  } catch (e) {
    // path missing — try the id→key fallback (modify case)
    if (
      e instanceof Error &&
      (e as any).code === "ONEDRIVE_PATH_MISSING" &&
      idToKeyMap &&
      (x as any).id !== undefined &&
      idToKeyMap.has((x as any).id)
    ) {
      key = idToKeyMap.get((x as any).id)!;
    } else {
      throw e; // not a path-missing error, or id not in map → re-throw → self-heal
    }
  }
  const meta = extractDriveItemMetadata(x, requireMtime);
  return {
    key,
    keyRaw: key,
    mtimeSvr: meta.mtimeSvr,
    mtimeCli: meta.mtimeCli,
    ctimeCli: meta.ctimeCli,
    size: meta.size,
    sizeRaw: meta.sizeRaw,
    synthesizedFile: false,
    etag: meta.etag,
    remoteId: meta.remoteId,
  };
};
