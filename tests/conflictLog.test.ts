// `_globalsSetup` kept first per repo test convention (src/conflictLog.ts is
// dependency-free so it is not strictly needed here, but the pattern stays
// uniform across test files).
import "./_globalsSetup";

import { strict as assert } from "assert";
import { describe, it } from "mocha";
import {
  CONFLICT_LOG_FILENAME,
  formatConflictLogLine,
} from "../src/conflictLog";

describe("conflict log line", () => {
  it("formats timestamp + key + disposition", () => {
    const line = formatConflictLogLine({
      ts: new Date("2026-09-20T12:00:00.000Z"),
      key: "vault/a.md",
      walkEtag: '"vP"',
      writeEtag: undefined, // 412: the write-time etag is unavailable
      disposition: "merged",
    });
    assert.match(line, /2026-09-20T12:00:00/);
    assert.match(line, /a\.md/);
    assert.match(line, /merged/);
    assert.match(line, /\n$/); // trailing newline
  });

  it('uses "?" for missing etags; result= only when resultFile is set', () => {
    const base = {
      ts: new Date("2026-09-20T12:00:00.000Z"),
      key: "b.bin",
      disposition: "duplicated" as const,
    };
    const noResult = formatConflictLogLine(base);
    assert.match(noResult, /walkEtag=\?/);
    assert.match(noResult, /writeEtag=\?/);
    assert.ok(!noResult.includes("result="));
    const withResult = formatConflictLogLine({
      ...base,
      resultFile: "b.dup.bin",
    });
    assert.match(withResult, /result=b\.dup\.bin/);
  });

  it("pins the vault-root log filename (also the sync-ignore entry)", () => {
    assert.strictEqual(
      CONFLICT_LOG_FILENAME,
      ".remotely-save-onedrive-conflicts.log"
    );
  });
});
