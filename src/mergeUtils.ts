// License: Apache-2.0. See LICENSE.

import { diff3Merge } from "node-diff3";

// Conflict markers wrapped in backticks, matching the project's
// smart-conflict output format.
const CONFLICT_START = "`<<<<<<<`";
const CONFLICT_BASE = "`=======`";
const CONFLICT_END = "`>>>>>>>`";

// Insert ".dup" before the last extension of the basename.
// Throws for degenerate keys ("", "/", ".", "..") and folders (trailing "/").
export function getFileRenameForDup(key: string): string {
  if (key === "" || key === "/" || key === "." || key === "..") {
    throw new Error(`getFileRenameForDup: invalid key: "${key}"`);
  }
  if (key.endsWith("/")) {
    throw new Error(`getFileRenameForDup: folder key: "${key}"`);
  }

  const lastSlash = key.lastIndexOf("/");
  const basename = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  const prefix = lastSlash === -1 ? "" : key.slice(0, lastSlash + 1);

  const lastDot = basename.lastIndexOf(".");
  let name: string;
  let ext: string;
  if (lastDot === -1 || lastDot === 0) {
    // No dot, or a dot-file like ".abc": no real extension.
    name = basename;
    ext = "";
  } else if (lastDot === basename.length - 1) {
    // Trailing dot, e.g. "hij.": strip it, no real extension.
    name = basename.slice(0, -1);
    ext = "";
  } else {
    name = basename.slice(0, lastDot);
    ext = basename.slice(lastDot);
  }

  return `${prefix}${name}.dup${ext}`;
}

// Line-based two-way merge with no common ancestor. Common prefix and
// suffix lines are kept; the differing middle run is wrapped in markers.
export function twoWayMerge(a: string, b: string): string {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  const min = Math.min(aLines.length, bLines.length);

  let prefix = 0;
  while (prefix < min && aLines[prefix] === bLines[prefix]) {
    prefix++;
  }

  const aLast = aLines.length - 1;
  const bLast = bLines.length - 1;
  let suffix = 0;
  while (
    suffix < min - prefix &&
    aLines[aLast - suffix] === bLines[bLast - suffix]
  ) {
    suffix++;
  }

  const commonPrefix = aLines.slice(0, prefix);
  const commonSuffix = aLines.slice(aLines.length - suffix);
  const aMiddle = aLines.slice(prefix, aLines.length - suffix);
  const bMiddle = bLines.slice(prefix, bLines.length - suffix);

  const parts: string[] = [];
  for (const line of commonPrefix) {
    parts.push(line);
  }
  if (aMiddle.length > 0 || bMiddle.length > 0) {
    parts.push(CONFLICT_START);
    for (const line of aMiddle) {
      parts.push(line);
    }
    parts.push(CONFLICT_BASE);
    for (const line of bMiddle) {
      parts.push(line);
    }
    parts.push(CONFLICT_END);
  }
  for (const line of commonSuffix) {
    parts.push(line);
  }

  return parts.join("\n");
}

// Three-way merge using `orig` as the common ancestor. Non-conflicting
// changes merge cleanly; true a/b conflicts are wrapped in markers.
// Note: argument order is (a, b, orig); node-diff3 expects (a, o, b).
export function threeWayMerge(a: string, b: string, orig: string): string {
  const regions = diff3Merge(a, orig, b, {
    stringSeparator: "\n",
    excludeFalseConflicts: true,
  });

  const parts: string[] = [];
  for (const region of regions) {
    if (region.ok !== undefined) {
      for (const line of region.ok) {
        parts.push(line);
      }
    } else if (region.conflict !== undefined) {
      parts.push(CONFLICT_START);
      for (const line of region.conflict.a) {
        parts.push(line);
      }
      parts.push(CONFLICT_BASE);
      for (const line of region.conflict.b) {
        parts.push(line);
      }
      parts.push(CONFLICT_END);
    }
  }

  return parts.join("\n");
}
