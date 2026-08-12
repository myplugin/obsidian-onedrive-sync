// License: Apache-2.0. See LICENSE.

/** Result of checking whether a sync item should be ignored. */
export interface SkipCheckResult {
  finalIsIgnored: boolean;
}

// Decide whether a sync item should be ignored based on its key and the
// configured deny-list (ignorePaths) and allow-list (onlyAllowPaths).
//
// The three booleans carry other skip reasons (hidden file, folder,
// symlink); when false they do not contribute to the decision. The
// `obsidianFolder` string is the Obsidian config folder name (e.g.
// ".obsidian"); keys inside it are skipped.
//
// Backslashes in the key, and double-backslashes (\\) in regex patterns,
// are normalized to "/" so Windows and Unix paths match. Single-backslash
// regex escapes such as \.png$ are left untouched.
export function checkIsSkipItemOrNotByName(
  key: string,
  isHidden: boolean,
  isFolder: boolean,
  isSymlink: boolean,
  obsidianFolder: string,
  ignorePaths: string[],
  onlyAllowPaths: string[],
): SkipCheckResult {
  // Normalize backslashes in the key to forward slashes.
  const normalizedKey = key.replace(/\\/g, "/");

  // Replace double-backslashes (path-separator intent) with "/", but leave
  // single-backslash regex escapes (like "\.") intact.
  const normalizePattern = (p: string): string => p.replace(/\\\\/g, "/");

  // True if the normalized key matches any non-empty entry in `list`.
  const matchesList = (list: string[]): boolean => {
    for (const raw of list) {
      if (raw.trim() === "") {
        continue;
      }
      const pattern = normalizePattern(raw);
      if (new RegExp(pattern).test(normalizedKey)) {
        return true;
      }
    }
    return false;
  };

  // Deny-list: any match means the item is ignored.
  const isDenied = matchesList(ignorePaths);

  // Allow-list: if it has entries and the key matches none, the item is
  // not allowed and thus ignored. An empty allow-list allows everything.
  const allowHasEntries = onlyAllowPaths.some((s) => s.trim() !== "");
  const isAllowed = !allowHasEntries || matchesList(onlyAllowPaths);

  // Items inside the Obsidian config folder are always ignored.
  const inObsidianFolder =
    obsidianFolder !== "" &&
    (normalizedKey === obsidianFolder ||
      normalizedKey.startsWith(`${obsidianFolder}/`));

  // Other skip reasons passed in as booleans.
  const otherSkip = isHidden || isFolder || isSymlink;

  const finalIsIgnored =
    isDenied || !isAllowed || inObsidianFolder || otherSkip;

  return { finalIsIgnored };
}
