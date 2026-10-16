// Production `obsidian` runtime stub for the headless CLI (Phase B Milestone 1).
//
// The sync-algo src subset value-imports `obsidian` in EXACTLY two files
// (verified via grep — every other `import ... from "obsidian"` in src/ is
// `import type`, erased by esbuild):
//   - src/baseTypes.ts:6  -> Platform, requireApiVersion  (module-load: VALID_REQURL)
//   - src/fsOnedrive.ts:9 -> request, requestUrl          (HTTP transport)
//
// i18n/moment, syncAlgoV3Notice/Modal/sanitizeHTMLToDom, regexListSetting,
// settingsClearDupFiles, syncToggle are loaded ONLY by src/main.ts (which the
// CLI never imports) — so they are intentionally NOT stubbed here.
//
// The 4 symbols below match the EXACT consumption in those two files:
//   - Platform: baseTypes.ts:356 reads `Platform.isAndroidApp` only; all three
//     fields are provided for safety.
//   - requireApiVersion: baseTypes.ts:356 calls `requireApiVersion(API_VER_*)`;
//     CLI is always "new enough" → returns true so VALID_REQURL resolves true.
//   - request: fsOnedrive.ts sendAuthReq/sendRefreshTokenReq (lines 477, 517)
//     do `JSON.parse(rsp1)` on the return → must return the body TEXT (string).
//   - requestUrl: fsOnedrive.ts graphRequest (lines 110-133) reads res.status,
//     res.headers (lowercased flat record — it does lower[name.toLowerCase()]),
//     res.text (string), res.json (unknown|undefined), res.arrayBuffer.
//     graphRequest passes `throw:false`; non-2xx must RETURN (not throw) so the
//     call sites' 404/412/429 status branches are preserved.

export const Platform = {
  isDesktopApp: true,
  isMobileApp: false,
  isAndroidApp: false,
};

export function requireApiVersion(_version: string): boolean {
  // CLI is always "new enough" — VALID_REQURL (baseTypes.ts:355) resolves true.
  return true;
}

export interface StubRequestOpts {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer | Uint8Array;
  contentType?: string;
  throw?: boolean;
}

export interface StubRequestUrlResponse {
  status: number;
  /** Lowercased header keys — graphRequest does lower[name.toLowerCase()]. */
  headers: Record<string, string>;
  text: string;
  /** Parsed JSON when the body is JSON, else undefined.
   *  graphRequest's json() does `res.json ?? (res.text ? JSON.parse : null)`,
   *  so undefined here falls through to its text fallback. */
  json: unknown | undefined;
  arrayBuffer: ArrayBuffer;
}

/**
 * Obsidian `request` — used by sendAuthReq / sendRefreshTokenReq, which do
 * `JSON.parse(rsp1)` on the returned string. Returns the response body text.
 * Body is passed through (string / ArrayBuffer / Uint8Array). Content-Type is
 * set from the `contentType` param (Obsidian forbids Content-Type as a header).
 */
export async function request(opts: StubRequestOpts): Promise<string> {
  const headers = buildHeaders(opts);
  const body = opts.body;
  const res = await globalThis.fetch(opts.url, {
    method: opts.method ?? "GET",
    headers,
    body: body as BodyInit | undefined,
  });
  if (opts.throw !== false && !res.ok) {
    throw new Error(`request: ${res.status} ${res.statusText} ${opts.url}`);
  }
  return res.text();
}

/**
 * Obsidian `requestUrl` — used by graphRequest (fsOnedrive.ts:110-133).
 * Returns {status, headers(lowercased), text, json, arrayBuffer}.
 * When `throw:false` (graphRequest always passes this), non-2xx statuses
 * RETURN with the real status — never throw — matching fetch semantics.
 */
export async function requestUrl(
  opts: StubRequestOpts,
): Promise<StubRequestUrlResponse> {
  const headers = buildHeaders(opts);
  const body = opts.body;
  const res = await globalThis.fetch(opts.url, {
    method: opts.method ?? "GET",
    headers,
    body: body as BodyInit | undefined,
  });
  if (opts.throw !== false && !res.ok) {
    throw new Error(`requestUrl: ${res.status} ${res.statusText} ${opts.url}`);
  }
  const text = await res.text();
  // Lowercase ALL response header keys (graphRequest does
  // lower[name.toLowerCase()] on this record, and _retryOnTransientError reads
  // headers["retry-after"] off the flat lowercased spread).
  const lowerHeaders: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    lowerHeaders[key.toLowerCase()] = value;
  });
  // Provide json parsed from the body text when it is JSON, else undefined.
  // graphRequest's json() falls back to `JSON.parse(res.text)` when json is
  // undefined, so leaving undefined is always safe; providing it parsed when
  // the body IS json avoids a redundant re-parse.
  let json: unknown | undefined;
  const ct = (lowerHeaders["content-type"] ?? "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  } else {
    json = undefined;
  }
  const arrayBuffer = await res.arrayBuffer();
  return {
    status: res.status,
    headers: lowerHeaders,
    text,
    json,
    arrayBuffer,
  };
}

function buildHeaders(opts: StubRequestOpts): Headers {
  const headers = new Headers();
  // Content-Type is passed via its dedicated param (Obsidian forbids it as a
  // header); graphRequest strips it before calling requestUrl.
  if (opts.contentType) {
    headers.set("Content-Type", opts.contentType);
  }
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headers.set(k, v);
    }
  }
  return headers;
}
