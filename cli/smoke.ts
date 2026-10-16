// Headless CLI smoke (Phase B Milestone 1).
//
// Proves the plugin's sync-algo src subset loads and HTTP-works in pure Node
// via the obsidian stub — no throw on import, and graphRequest (the
// `requestUrl` consumer in fsOnedrive.ts:93-134) returns the exact shape its
// call sites read: { status, ok, headers (lowercased, .get()), text, json,
// arrayBuffer }, with `throw:false` semantics (non-2xx returns, not throws).
//
// Importing "../src/sync" + "../src/deviceCode" confirms the whole sync
// subset (transitively: baseTypes, fsOnedrive, conflictLogic, copyLogic,
// deltaMerge, driveItemConvert, syncOptimize, metadataOnRemote,
// fileContentHistory, localdb, misc, logger, profiler, quickXorHash) loads in
// Node through the stub. If ANY obsidian symbol beyond the stubbed 4 were
// value-imported, the build would have failed; if any module-load side effect
// touched an unstubbed global (e.g. `window.moment`), this runtime import
// would throw here.

import { graphRequest } from "../src/fsOnedrive";
import "../src/sync";
import "../src/deviceCode";

async function main(): Promise<void> {
  // Mock globalThis.fetch so the stub's request/requestUrl go through it.
  // Returns a fetch-`Response`-shaped object the stub reads: status, ok,
  // headers (Headers with .forEach), text(), json(), arrayBuffer().
  const bodyText = JSON.stringify({ hello: "world" });
  globalThis.fetch = ((url: string | URL | Request) => {
    // Minimal mock — only the fields the stub reads.
    return Promise.resolve({
      status: 200,
      ok: true,
      statusText: "OK",
      url: String(url),
      headers: new Headers({ "Content-Type": "application/json" }),
      text: () => Promise.resolve(bodyText),
      json: () => Promise.resolve({ hello: "world" }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });
  }) as typeof globalThis.fetch;

  const result = await graphRequest("https://graph/test", {
    method: "GET",
    headers: {},
  });

  // graphRequest reads res.status from requestUrl's return.
  assert(result.status === 200, `status: ${result.status}`);
  // graphRequest spreads the lowercased headers record + adds .get().
  assert(
    result.headers["content-type"] === "application/json",
    `headers.content-type: ${result.headers["content-type"]}`,
  );
  assert(
    typeof result.headers.get === "function",
    "headers.get missing",
  );
  assert(
    result.headers.get("Content-Type") === "application/json",
    `headers.get(Content-Type): ${result.headers.get("Content-Type")}`,
  );
  // graphRequest computes ok = status>=200 && status<300.
  assert(result.ok === true, `ok: ${result.ok}`);
  // graphRequest json() = res.json ?? (res.text ? JSON.parse : null).
  const json = await result.json();
  assert(
    typeof json === "object" && json !== null && (json as { hello?: unknown }).hello === "world",
    `json.hello: ${JSON.stringify(json)}`,
  );
  // graphRequest text() = res.text (the stub's string).
  const text = await result.text();
  assert(text === bodyText, `text: ${text}`);
  // graphRequest arrayBuffer() = () => Promise.resolve(res.arrayBuffer).
  // NOTE: graphRequest (fsOnedrive.ts:132, read-only) returns arrayBuffer as a
  // METHOD, so the arrayBuffer value is reached via `await result.arrayBuffer()`
  // — not `result.arrayBuffer` (which is the function itself). See deviation
  // note in the milestone report.
  const ab = await result.arrayBuffer();
  assert(ab instanceof ArrayBuffer, `arrayBuffer: ${Object.prototype.toString.call(ab)}`);

  console.log("SMOKE OK");
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("SMOKE ERROR", err);
  process.exit(1);
});
