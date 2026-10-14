import { CryptoProvider, PublicClientApplication } from "@azure/msal-node";
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client";
import type {
  DriveItem,
  FileSystemInfo,
  UploadSession,
  User,
} from "@microsoft/microsoft-graph-types";
import cloneDeep from "lodash/cloneDeep";
import { request, requestUrl } from "obsidian";
import {
  type BatchRenameOp,
  type BatchRenameResult,
  COMMAND_CALLBACK_ONEDRIVE,
  DEFAULT_CONTENT_TYPE,
  type Entity,
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
  ONEDRIVE_AUTHORITY,
  ONEDRIVE_CLIENT_ID,
  type OnedriveConfig,
  type RenameOpts,
} from "./baseTypes";
import { VALID_REQURL } from "./baseTypes";
import {
  buildIdToKeyMap,
  classifyDeltaItems,
  mergeDeltaWithPrevState,
} from "./deltaMerge";
import {
  fromDriveItemToEntity,
  fromDriveItemToEntityWithChainFallback,
} from "./driveItemConvert";
import { FakeFs } from "./fsAll";
import { debugInfo } from "./logger";
import { bufferToArrayBuffer } from "./misc";
import { buildDeltaStartUrl } from "./syncOptimize";

const SCOPES = ["User.Read", "Files.ReadWrite.AppFolder", "offline_access"];
const REDIRECT_URI = `obsidian://${COMMAND_CALLBACK_ONEDRIVE}`;

export const DEFAULT_ONEDRIVE_CONFIG: OnedriveConfig = {
  accessToken: "",
  clientID: ONEDRIVE_CLIENT_ID ?? "",
  authority: ONEDRIVE_AUTHORITY ?? "",
  refreshToken: "",
  accessTokenExpiresInSeconds: 0,
  accessTokenExpiresAtTime: 0,
  deltaLink: "",
  username: "",
  credentialsShouldBeDeletedAtTime: 0,
  emptyFile: "skip",
  kind: "onedrive",
};

////////////////////////////////////////////////////////////////////////////////
// Graph HTTP transport: Obsidian requestUrl facade
////////////////////////////////////////////////////////////////////////////////

/**
 * A fetch-`Response`-like facade over Obsidian's `requestUrl`, so the Graph
 * call sites read exactly like the old fetch-based code (`res.ok` /
 * `res.status` / `res.headers.get(...)` / `await res.text()` /
 * `await res.json()` / `await res.arrayBuffer()`) while the request goes
 * through Obsidian's native layer (CORS-free; no renderer `fetch`, which
 * the Obsidian plugin guidelines restrict).
 */
export interface GraphResponse {
  status: number;
  ok: boolean;
  headers: {
    get(name: string): string | null;
    // Lowercased header names are also exposed as flat properties, so
    // _retryOnTransientError's `headers["retry-after"]` lookup works on
    // raw {status, headers} 429 throws.
    [key: string]: unknown;
  };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Perform a Graph API (or pre-authenticated download URL) request via
 * Obsidian's `requestUrl` and return a `GraphResponse` facade.
 *
 * `requestUrl` FORBIDS `Content-Length` and `Content-Type` as headers:
 * Content-Type is passed through its dedicated `contentType` param, and
 * Content-Length is dropped (it is derived from the body). `throw: false`
 * makes non-2xx statuses RETURN like fetch does, so the call sites' status
 * classification (404/412/429/!ok branches) is preserved unchanged;
 * network-level failures still throw, feeding `_retryOnTransientError`'s
 * transient-network retry exactly as a failed fetch did.
 */
export async function graphRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | ArrayBuffer | Uint8Array;
  }
): Promise<GraphResponse> {
  const {
    "Content-Type": ct,
    "Content-Length": _cl,
    ...rest
  } = init.headers ?? {};
  const body =
    init.body instanceof Uint8Array
      ? bufferToArrayBuffer(init.body)
      : init.body;
  const res = await requestUrl({
    url,
    method: init.method ?? "GET",
    headers: rest,
    body,
    contentType: ct,
    throw: false,
  });
  // requestUrl response header keys are already lowercased; expose both a
  // case-insensitive .get() (Headers-style) and the flat lowercased record
  // (so _retryOnTransientError's headers["retry-after"] lookup works).
  const lower = res.headers;
  return {
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    headers: {
      get: (name: string) => lower[name.toLowerCase()] ?? null,
      ...lower,
    },
    text: () => Promise.resolve(res.text),
    json: (): Promise<unknown> =>
      Promise.resolve(res.json ?? (res.text ? JSON.parse(res.text) : null)),
    arrayBuffer: () => Promise.resolve(res.arrayBuffer),
  };
}

////////////////////////////////////////////////////////////////////////////////
// Onedrive authorization using PKCE
////////////////////////////////////////////////////////////////////////////////

/**
 * Detect whether an error thrown by Obsidian's request/requestUrl or fetch
 * is an HTTP 404 (Not Found). The OneDrive Graph API returns 404 when a file
 * or folder has been deleted since the last walk 鈥?the sync's stale view
 * then tries to stat/download it and fails.
 *
 * The error shape varies by transport (requestUrl attaches .status; fetch
 * wrappers may put it in .response.status or in the message string), so we
 * check all known locations.
 */
function isHttp404(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as {
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status: number | undefined = err.status ?? err.response?.status;
  if (status === 404) return true;
  if (typeof err.message === "string" && err.message.includes("status 404")) {
    return true;
  }
  return false;
}

/**
 * Extract the HTTP status code from a thrown error across the transports this
 * file uses. Obsidian's request()/requestUrl() throw
 * `Error("Request failed, status XXX")` with no `.status` property, while the
 * fetch() paths throw either `{ status }` objects or
 * `Error("OneDrive ... failed: XXX ...")`. This unifies both so the retry
 * wrapper can decide whether an error is transient.
 */
function extractHttpStatus(e: unknown): number | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const err = e as {
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const fromProps: unknown = err.status ?? err.response?.status;
  if (typeof fromProps === "number") {
    return fromProps;
  }
  if (typeof err.message === "string") {
    const m = err.message.match(/(?:status\s+|:\s+)(\d{3})/i);
    if (m !== null) {
      return Number.parseInt(m[1], 10);
    }
  }
  return undefined;
}

/**
 * Detect transport-level (non-HTTP-status) network errors worth retrying:
 * Chromium HTTP/2 stream resets ('net::ERR_HTTP2_...', e.g.
 * ERR_HTTP2_PROTOCOL_ERROR returned alongside a 200 status after the server
 * reset the stream mid-body), connection resets, and the generic fetch
 * 'Failed to fetch' / NetworkError. extractHttpStatus() returns undefined for
 * these (there is no status code), so without this they bypass
 * _retryOnTransientError and abort the whole sync.
 *
 * Timeouts (net::ERR_TIMED_OUT, ERR_CONNECTION_TIMED_OUT, ...) are EXCLUDED:
 * they fire only after the full request-timeout window has elapsed and usually
 * persist for as long as the network condition lasts, so retrying one 3×
 * multiplies that window into a multi-minute stall instead of recovering.
 * Worse, the deltaLink query is wrapped in this retry — one timeout turned the
 * graceful "fall back to full enumeration" path into a minutes-long hang
 * (regression in the commit that introduced this predicate's `net::ERR_`
 * catch-all). Letting timeouts throw immediately restores the fast fallback;
 * the download path simply surfaces the error to the next sync, matching
 * pre-retry behavior. The `net::ERR_` catch-all below still matches other
 * transient net errors; the guard above it defangs it for timeouts.
 */
export function isTransientNetworkError(e: unknown): boolean {
  let msg = "";
  if (typeof e === "string") {
    msg = e;
  } else if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") {
      msg = m;
    }
  }
  if (msg === "") return false;
  // Timeouts are slow-to-fire and persistent; do NOT retry them (see above).
  if (/TIMED_OUT/i.test(msg)) return false;
  return /ERR_HTTP2|ERR_QUIC|ERR_CONNECTION_(RESET|CLOSED|ABORTED|REFUSED)|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|net::ERR_|Failed to fetch|NetworkError/i.test(
    msg
  );
}

/** An Error carrying optional machine-readable `code`/`key` fields (set by
 *  this file's error builders; driveItemConvert's out-of-scope error also
 *  carries `.code`). Used to read those fields off `unknown` catch values
 *  without resorting to `any`. */
type CodedError = Error & { code?: string; key?: string };

/**
 * Build a recognizable error for the "remote file was deleted between the
 * walk and the stat/download" race condition. The sync collects these in an
 * AggregateError; main.ts groups them into a single friendly notice.
 */
function remoteNotFoundError(key: string): Error {
  const err = new Error(
    `Remote file not found (deleted since sync started): ${key}`
  );
  Object.assign(err, { code: "REMOTE_NOT_FOUND", key });
  return err;
}

/**
 * Build a recognizable error for the "remote file was changed by another
 * device between the sync walk and the write" race condition, detected via
 * an If-Match precondition request returning HTTP 412. Mirrors
 * remoteNotFoundError: plain Error + `.code` + `.key`, so makeCatch (sync.ts)
 * preserves them and main.ts can branch on `.code`.
 */
export function remoteEtagMismatchError(key: string): Error {
  const err = new Error(
    `Remote etag mismatch (another device changed this file since sync walk): ${key}`
  );
  Object.assign(err, { code: "REMOTE_ETAG_MISMATCH", key });
  return err;
}

/**
 * Classify an error thrown by a OneDrive write path into the sync-level
 * error codes, purely from the HTTP status (via extractHttpStatus above):
 *  - 412 Precondition Failed -> "REMOTE_ETAG_MISMATCH" (If-Match guard hit)
 *  - 404 Not Found           -> "REMOTE_NOT_FOUND"     (deleted since walk)
 *  - anything else           -> null (not a write-conflict signal)
 * Pure function: shared by this file's write methods and upper layers.
 */
export function classifyOneDriveWriteError(
  e: unknown
): "REMOTE_ETAG_MISMATCH" | "REMOTE_NOT_FOUND" | null {
  const status = extractHttpStatus(e);
  if (status === 412) return "REMOTE_ETAG_MISMATCH";
  if (status === 404) return "REMOTE_NOT_FOUND";
  return null;
}

/**
 * HTTP statuses that the write paths treat as expected, non-bug outcomes:
 *  - 404/412 — the documented stale-view race (deleted since walk) and the
 *    If-Match conflict, both absorbed/re-routed by sync.ts (nothing reaches
 *    errNotifyFunc);
 *  - 429/500/502/503/504 — transient; _retryOnTransientError retries them and
 *    logs its own warning.
 * Such responses are NOT failures, so the write methods must not log them via
 * console.error (that only adds red noise for normal operation). Kept as a
 * pure, unit-testable predicate.
 */
export function isHandledHttpStatus(status: number | undefined): boolean {
  return (
    status === 404 ||
    status === 412 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/**
 * Build the OneDrive small-file PUT request structure (url/method/body/
 * headers) as a PURE function so the header logic is unit-testable without
 * a fetch mock. The `If-Match` header (etag precondition guard against
 * concurrent writes from other devices) is added only when `ifMatch` is a
 * non-empty string. `Authorization` is left empty here — the caller fills
 * it at runtime with a fresh token.
 */
export function _buildPutRequest(
  url: string,
  payload: ArrayBuffer,
  ifMatch?: string
) {
  const headers: Record<string, string> = {
    "Content-Type": DEFAULT_CONTENT_TYPE,
    Authorization: "", // filled by the caller at runtime
  };
  if (ifMatch !== undefined && ifMatch !== "") {
    headers["If-Match"] = ifMatch;
  }
  return { url, method: "PUT", body: payload, headers };
}

/**
 * Build the OneDrive rename/move PATCH request components as a PURE
 * function (no I/O) so it is unit-testable without a fetch mock. `url` is
 * the Graph path of the OLD item (the PATCH target). `name` carries ONLY
 * the new basename (the Graph API expects a filename, not a full path).
 * `parentChanged` is true when the parent directory differs (a move);
 * `newParentKey` is the vault-relative key of the new parent folder (ends
 * with "/") — the caller must stat it on the remote to obtain the Graph
 * `id` for `parentReference.id` (Graph does NOT accept `parentReference.path`
 * in a PATCH body — only `id`). Folder keys end with "/"; the trailing
 * slash is stripped before extracting the basename.
 */
export function _buildRenameRequest(
  key1: string,
  key2: string,
  remoteBaseDir: string
): {
  url: string;
  name: string;
  parentChanged: boolean;
  newParentKey: string;
} {
  const splitKey = (key: string) => {
    const k = key.endsWith("/") ? key.slice(0, -1) : key;
    const idx = k.lastIndexOf("/");
    if (idx === -1) {
      return { parentDir: "", basename: k };
    }
    return { parentDir: k.slice(0, idx), basename: k.slice(idx + 1) };
  };

  const url = getOnedrivePath(key1, remoteBaseDir);
  const { parentDir: oldParentDir } = splitKey(key1);
  const { parentDir: newParentDir, basename } = splitKey(key2);

  const parentChanged = oldParentDir !== newParentDir;
  const newParentKey = parentChanged ? `${newParentDir}/` : "";

  return { url, name: basename, parentChanged, newParentKey };
}

/**
 * Build the createUploadSession request body as a PURE function so it is
 * unit-testable: `{ item: { conflictBehavior: "replace", fileSystemInfo? } }`.
 * `fileSystemInfo` is only possible via uploadSession and is included when
 * both timestamps are given. NOTE: the If-Match precondition is a HEADER
 * (documented as supported by createUploadSession), sent by the `_postJson`
 * caller — the body builder never sees it (`_expectedEtag` is accepted for
 * call-site symmetry and intentionally unused here).
 */
export function _buildCreateUploadSessionBody(
  mtimeStr?: string,
  ctimeStr?: string,
  _expectedEtag?: string
) {
  const item: DriveItem & { "@microsoft.graph.conflictBehavior": string } = {
    "@microsoft.graph.conflictBehavior": "replace",
  };
  if (mtimeStr !== undefined && ctimeStr !== undefined) {
    item.fileSystemInfo = {
      lastModifiedDateTime: mtimeStr,
      createdDateTime: ctimeStr,
    };
  }
  return { item };
}

export async function getAuthUrlAndVerifier(
  clientID: string,
  authority: string
) {
  const cryptoProvider = new CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const pkceCodes = {
    challengeMethod: "S256", // Use SHA256 Algorithm
    verifier: verifier,
    challenge: challenge,
  };

  const authCodeUrlParams = {
    redirectUri: REDIRECT_URI,
    scopes: SCOPES,
    codeChallenge: pkceCodes.challenge, // PKCE Code Challenge
    codeChallengeMethod: pkceCodes.challengeMethod, // PKCE Code Challenge Method
  };

  const pca = new PublicClientApplication({
    auth: {
      clientId: clientID,
      authority: authority,
    },
  });
  const authCodeUrl = await pca.getAuthCodeUrl(authCodeUrlParams);

  return {
    authUrl: authCodeUrl,
    verifier: verifier,
  };
}

/**
 * Check doc from
 * https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 * https://docs.microsoft.com/en-us/onedrive/developer/rest-api/getting-started/graph-oauth?view=odsp-graph-online#code-flow
 */
export interface AccessCodeResponseSuccessfulType {
  token_type: "Bearer" | "bearer";
  expires_in: number;
  ext_expires_in?: number;
  scope: string;
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}
export interface AccessCodeResponseFailedType {
  error: string;
  error_description: string;
  error_codes: number[];
  timestamp: string;
  trace_id: string;
  correlation_id: string;
}

export const sendAuthReq = async (
  clientID: string,
  authority: string,
  authCode: string,
  verifier: string,
  errorCallBack: (err: unknown) => Promise<void>
) => {
  // // original code snippets for references
  // const authResponse = await pca.acquireTokenByCode({
  //   redirectUri: REDIRECT_URI,
  //   scopes: SCOPES,
  //   code: authCode,
  //   codeVerifier: verifier, // PKCE Code Verifier
  // });
  // console.info('authResponse')
  // console.info(authResponse)
  // return authResponse;

  // Because of the CORS problem,
  // we need to construct raw request using Obsidian request,
  // instead of using msal
  // https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
  // https://docs.microsoft.com/en-us/onedrive/developer/rest-api/getting-started/graph-oauth?view=odsp-graph-online#code-flow
  try {
    const rsp1 = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        // v2.0 auth-code token grant has NO `tenant` body param: the {tenant}
        // in the URL path (/common here) is authoritative and routes BOTH
        // personal + work/school accounts. Sending tenant=consumers was
        // undocumented and forced a consumers context, blocking work/school
        // code redemption. See MS Learn v2-oauth2-auth-code-flow.
        client_id: clientID,
        scope: SCOPES.join(" "),
        code: authCode,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });

    const rsp2: unknown = JSON.parse(rsp1);
    // console.info(rsp2);

    if ((rsp2 as { error?: string }).error !== undefined) {
      return rsp2 as AccessCodeResponseFailedType;
    } else {
      return rsp2 as AccessCodeResponseSuccessfulType;
    }
  } catch (e) {
    console.error(e);
    await errorCallBack(e);
  }
};

export const sendRefreshTokenReq = async (
  clientID: string,
  authority: string,
  refreshToken: string
) => {
  // also use Obsidian request to bypass CORS issue.
  try {
    const rsp1 = await request({
      url: `${authority}/oauth2/v2.0/token`,
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: new URLSearchParams({
        // v2.0 refresh-token grant has NO `tenant` body param (see
        // v2-oauth2-auth-code-flow); the /common URL path resolves the account
        // type from the refresh_token itself. tenant=consumers was undocumented
        // and forced consumers context — removed so work/school refresh works.
        client_id: clientID,
        scope: SCOPES.join(" "),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    const rsp2: unknown = JSON.parse(rsp1);
    // console.info(rsp2);

    if ((rsp2 as { error?: string }).error !== undefined) {
      return rsp2 as AccessCodeResponseFailedType;
    } else {
      return rsp2 as AccessCodeResponseSuccessfulType;
    }
  } catch (e) {
    console.error(e);
    throw e;
  }
};

export const setConfigBySuccessfullAuthInplace = async (
  config: OnedriveConfig,
  authRes: AccessCodeResponseSuccessfulType,
  saveUpdatedConfigFunc: (() => Promise<void>) | undefined
) => {
  debugInfo("start updating local info of OneDrive token");
  config.accessToken = authRes.access_token;
  config.accessTokenExpiresAtTime =
    Date.now() + authRes.expires_in - 5 * 60 * 1000;
  config.accessTokenExpiresInSeconds = authRes.expires_in;
  config.refreshToken = authRes.refresh_token!;

  // manually set it expired after 80 days;
  config.credentialsShouldBeDeletedAtTime =
    Date.now() + OAUTH2_FORCE_EXPIRE_MILLISECONDS;

  if (saveUpdatedConfigFunc !== undefined) {
    await saveUpdatedConfigFunc();
  }

  debugInfo("finish updating local info of Onedrive token");
};

////////////////////////////////////////////////////////////////////////////////
// Other usual common methods
////////////////////////////////////////////////////////////////////////////////

const getOnedrivePath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  // https://docs.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder?view=odsp-graph-online
  const prefix = `/me/drive/special/approot:/${remoteBaseDir}`;

  let key = fileOrFolderPath;
  if (fileOrFolderPath === "/" || fileOrFolderPath === "") {
    // special
    return prefix;
  }
  if (key.endsWith("/")) {
    key = key.slice(0, key.length - 1);
  }

  if (key.startsWith("/")) {
    console.warn(`why the path ${key} starts with '/'? but we just go on.`);
    key = `${prefix}${key}`;
  } else {
    key = `${prefix}/${key}`;
  }
  return key;
};

////////////////////////////////////////////////////////////////////////////////
// The client.
////////////////////////////////////////////////////////////////////////////////

// to adapt to the required interface
class MyAuthProvider implements AuthenticationProvider {
  onedriveConfig: OnedriveConfig;
  saveUpdatedConfigFunc: () => Promise<void>;
  private refreshPromise: Promise<string> | null = null;
  constructor(
    onedriveConfig: OnedriveConfig,
    saveUpdatedConfigFunc: () => Promise<void>
  ) {
    this.onedriveConfig = onedriveConfig;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
  }

  async getAccessToken() {
    if (
      this.onedriveConfig.accessToken === "" ||
      this.onedriveConfig.refreshToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
    }

    const currentTs = Date.now();
    if (this.onedriveConfig.accessTokenExpiresAtTime > currentTs) {
      return this.onedriveConfig.accessToken;
    } else {
      // Token refresh mutex: if a refresh is already in-flight,
      // await the same promise instead of initiating a concurrent
      // refresh. Microsoft rotates refresh tokens, so concurrent
      // refreshes can invalidate each other (invalid_grant error).
      if (this.refreshPromise !== null) {
        return this.refreshPromise;
      }
      this.refreshPromise = this._doRefresh();
      try {
        return await this.refreshPromise;
      } finally {
        this.refreshPromise = null;
      }
    }
  }

  private async _doRefresh(): Promise<string> {
    const currentTs = Date.now();
    const r = await sendRefreshTokenReq(
      this.onedriveConfig.clientID,
      this.onedriveConfig.authority,
      this.onedriveConfig.refreshToken
    );
    if ("error" in r) {
      const r2 = r;
      throw Error(
        `Error while refreshing accessToken: ${r2.error}, ${String(r2.error_codes)}: ${r2.error_description}`
      );
    }
    const r2 = r;
    this.onedriveConfig.accessToken = r2.access_token;
    this.onedriveConfig.refreshToken = r2.refresh_token!;
    this.onedriveConfig.accessTokenExpiresInSeconds = r2.expires_in;
    this.onedriveConfig.accessTokenExpiresAtTime =
      currentTs + r2.expires_in * 1000 - 60 * 2 * 1000;
    await this.saveUpdatedConfigFunc();
    debugInfo("Onedrive accessToken updated");
    return this.onedriveConfig.accessToken;
  }
}

/**
 * to export the settings in qrcode,
 * we want to "trim" or "shrink" the settings
 * @param onedriveConfig
 */
export const getShrinkedSettings = (onedriveConfig: OnedriveConfig) => {
  const config = cloneDeep(onedriveConfig);
  config.accessToken = "x";
  config.accessTokenExpiresInSeconds = 1;
  config.accessTokenExpiresAtTime = 1;
  return config;
};

/** One page of a Graph delta / children enumeration response: the item
 *  array plus the paging annotations (`@odata.nextLink` while more pages
 *  remain; `@odata.deltaLink` on the final page of a delta query). */
interface DeltaResponsePage {
  value: DriveItem[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/** A DriveItem plus the pre-authenticated download URL annotation Graph
 *  returns when `@microsoft.graph.downloadUrl` is $select'ed. */
type DriveItemWithDownloadUrl = DriveItem & {
  "@microsoft.graph.downloadUrl"?: string;
};

/** The `body` of one Graph `$batch` sub-response; only the error facet is
 *  read (batch rename does not consume the wrapped driveItem). */
interface BatchSubResponseBody {
  error?: { message?: string };
}

/** One sub-response inside a Graph `$batch` envelope, correlated to the
 *  request by `id`. */
interface BatchSubResponse {
  id: string;
  status: number;
  body?: BatchSubResponseBody;
}

export class FakeFsOnedrive extends FakeFs {
  kind: "onedrive";
  onedriveConfig: OnedriveConfig;
  remoteBaseDir: string;
  vaultFolderExists: boolean;
  authGetter: MyAuthProvider;
  saveUpdatedConfigFunc: () => Promise<void>;
  foldersCreatedBefore: Set<string>;
  /**
   * The full remote entity list from the previous sync's walk().
   * When present AND deltaLink is set, walk() uses the OneDrive delta API
   * incrementally (only changed items) and merges with this state,
   * avoiding a full re-enumeration of all remote files.
   */
  prevRemoteEntities?: Entity[];
  /**
   * The Graph driveItem.id of the vault's remote root folder (the
   * remoteBaseDir folder directly under the approot special folder),
   * captured by _init() from /drive/special/approot/children. walk()'s
   * incremental branch uses it as the anchor of the parentReference.id-chain
   * fallback: delta items with parentReference.path omitted (the documented
   * Graph delta shape) resolve as direct children of the vault root when
   * their parentReference.id equals this id. Stays undefined on the
   * POST-create path (folder did not exist yet) - that sync is a full
   * enumeration which needs no anchor, and the next sync's fresh instance
   * captures it in _init().
   */
  approotRootId?: string;
  /**
   * The result of the most recent walk() call. main.ts saves this to the
   * DB after sync so the next sync can use it for incremental enumeration.
   */
  lastWalkResult?: Entity[];

  constructor(
    onedriveConfig: OnedriveConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<void>,
    prevRemoteEntities?: Entity[]
  ) {
    super();
    this.kind = "onedrive";
    this.onedriveConfig = onedriveConfig;
    this.remoteBaseDir = this.onedriveConfig.remoteBaseDir || vaultName || "";
    this.vaultFolderExists = false;
    this.saveUpdatedConfigFunc = saveUpdatedConfigFunc;
    this.authGetter = new MyAuthProvider(onedriveConfig, saveUpdatedConfigFunc);
    this.foldersCreatedBefore = new Set();
    this.prevRemoteEntities = prevRemoteEntities;
  }

  async _init() {
    // check token
    if (
      this.onedriveConfig.accessToken === "" ||
      this.onedriveConfig.refreshToken === ""
    ) {
      throw Error("The user has not manually auth yet.");
    }

    // check vault folder
    // console.info(`checking remote has folder /${this.remoteBaseDir}`);
    if (this.vaultFolderExists) {
      // console.info(`already checked, /${this.remoteBaseDir} exist before`)
    } else {
      // Warm up / provision the App Folder. Per the app-folder docs, the FIRST
      // GET /me/drive/special/approot (the RESOURCE, not /children) materializes
      // the Apps/{appName} special folder if it doesn't exist; GET .../children
      // does NOT provision it.
      // https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder
      await this._getJson("/me/drive/special/approot");

      // /me/drive/... is REQUIRED here: bare /drive is not a valid POST path
      // (driveitem-post-children lists only /me/drive, /drives/{id},
      // /users/{id}/drive, /groups/{id}/drive, /sites/{id}/drive). Bare /drive
      // is accepted for GET (lenient binding) but rejected on POST with
      // invalidRequest "Invalid request".
      const k = await this._getJson<{ value: DriveItem[] }>(
        "/me/drive/special/approot/children"
      );
      // console.debug(k);
      const rootMatches = k.value.filter((x) => x.name === this.remoteBaseDir);
      this.vaultFolderExists = rootMatches.length > 0;
      if (this.vaultFolderExists) {
        // Capture the vault root folder's id: the anchor for walk()'s
        // parentReference.id-chain fallback (see the approotRootId field).
        // (When vaultFolderExists was already true this whole branch is
        // skipped; the field was filled by the earlier _init() of this
        // same instance.)
        this.approotRootId = rootMatches[0].id;
      }
      if (!this.vaultFolderExists) {
        debugInfo(`remote does not have folder /${this.remoteBaseDir}`);
        await this._postJson("/me/drive/special/approot/children", {
          name: `${this.remoteBaseDir}`,
          folder: {},
          // NOTE: @microsoft.graph.conflictBehavior is OMITTED on purpose.
          // For this app registration, including conflictBehavior (any value:
          // fail/rename/replace) makes Graph return 400 invalidRequest on
          // POST /special/approot/children. Omitting it succeeds (the GET
          // above already confirmed the folder doesn't exist, so no conflict).
        });
        debugInfo(`remote folder /${this.remoteBaseDir} created`);
        this.vaultFolderExists = true;
      } else {
        // console.info(`remote folder /${this.remoteBaseDir} exists`);
      }
    }
  }

  _buildUrl(pathFragOrig: string) {
    const API_PREFIX = "https://graph.microsoft.com/v1.0";
    let theUrl = "";
    if (
      pathFragOrig.startsWith("http://") ||
      pathFragOrig.startsWith("https://")
    ) {
      theUrl = pathFragOrig;
    } else {
      const pathFrag = encodeURI(pathFragOrig);
      theUrl = `${API_PREFIX}${pathFrag}`;
    }
    // we want to support file name with hash #
    // because every url we construct here do not contain the # symbol
    // thus it should be safe to directly replace the character
    theUrl = theUrl.replace(/#/g, "%23");
    // console.debug(`building url: [${pathFragOrig}] => [${theUrl}]`)
    return theUrl;
  }

  /**
   * Retry wrapper for Graph API calls that fail transiently:
   * - HTTP 429 (throttling): OneDrive returns a Retry-After header (seconds).
   * - HTTP 500/502/503/504 (server-side gateway/transient outages).
   *
   * A 504 "Gateway Timeout" is common when syncing a large backlog 鈥?a single
   * slow Graph request times out at an intermediate gateway. Without a retry
   * here, one transient 504 aborts the whole sync (surfaced as an
   * AggregateError in sync.ts). We wait and retry, up to maxRetries.
   * Non-transient errors are re-thrown immediately.
   */
  async _retryOnTransientError<T>(
    fn: () => Promise<T>,
    maxRetries = 3
  ): Promise<T> {
    let lastError: unknown = undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e: unknown) {
        lastError = e;
        const status = extractHttpStatus(e);
        const isThrottled = status === 429;
        const isTransientServerError =
          status !== undefined &&
          (status === 500 ||
            status === 502 ||
            status === 503 ||
            status === 504);
        // Transport-level network errors carry no HTTP status (see
        // isTransientNetworkError) and are intermittent; retry them too.
        const isTransientNetwork = isTransientNetworkError(e);

        if (!isThrottled && !isTransientServerError && !isTransientNetwork) {
          throw e;
        }
        if (attempt >= maxRetries) {
          throw e;
        }
        // Retry-After (seconds) is authoritative when present; otherwise
        // fall back to exponential backoff, capped to avoid unbounded waits.
        const err = e as {
          headers?: Record<string, unknown>;
          response?: { headers?: Record<string, unknown> };
        } | null;
        const retryAfterValue =
          err?.headers?.["Retry-After"] ||
          err?.headers?.["retry-after"] ||
          err?.response?.headers?.["Retry-After"];
        const retryAfterRaw: string | undefined =
          typeof retryAfterValue === "string" ? retryAfterValue : undefined;
        const retryAfterSec = retryAfterRaw
          ? Number.parseInt(retryAfterRaw, 10)
          : Math.min(2 ** attempt, 10);
        const waitMs = retryAfterSec * 1000;
        console.warn(
          `Graph API transient error (${
            status !== undefined ? `status ${status}` : "network"
          }), waiting ${retryAfterSec}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => window.setTimeout(resolve, waitMs));
      }
    }
    throw lastError;
  }

  async _getJson<T = unknown>(pathFragOrig: string): Promise<T> {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`getJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError<T>(async () => {
      return JSON.parse(
        await request({
          url: theUrl,
          method: "GET",
          contentType: "application/json",
          headers: {
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
            "Cache-Control": "no-cache",
          },
        })
      ) as T;
    });
  }

  async _postJson<T = unknown>(
    pathFragOrig: string,
    payload: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`postJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError<T>(async () => {
      const accessToken = await this.authGetter.getAccessToken();
      const res = await graphRequest(theUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          // Caller-supplied headers (e.g. If-Match precondition);
          // Authorization is always set here with a fresh token.
          ...headers,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        // Handled statuses (404/412 races, 429/5xx transient) are not failures.
        if (isHandledHttpStatus(res.status)) {
          console.debug(`postJson handled status=${res.status} url=${theUrl}`);
        } else {
          console.error(
            `postJson FAILED url=${theUrl} status=${res.status}`,
            "payload=",
            payload,
            "body=",
            text
          );
        }
        const err = new Error(
          `OneDrive POST failed: ${res.status} ${pathFragOrig} ${text}`
        );
        Object.assign(err, {
          status: res.status,
          headers: { "Retry-After": res.headers.get("Retry-After") },
        });
        throw err;
      }
      return (text === "" ? null : JSON.parse(text)) as T;
    });
  }

  async _patchJson<T = unknown>(
    pathFragOrig: string,
    payload: unknown
  ): Promise<T> {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`patchJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError<T>(async () => {
      const res = await graphRequest(theUrl, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
        },
        body: JSON.stringify(payload),
      });
      const text = await res.text().catch(() => "");
      if (!res.ok) {
        // Handled statuses (404/412 races, 429/5xx transient) are not failures.
        if (isHandledHttpStatus(res.status)) {
          console.debug(`patchJson handled status=${res.status} url=${theUrl}`);
        } else {
          console.error(
            `patchJson FAILED url=${theUrl} status=${res.status}`,
            "payload=",
            payload,
            "body=",
            text
          );
        }
        const err = new Error(
          `OneDrive PATCH failed: ${res.status} ${pathFragOrig} ${text}`
        );
        Object.assign(err, {
          status: res.status,
          headers: { "Retry-After": res.headers.get("Retry-After") },
        });
        throw err;
      }
      return (text === "" ? null : JSON.parse(text)) as T;
    });
  }

  async _deleteJson(pathFragOrig: string) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`deleteJson, theUrl=${theUrl}`);
    await this._retryOnTransientError(async () => {
      if (VALID_REQURL) {
        try {
          await requestUrl({
            url: theUrl,
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
            },
          });
        } catch (e: unknown) {
          const err = e as {
            status?: number;
            response?: { status?: number };
          } | null;
          const status: number | undefined =
            err?.status ?? err?.response?.status;
          // 404 = already deleted, treat as success (idempotent delete)
          if (status === 404) {
            return;
          }
          throw e;
        }
      } else {
        const res = await graphRequest(theUrl, {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        });
        // 404 = already deleted, treat as success (idempotent delete)
        if (res.status === 404) {
          return;
        }
        if (res.status === 429) {
          throw Object.assign(new Error("OneDrive rate limited (HTTP 429)"), {
            status: 429,
            headers: res.headers,
          });
        }
        if (!res.ok && res.status !== 204) {
          const body = await res.text().catch(() => "");
          const err = new Error(
            `OneDrive DELETE failed: ${res.status} ${pathFragOrig} ${body}`
          );
          Object.assign(err, {
            status: res.status,
            headers: { "Retry-After": res.headers.get("Retry-After") },
          });
          throw err;
        }
      }
    });
  }

  async _putArrayBuffer(
    pathFragOrig: string,
    payload: ArrayBuffer,
    ifMatch?: string,
    key?: string
  ) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`putArrayBuffer, theUrl=${theUrl}`);
    return await this._retryOnTransientError(async () => {
      // _buildPutRequest is the unit-tested header builder (adds If-Match
      // only when ifMatch is a non-empty string); Authorization is filled
      // here with a fresh token on every (re)attempt.
      const req = _buildPutRequest(theUrl, payload, ifMatch);
      req.headers.Authorization = `Bearer ${await this.authGetter.getAccessToken()}`;
      let res: GraphResponse | Response;
      if (VALID_REQURL) {
        // requestUrl-based upload: VALID_REQURL guarantees desktop >=0.13.26
        // / Android >=0.14.6, where binary bodies are transmitted correctly.
        res = await graphRequest(theUrl, {
          method: "PUT",
          body: payload,
          headers: req.headers,
        });
      } else {
        // requestUrl binary-upload unverified on Android <0.14.6 (base64
        // bug); see VALID_REQURL gate. fetch kept as the safe fallback.
        res = await fetch(theUrl, {
          method: "PUT",
          body: payload,
          headers: req.headers,
        });
      }
      if (res.status === 429) {
        throw Object.assign(new Error("OneDrive rate limited (HTTP 429)"), {
          status: 429,
          headers: res.headers,
        });
      }
      if (res.status === 412 && key !== undefined) {
        // If-Match precondition failed: another device changed this file
        // since the sync walk. Throw the coded error (REMOTE_ETAG_MISMATCH)
        // so upper layers can re-route to the smart-conflict path. The
        // retry wrapper rethrows it immediately (not 429/5xx).
        throw remoteEtagMismatchError(key);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`OneDrive PUT failed: ${res.status} ${theUrl} ${body}`);
      }
      return (await res.json()) as DriveItem | UploadSession;
    });
  }

  /**
   * A specialized function to upload large files by parts
   * @param pathFragOrig
   * @param payload
   * @param rangeMin
   * @param rangeEnd the end, exclusive
   * @param size
   */
  async _putUint8ArrayByRange(
    pathFragOrig: string,
    payload: Uint8Array,
    rangeStart: number,
    rangeEnd: number,
    size: number,
    key?: string
  ) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(
      `putUint8ArrayByRange, theUrl=${theUrl}, range=${rangeStart}-${
        rangeEnd - 1
      }, len=${rangeEnd - rangeStart}, size=${size}`
    );
    return await this._retryOnTransientError(async () => {
      // NO AUTH HEADER here!
      const rangeHeaders = {
        "Content-Length": `${rangeEnd - rangeStart}`,
        "Content-Range": `bytes ${rangeStart}-${rangeEnd - 1}/${size}`,
        "Content-Type": DEFAULT_CONTENT_TYPE,
        /* "Cache-Control": "no-cache", not allowed here!!! */
      };
      const rangeBody = payload.subarray(
        rangeStart,
        rangeEnd
      ) as Uint8Array<ArrayBuffer>;
      let res: GraphResponse | Response;
      if (VALID_REQURL) {
        // requestUrl-based chunk upload: graphRequest drops Content-Length
        // (forbidden as a requestUrl header; derived from the body), routes
        // Content-Type through the contentType param, and converts the
        // Uint8Array subarray to an ArrayBuffer copy internally.
        res = await graphRequest(theUrl, {
          method: "PUT",
          body: rangeBody,
          headers: rangeHeaders,
        });
      } else {
        // requestUrl binary-upload unverified on Android <0.14.6 (base64
        // bug); see VALID_REQURL gate. fetch kept as the safe fallback.
        res = await fetch(theUrl, {
          method: "PUT",
          body: rangeBody,
          headers: rangeHeaders,
        });
      }
      if (res.status === 429) {
        throw Object.assign(new Error("OneDrive rate limited (HTTP 429)"), {
          status: 429,
          headers: res.headers,
        });
      }
      if (res.status === 412 && key !== undefined) {
        // Precondition failed on a fragment PUT: a concurrent write
        // invalidated the upload. Throw the coded error
        // (REMOTE_ETAG_MISMATCH) so upper layers can re-route to the
        // smart-conflict path; the retry wrapper rethrows it immediately
        // (not 429/5xx). Same pattern as _putArrayBuffer.
        throw remoteEtagMismatchError(key);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `OneDrive PUT range failed: ${res.status} ${theUrl} ${body}`
        );
      }
      return (await res.json()) as DriveItem | UploadSession;
    });
  }

  /**
   * Shared classify + stat-by-id retry for both walk() branches. Extracted
   * from the incremental branch; hardened so out-of-scope stat results are
   * silently dropped (not counted, not invalidating) and folders lacking
   * lastModifiedDateTime don't fail the stat-retry (#3).
   *
   * @param lookupMap SHARED id->keyRaw working map (seeded by the caller:
   *        incremental seeds from prevRemoteEntities, full-enum seeds only
   *        approotRootId->"/"). classifyDeltaItems mutates it; a fresh copy so
   *        mutations never leak into prevRemoteEntities.
   * @param invalidateOnUnresolved Incremental passes true (unresolved items
   *        mean the merged state is incomplete -> invalidate deltaLink so the
   *        next sync full-walks, now with fallback). Full-enum passes false
   *        (it just saved a fresh deltaLink; invalidating would only force an
   *        identical full-walk next sync).
   */
  private async _classifyAndStatRetry(
    driveItems: DriveItem[],
    lookupMap: Map<string, string>,
    invalidateOnUnresolved: boolean
  ): Promise<{
    entities: Entity[];
    deletedKeys: Set<string>;
    unresolvedCount: number;
  }> {
    const { deltaEntities, deletedKeys, skippedAddedOrModified, skippedItems } =
      classifyDeltaItems(
        driveItems,
        this.remoteBaseDir,
        (item, dir, requireMtime) =>
          fromDriveItemToEntityWithChainFallback(
            item,
            dir,
            lookupMap,
            this.approotRootId,
            requireMtime
          ),
        lookupMap,
        this.approotRootId
      );

    let unresolvedCount = skippedAddedOrModified;

    if (skippedItems.length > 0) {
      debugInfo(
        `walk: ${skippedItems.length} delta item(s) had no parentReference.path — retrying via stat-by-id`
      );
      const stat404Items: DriveItem[] = [];
      const statResults = await Promise.all(
        skippedItems
          .filter((item): item is DriveItem => {
            const it = item as { id?: string | null };
            return it.id !== undefined && it.id !== null;
          })
          .map(async (item) => {
            try {
              return await this._getJson<DriveItem>(
                `/drive/items/${item.id}?$select=id,name,size,fileSystemInfo,folder,file,parentReference,eTag`
              );
            } catch (e) {
              // L2: capture 404 items separately — OneDrive personal
              // sometimes returns deleted items as "added/modified"
              // (no @removed); stat-404 confirms they're gone → treat
              // as deleted (add prev keyRaw to deletedKeys so the merge
              // removes the stale entry instead of leaving it to crash
              // the sync's folder logic).
              if (isHttp404(e)) {
                stat404Items.push(item);
                // [DIAG] 404 is expected/handled: the item is deleted
                // or in the recycle bin (not visible to a plain GET,
                // which would need includeDeletedItems=true — we don't
                // send it on purpose: a 404 IS the "it's gone" signal).
                // Debug-level so a transient blip is visible without
                // alarming (data integrity is unaffected: the item is
                // correctly dropped, never enters the sync).
                console.debug(
                  "walk: stat-retry 404 for delta item (treated as gone)",
                  item.id
                );
              } else {
                // [DIAG] non-404 GET failure (after _retryOnTransientError
                // already retried 429/5xx): auth / scope / persistent error.
                // The item's fate is genuinely unknown → NOT decremented,
                // stays counted as unresolved so the terminal warn fires.
                console.warn(
                  "[DIAG] stat-retry GET failed (non-404) for delta item",
                  item.id,
                  e instanceof Error ? e.message : e
                );
              }
              return null;
            }
          })
      );
      // L2: stat-404 → treat as deleted. A 404 means the item is
      // definitively gone — resolved whether it was in prev (MODIFY
      // case → remove from prev via deletedKeys) or a brand-new item
      // that already vanished (just drop). Always decrement so the
      // terminal "N unresolved" warn only fires for items that are
      // TRULY unresolved (parse failed, fate unknown). Mirrors the
      // out-of-scope decrement below; safe because each skipped item
      // is stat'd once and resolves as exactly one of success /
      // out-of-scope / 404 (mutually exclusive — 404 returns null,
      // which the statResults loop skips via `continue`).
      for (const item404 of stat404Items) {
        const ownId404 = item404.id;
        if (ownId404 !== undefined && lookupMap.has(ownId404)) {
          const keyRaw404 = lookupMap.get(ownId404)!;
          if (keyRaw404 !== "/" && keyRaw404 !== "") {
            deletedKeys.add(keyRaw404);
          }
        }
        unresolvedCount--;
      }
      for (const statResp of statResults) {
        if (statResp === null) continue;
        try {
          // (#3) requireMtime=false: folders sync by presence, not mtime; a
          // mkdir'd folder may lack lastModifiedDateTime and must not fail
          // the stat-retry on mtime.
          const entity = fromDriveItemToEntityWithChainFallback(
            statResp,
            this.remoteBaseDir,
            lookupMap,
            this.approotRootId,
            false
          );
          if (entity.key !== "/") {
            deltaEntities.push(entity);
            unresolvedCount--;
            if (statResp.id !== undefined && entity.keyRaw !== "") {
              lookupMap.set(statResp.id, entity.keyRaw);
            }
          }
        } catch (e) {
          // (#3) Out-of-scope item (stat path doesn't map to the vault, e.g. a
          // sibling folder under approot): silent drop. NOT counted as
          // unresolved, NOT invalidating — this is the thrash-stopper.
          if (
            e instanceof Error &&
            (e as CodedError).code === "ONEDRIVE_PATH_OUT_OF_SCOPE"
          ) {
            console.debug(
              "walk: stat-retry dropped out-of-scope item",
              statResp.id
            );
            // Decrement so the drop is truly "not counted as unresolved":
            // otherwise it stays in unresolvedCount and the check below
            // still invalidates the deltaLink (incremental) / warns
            // (full-enum), defeating the thrash-stopper. Safe: each skipped
            // item is stat'd once and decrements at most once (success XOR
            // out-of-scope), so unresolvedCount can't go below 0.
            unresolvedCount--;
          } else {
            // [DIAG] stat-retry failed for a non-out-of-scope reason: stat
            // returned 200-without-parentReference.path (PATH_MISSING after
            // the chain fallback also missed) or another error. Log the
            // cause + what stat returned, to identify the recurring
            // !sc4ea15a... family (is its parent the vault root? approot?
            // does the non-delta GET actually return a path?).
            console.warn(
              "[DIAG] stat-retry conversion failed for",
              statResp.id,
              "code=",
              (e as CodedError | null)?.code,
              "statHasPath=",
              statResp.parentReference?.path != null,
              "statName=",
              statResp.name,
              "msg=",
              e instanceof Error ? e.message : e
            );
          }
        }
      }

      if (unresolvedCount > 0) {
        // Do NOT invalidate the deltaLink. The unresolved items already failed
        // the stat-retry (the non-delta GET /drive/items/{id} — the richest
        // metadata source). The incremental lookupMap is a STRICT SUPERSET of
        // the full-enum lookupMap (prev ids + approotRootId anchor vs anchor
        // only), so if incremental's stat-retry can't resolve an item, a full
        // re-enumeration (fewer lookup entries) cannot either — invalidation
        // cannot self-heal these items, it only thrashes (invalidate ->
        // full-enum -> same failure -> invalidate -> ...). Drop with a warn.
        // The next session's full-enum (on plugin reload) re-attempts with a
        // fresh prev.
        // [DIAG] log approotRootId + the skipped delta items' fields, to
        // identify whether the parent !sc4ea15a... is the vault root, approot,
        // or a subfolder — and whether isApprootRootDriveItem should have
        // caught the item (name === remoteBaseDir + folder).
        console.warn(
          `walk: ${unresolvedCount} added/modified delta item(s) could not be parsed even after stat retry — dropped (no deltaLink invalidation; a full re-enum has fewer lookup entries and would fail identically, so invalidating only thrashes).`,
          "approotRootId=",
          this.approotRootId,
          "remoteBaseDir=",
          this.remoteBaseDir,
          "skipped=",
          JSON.stringify(
            skippedItems.map((raw) => {
              const it = raw as DriveItem | null | undefined;
              return {
                id: it?.id,
                name: it?.name,
                isFolder: it != null && "folder" in it,
                parentId: it?.parentReference?.id,
                hasPath: it?.parentReference?.path != null,
                removed: it != null && "@removed" in it,
                isRootName: it?.name === this.remoteBaseDir,
              };
            })
          ).slice(0, 800)
        );
      }
    }

    return { entities: deltaEntities, deletedKeys, unresolvedCount };
  }

  /**
   * List all files and folders on the remote.
   *
   * Uses the OneDrive delta API. When a `deltaLink` from a previous sync
   * is available AND `prevRemoteEntities` is set, the deltaLink is queried
   * instead of the base delta endpoint 鈥?the Graph API then returns ONLY
   * items that changed since the last sync (additions, modifications,
   * deletions). Those incremental results are merged with the previous
   * full state to reconstruct the complete file list, avoiding a full
   * re-enumeration of all remote files on every sync.
   *
   * https://docs.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_delta?view=odsp-graph-online
   */
  async walk(): Promise<Entity[]> {
    await this._init();

    const NEXT_LINK_KEY = "@odata.nextLink";
    const DELTA_LINK_KEY = "@odata.deltaLink";

    let canIncremental =
      this.onedriveConfig.deltaLink !== "" && this.prevRemoteEntities != null;

    let startUrl = buildDeltaStartUrl(
      canIncremental,
      this.onedriveConfig.deltaLink,
      this.remoteBaseDir
    );

    let res: DeltaResponsePage;
    try {
      res = await this._getJson<DeltaResponsePage>(startUrl);
    } catch (e) {
      if (canIncremental) {
        // deltaLink may have expired 鈥?fall back to full enumeration
        debugInfo(
          "deltaLink query failed, falling back to full enumeration",
          e
        );
        canIncremental = false;
        startUrl = buildDeltaStartUrl(false, "", this.remoteBaseDir);
        res = await this._getJson<DeltaResponsePage>(startUrl);
      } else {
        throw e;
      }
    }

    const driveItems = res.value;

    while (NEXT_LINK_KEY in res) {
      res = await this._getJson<DeltaResponsePage>(res[NEXT_LINK_KEY]!);
      driveItems.push(...res.value);
    }

    // Save deltaLink for next sync's incremental query
    if (DELTA_LINK_KEY in res) {
      this.onedriveConfig.deltaLink = res[DELTA_LINK_KEY]!;
      await this.saveUpdatedConfigFunc();
    }

    if (canIncremental && this.prevRemoteEntities) {
      // Merge incremental delta results with the previous full state.
      // classifyDeltaItems handles BOTH @removed and the `deleted` facet 鈥?      // Graph uses either marker to signal deletions depending on tenant.
      // Checking only @removed leaks stale entries 鈫?404 AggregateErrors.
      // Build the id->key lookup for path-missing delta items (the
      // documented delta shape - Graph omits parentReference.path): own-id
      // lookup covers MODIFY items; the parentReference.id chain (anchored
      // at approotRootId, extended with in-batch resolutions) covers NEW
      // items, e.g. folders created on another device. Items without
      // remoteId (old/walkPartial origin) are gracefully excluded; items
      // whose parent chain is unreachable still skip + self-heal as before.
      const idToKeyMap = buildIdToKeyMap(this.prevRemoteEntities);
      // lookupMap is the SHARED working map (fresh copy — mutations never
      // leak into prevRemoteEntities). Seeded with prev ids; the approot
      // root anchor is seeded inside classifyDeltaItems (idempotent).
      const lookupMap = new Map(idToKeyMap);

      const { entities: deltaEntities, deletedKeys } =
        await this._classifyAndStatRetry(
          driveItems,
          lookupMap,
          /* invalidateOnUnresolved */ true
        );

      const merged = mergeDeltaWithPrevState(
        this.prevRemoteEntities,
        deltaEntities,
        deletedKeys
      );
      this.lastWalkResult = merged;
      this.lastWalkDeltaCount = driveItems.length;
      return merged;
    } else {
      // Full enumeration — no prev to build an id->key map from; seed only
      // the approot root anchor. The shared classify + stat-retry resolves
      // path-missing in-scope items (direct children of vault root via the
      // anchor; deeper via in-batch parent->child chains; or stat-by-id
      // which returns parentReference.path reliably). Out-of-scope items
      // (e.g. sibling folders under approot) are silently dropped instead
      // of warn-skip-thrashing. invalidateOnUnresolved=false: a full-enum
      // just saved a fresh deltaLink; invalidating would only force an
      // identical full-walk next sync.
      const lookupMap = new Map<string, string>();
      if (this.approotRootId !== undefined) {
        lookupMap.set(this.approotRootId, "/");
      }
      const { entities } = await this._classifyAndStatRetry(
        driveItems,
        lookupMap,
        /* invalidateOnUnresolved */ false
      );
      this.lastWalkResult = entities;
      this.lastWalkDeltaCount = undefined;
      return entities;
    }
  }

  async walkPartial(): Promise<Entity[]> {
    await this._init();

    // Do NOT save @odata.deltaLink here. walkPartial() only feeds
    // isPasswordOk()'s sanity check (first remote item); it queries the BASE
    // /delta endpoint, and when the result fits in one page the response
    // carries a deltaLink representing "now". Persisting that would make
    // walk() in step 3 query it and get 0 changes, so it would return stale
    // prevRemoteEntities and cause HTTP 404 AggregateErrors during step 7
    // (stat on files deleted on OneDrive since the last sync 鈥?e.g. by
    // another device's sync). walk() saves its own deltaLink at the end of
    // every enumeration (full and incremental), so this save was redundant
    // and harmful. See deltaMerge.ts for the documented 404 path.
    const res = await this._getJson<{ value: DriveItem[] }>(
      `/drive/special/approot:/${this.remoteBaseDir}:/delta`
    );
    const driveItems = res.value;
    // console.debug(driveItems);

    // unify everything to Entity — tolerate per-item parse failures with
    // warn-and-skip (same posture as walk()'s full enumeration).
    const unifiedContents: Entity[] = [];
    for (const x of driveItems) {
      try {
        const entity = fromDriveItemToEntity(x, this.remoteBaseDir);
        if (entity.key !== "/") {
          unifiedContents.push(entity);
        }
      } catch (e) {
        console.warn(
          "walkPartial: skipping item (parse failed)",
          e instanceof Error ? e.message : e,
          JSON.stringify(x).slice(0, 200)
        );
      }
    }

    return unifiedContents;
  }

  async stat(key: string): Promise<Entity> {
    await this._init();
    try {
      return await this._statFromRoot(getOnedrivePath(key, this.remoteBaseDir));
    } catch (e) {
      if (isHttp404(e)) {
        throw remoteNotFoundError(key);
      }
      throw e;
    }
  }

  async _statFromRoot(key: string): Promise<Entity> {
    // console.info(`remotePath=${remotePath}`);
    const rsp = await this._getJson<DriveItem>(
      `${key}?$select=id,cTag,eTag,fileSystemInfo,folder,file,name,parentReference,size`
    );
    // console.info(rsp);
    const driveItem = rsp;
    const res = fromDriveItemToEntity(driveItem, this.remoteBaseDir);
    // console.info(res);
    return res;
  }

  async mkdir(key: string, mtime?: number, ctime?: number): Promise<Entity> {
    if (!key.endsWith("/")) {
      throw Error(`you should not call mkdir on ${key}`);
    }
    await this._init();
    const uploadFolder = getOnedrivePath(key, this.remoteBaseDir);
    console.debug(`mkdir uploadFolder=${uploadFolder}`);
    return await this._mkdirFromRoot(uploadFolder, mtime, ctime);
  }

  async _mkdirFromRoot(
    key: string,
    mtime?: number,
    ctime?: number
  ): Promise<Entity> {
    // console.debug(`foldersCreatedBefore=${Array.from(this.foldersCreatedBefore)}`);
    if (this.foldersCreatedBefore.has(key)) {
      // created, pass
      // console.debug(`folder ${key} created.`)
    } else {
      // https://stackoverflow.com/questions/56479865/creating-nested-folders-in-one-go-onedrive-api
      // use PATCH to create folder recursively!!!
      const playload: DriveItem & {
        "@microsoft.graph.conflictBehavior": string;
      } = {
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      };
      const fileSystemInfo: FileSystemInfo = {};
      if (mtime !== undefined && mtime !== 0) {
        const mtimeStr = new Date(mtime).toISOString();
        fileSystemInfo["lastModifiedDateTime"] = mtimeStr;
      }
      if (ctime !== undefined && ctime !== 0) {
        const ctimeStr = new Date(ctime).toISOString();
        fileSystemInfo["createdDateTime"] = ctimeStr;
      }
      if (Object.keys(fileSystemInfo).length > 0) {
        playload["fileSystemInfo"] = fileSystemInfo;
      }
      await this._patchJson(key, playload);
    }
    const res = await this._statFromRoot(key);
    // Track created folders so main.ts merges them into prevRemoteEntities
    // (mirrors writeFile's uploadedEntities.push). Without this, a folder
    // created during sync is absent from the next sync's prev -> the
    // incremental delta's id/parent-chain fallback can't resolve it when it
    // reappears without parentReference.path. _statFromRoot returns
    // synthesizedFile:false + remoteId:x.id (fromDriveItemToEntity), so the
    // entity is prev-eligible.
    if (!res.synthesizedFile) {
      this.uploadedEntities.push(res);
    }
    return res;
  }

  async writeFile(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    expectedEtag?: string
  ): Promise<Entity> {
    if (key.endsWith("/")) {
      throw Error(`you should not call writeFile on ${key}`);
    }
    await this._init();
    const uploadFile = getOnedrivePath(key, this.remoteBaseDir);
    console.debug(`uploadFile=${uploadFile}`);
    const result = await this._writeFileFromRoot(
      uploadFile,
      content,
      mtime,
      ctime,
      key,
      this.onedriveConfig.emptyFile,
      expectedEtag
    );
    // Track non-synthesized uploads so main.ts can merge them into
    // prevRemoteEntities 鈥?prevents the next sync from seeing
    // just-uploaded files as "remote deleted" when the delta API
    // hasn't reflected the upload yet.
    if (!result.synthesizedFile) {
      this.uploadedEntities.push(result);
    }
    return result;
  }

  async _writeFileFromRoot(
    key: string,
    content: ArrayBuffer,
    mtime: number,
    ctime: number,
    origKey: string,
    emptyFile: "skip" | "error",
    // Sent as the If-Match precondition on both write paths: the small-file
    // PUT and the large-file createUploadSession (412 -> REMOTE_ETAG_MISMATCH).
    expectedEtag?: string
  ): Promise<Entity> {
    if (content.byteLength === 0) {
      if (emptyFile === "error") {
        throw Error(
          `${origKey}: Empty file is not allowed in OneDrive, and please write something in it.`
        );
      } else {
        return {
          key: origKey,
          keyRaw: origKey,
          mtimeSvr: mtime,
          mtimeCli: mtime,
          ctimeCli: ctime,
          size: 0,
          sizeRaw: 0,
          synthesizedFile: true,
          // hash: ?? // TODO
        };
      }
    }

    const ctimeStr = new Date(ctime).toISOString();
    const mtimeStr = new Date(mtime).toISOString();

    // no need to create parent folders firstly, cool!

    // hard code range size
    const MIN_UNIT = 327680; // bytes in msft doc, about 0.32768 MB
    const RANGE_SIZE = MIN_UNIT * 20; // about 6.5536 MB
    const DIRECT_UPLOAD_MAX_SIZE = 1000 * 1000 * 4; // 4 Megabyte

    if (content.byteLength < DIRECT_UPLOAD_MAX_SIZE) {
      // directly using put!
      // The PUT response already contains the full DriveItem, and the PATCH
      // response (if sent) also returns the updated DriveItem. Use that
      // instead of making a redundant _statFromRoot API call.
      let driveItem: DriveItem | UploadSession;
      driveItem = await this._putArrayBuffer(
        `${key}:/content?${new URLSearchParams({
          "@microsoft.graph.conflictBehavior": "replace",
        })}`,
        content,
        expectedEtag,
        origKey
      );
      if (mtime !== 0 && ctime !== 0) {
        try {
          driveItem = await this._patchJson<DriveItem>(key, {
            fileSystemInfo: {
              lastModifiedDateTime: mtimeStr,
              createdDateTime: ctimeStr,
            } as FileSystemInfo,
          });
        } catch (e) {
          // MVP conservative strategy (plan Task 5 / spec §6.4 note): this
          // PATCH carries no If-Match, but Obsidian's request() surfaces a
          // 412 as Error("Request failed, status 412"). Treat a 412-class
          // failure here as a concurrent-write conflict rather than risk
          // missing one. If Task 10's manual verification shows false
          // positives, revisit by sending the PUT response's fresh etag as
          // the PATCH's If-Match instead.
          if (
            classifyOneDriveWriteError(e) === "REMOTE_ETAG_MISMATCH" &&
            origKey
          ) {
            throw remoteEtagMismatchError(origKey);
          }
          throw e;
        }
      }
      try {
        return fromDriveItemToEntity(
          driveItem as DriveItem,
          this.remoteBaseDir
        );
      } catch {
        // Fallback: if the response lacks required fields, use stat
        return await this._statFromRoot(key);
      }
    } else {
      // upload large files!
      // ref: https://docs.microsoft.com/en-us/onedrive/developer/rest-api/api/driveitem_createuploadsession?view=odsp-graph-online

      // 1. create uploadSession
      // uploadFile already starts with /drive/special/approot:/${remoteBaseDir}
      // Body via the unit-tested builder (fileSystemInfo is only possible
      // via uploadSession); If-Match is a HEADER, documented as supported by
      // createUploadSession — sent only when the walk gave us an etag.
      const hasTimes = mtime !== 0 && ctime !== 0;
      const playload = _buildCreateUploadSessionBody(
        hasTimes ? mtimeStr : undefined,
        hasTimes ? ctimeStr : undefined,
        expectedEtag
      );
      const s = await this._postJson<UploadSession>(
        `${key}:/createUploadSession`,
        playload,
        expectedEtag !== undefined && expectedEtag !== ""
          ? { "If-Match": expectedEtag }
          : undefined
      );
      const uploadUrl = s.uploadUrl!;
      console.debug("uploadSession = ");
      console.debug(s);

      // 2. upload by ranges
      // convert to uint8
      const uint8 = new Uint8Array(content);

      // upload the ranges one by one
      // The last range PUT returns the completed DriveItem.
      let rangeStart = 0;
      let lastResult: DriveItem | UploadSession | undefined;
      while (rangeStart < uint8.byteLength) {
        lastResult = await this._putUint8ArrayByRange(
          uploadUrl,
          uint8,
          rangeStart,
          Math.min(rangeStart + RANGE_SIZE, uint8.byteLength),
          uint8.byteLength,
          origKey
        );
        rangeStart += RANGE_SIZE;
      }
      // Use the completed DriveItem from the last range PUT instead of
      // making a redundant _statFromRoot API call.
      try {
        if (lastResult && "name" in lastResult) {
          return fromDriveItemToEntity(lastResult, this.remoteBaseDir);
        }
      } catch {
        // Fallback below
      }
      return await this._statFromRoot(key);
    }
  }

  async readFile(key: string): Promise<ArrayBuffer> {
    await this._init();
    if (key.endsWith("/")) {
      throw new Error(`you should not call readFile on folder ${key}`);
    }
    const downloadFile = getOnedrivePath(key, this.remoteBaseDir);
    try {
      return await this._readFileFromRoot(downloadFile);
    } catch (e) {
      if (isHttp404(e)) {
        throw remoteNotFoundError(key);
      }
      throw e;
    }
  }

  /**
   * Combined stat + readFile: fetches metadata AND the pre-authenticated
   * download URL in a single Graph API call (one $select that includes both
   * regular properties and @microsoft.graph.downloadUrl), then downloads
   * the content. Saves one HTTP round-trip per file download vs. calling
   * stat() + readFile() separately.
   */
  async readFileWithStat(
    key: string
  ): Promise<{ entity: Entity; content: ArrayBuffer }> {
    await this._init();
    if (key.endsWith("/")) {
      throw new Error(`you should not call readFile on folder ${key}`);
    }
    const downloadFile = getOnedrivePath(key, this.remoteBaseDir);

    // Single GET: metadata fields + download URL annotation
    let rsp: DriveItemWithDownloadUrl;
    try {
      rsp = await this._getJson<DriveItemWithDownloadUrl>(
        `${downloadFile}?$select=id,name,size,fileSystemInfo,folder,file,parentReference,@microsoft.graph.downloadUrl`
      );
    } catch (e) {
      if (isHttp404(e)) {
        throw remoteNotFoundError(key);
      }
      throw e;
    }
    const driveItem = rsp;
    const entity = fromDriveItemToEntity(driveItem, this.remoteBaseDir);

    const downloadUrl = rsp["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) {
      // Fallback: if the annotation is absent (folders, some items),
      // use the two-call path.
      const content = await this._readFileFromRoot(downloadFile);
      return { entity, content };
    }

    // Download content using the pre-authenticated URL, retrying transient
    // transport errors (HTTP/2 stream resets carry no HTTP status).
    const content = await this._retryOnTransientError(() =>
      this._downloadByPreAuthUrl(downloadUrl)
    );
    return { entity, content };
  }

  /**
   * Download file content by its pre-authenticated `download.aspx` URL via
   * Obsidian's CORS-free requestUrl (graphRequest facade). The URL is
   * pre-authenticated, so NO headers are sent: the old renderer-fetch path
   * failed CORS when Authorization or Cache-Control was added, and
   * requestUrl needs neither. Non-2xx resolves with the error body (as the
   * old fetch path did); transport failures throw so the caller's
   * _retryOnTransientError wrapper can retry them.
   */
  private async _downloadByPreAuthUrl(
    downloadUrl: string
  ): Promise<ArrayBuffer> {
    return await (await graphRequest(downloadUrl, {})).arrayBuffer();
  }

  async _readFileFromRoot(key: string): Promise<ArrayBuffer> {
    const rsp = await this._getJson<{
      "@microsoft.graph.downloadUrl"?: string;
    }>(`${key}?$select=@microsoft.graph.downloadUrl`);
    const downloadUrl: string | undefined = rsp["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) {
      // Fallback: when the pre-auth download URL annotation is absent
      // (not reliably returned for OneDrive App Folder), use the standard
      // /content endpoint which returns a 302 redirect to the download URL.
      return await this._retryOnTransientError(async () => {
        const res = await graphRequest(this._buildUrl(`${key}:/content`), {
          headers: {
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        });
        if (res.status === 429) {
          throw Object.assign(new Error("OneDrive rate limited (HTTP 429)"), {
            status: 429,
            headers: res.headers,
          });
        }
        if (!res.ok) {
          const err = new Error(
            `OneDrive content download failed: ${res.status}`
          );
          Object.assign(err, { status: res.status });
          throw err;
        }
        return await res.arrayBuffer();
      });
    }
    // Retry the download itself: a mid-body HTTP/2 stream reset
    // (net::ERR_HTTP2_PROTOCOL_ERROR) has no HTTP status, so this wrapper is
    // the only layer that can recover it. Retries run seconds apart, well
    // within the pre-auth URL's minute-scale validity.
    return await this._retryOnTransientError(() =>
      this._downloadByPreAuthUrl(downloadUrl)
    );
  }

  /** Cache: OneDrive path of parent folder → Graph item id.
   *  Deduplicates parent-dir stat calls when multiple files move into
   *  the same directory. Safe without invalidation because OneDrive item
   *  ids are stable; a renamed folder's old path is a natural cache miss. */
  private _parentRemoteIdCache = new Map<string, string>();

  // NOTE: This method is called by the sync algorithm's move dispatch
  // (sync.ts dispatchOperationToActualV3, "local_moved_then_rename_remote").
  // The PATCH request is built by the pure, unit-tested `_buildRenameRequest`.
  // When the parent directory changed (a move), we stat the new parent folder
  // to get its Graph `id` — the API rejects `parentReference.path` in PATCH,
  // only `parentReference.id` is accepted. When `opts.sourceRemoteId` is
  // provided (from delta/matchMoves), the old-item stat is skipped. The
  // new-parent stat is deduplicated via `_parentRemoteIdCache`.
  async rename(key1: string, key2: string, opts?: RenameOpts): Promise<void> {
    if (key1 === "" || key1 === "/" || key2 === "" || key2 === "/") {
      return;
    }
    await this._init();
    const { url, name, parentChanged, newParentKey } = _buildRenameRequest(
      key1,
      key2,
      this.remoteBaseDir
    );
    if (parentChanged) {
      // Move: PATCH by item-id (NOT by path). Path-based PATCH with
      // parentReference conflicts — the URL encodes the old parent dir
      // but the body says move to a new one → 400. Item-id addressing
      // has no path conflict. rclone uses the same approach.
      // Optimization: use sourceRemoteId from opts (delta/matchMoves)
      // to skip the old-item stat, and cache parent-dir stats.
      let oldRemoteId = opts?.sourceRemoteId;
      if (oldRemoteId === undefined) {
        const oldItem = await this._statFromRoot(
          getOnedrivePath(key1, this.remoteBaseDir)
        );
        oldRemoteId = oldItem.remoteId;
      }
      const newParentPath = getOnedrivePath(newParentKey, this.remoteBaseDir);
      const cachedParentId =
        opts?.targetParentRemoteId ??
        this._parentRemoteIdCache.get(newParentPath);
      let newParentRemoteId: string;
      if (cachedParentId !== undefined) {
        newParentRemoteId = cachedParentId;
      } else {
        const newParent = await this._statFromRoot(newParentPath);
        newParentRemoteId = newParent.remoteId!;
        this._parentRemoteIdCache.set(newParentPath, newParentRemoteId);
      }
      const itemIdUrl = `/drive/items/${oldRemoteId}`;
      console.debug(
        `rename move: oldId=${oldRemoteId}, newParentId=${newParentRemoteId}, name=${name}`
      );
      await this._patchJson(itemIdUrl, {
        name,
        parentReference: { id: newParentRemoteId },
      });
    } else {
      // Pure rename (same dir): path-based PATCH with just name is fine
      console.debug(`rename in-place: name=${name}, url=${url}`);
      await this._patchJson(url, { name });
    }
  }

  /** Send up to 20 PATCH operations in a single $batch HTTP request.
   *  Each op is { id, url, body }. Returns per-op results correlated by id.
   *  Chunks automatically if >20 ops (Graph $batch hard limit).
   *  Contract re-audit (AGENTS.md call-mode change rule): the $batch
   *  sub-response wraps the SAME driveItem resource as the unbatched
   *  PATCH — id, name, eTag, parentReference are all present. Rename
   *  does not read the PATCH response body, so field-availability is
   *  not a concern here; the only contract difference is the response
   *  envelope shape ({ responses: [{ id, status, body }] }). */
  private async _batchPatch(
    ops: { id: string; url: string; body: unknown }[]
  ): Promise<Map<string, { status: number; body?: BatchSubResponseBody }>> {
    const results = new Map<
      string,
      { status: number; body?: BatchSubResponseBody }
    >();
    const BATCH_SIZE = 20;
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const chunk = ops.slice(i, i + BATCH_SIZE);
      const batchUrl = this._buildUrl("/$batch");
      console.debug(`batchPatch: sending ${chunk.length} ops in one request`);
      const response = await this._retryOnTransientError(async () => {
        return JSON.parse(
          await request({
            url: batchUrl,
            method: "POST",
            contentType: "application/json",
            body: JSON.stringify({
              requests: chunk.map((op) => ({
                id: op.id,
                method: "PATCH",
                url: op.url,
                headers: { "Content-Type": "application/json" },
                body: op.body,
              })),
            }),
            headers: {
              Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
              "Content-Type": "application/json",
            },
          })
        ) as { responses?: BatchSubResponse[] };
      });
      for (const resp of response.responses ?? []) {
        results.set(resp.id, {
          status: resp.status,
          body: resp.body,
        });
      }
    }
    return results;
  }

  /** Batch rename/move: resolve all remoteIds, then send PATCH operations
   *  in a single $batch request. Falls back to individual stat for ops
   *  without sourceRemoteId. Results are returned per-op, correlated by
   *  index (NOT by Graph id — caller must consume in order). */
  async batchRename(ops: BatchRenameOp[]): Promise<BatchRenameResult[]> {
    if (ops.length === 0) return [];
    await this._init();

    const results: BatchRenameResult[] = ops.map(() => ({
      ok: false,
      status: 0,
    }));
    const patchOps: {
      id: string;
      url: string;
      body: { name: string; parentReference?: { id: string } };
      opIndex: number;
    }[] = [];

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (
        op.key1 === "" ||
        op.key1 === "/" ||
        op.key2 === "" ||
        op.key2 === "/"
      ) {
        results[i] = { ok: true, status: 200 };
        continue;
      }
      const { name, parentChanged, newParentKey } = _buildRenameRequest(
        op.key1,
        op.key2,
        this.remoteBaseDir
      );

      // Resolve sourceRemoteId (stat fallback if not provided)
      let oldRemoteId = op.sourceRemoteId;
      if (oldRemoteId === undefined) {
        try {
          const oldItem = await this._statFromRoot(
            getOnedrivePath(op.key1, this.remoteBaseDir)
          );
          oldRemoteId = oldItem.remoteId ?? undefined;
        } catch (e: unknown) {
          results[i] = {
            ok: false,
            status: 0,
            error: e instanceof Error ? e : new Error(String(e)),
          };
          continue;
        }
      }
      if (oldRemoteId === undefined) {
        results[i] = {
          ok: false,
          status: 0,
          error: new Error(`stat returned no remoteId for ${op.key1}`),
        };
        continue;
      }

      if (parentChanged) {
        // Move: resolve target parent remoteId (cache or stat)
        const newParentPath = getOnedrivePath(newParentKey, this.remoteBaseDir);
        const cachedParentId =
          op.targetParentRemoteId ??
          this._parentRemoteIdCache.get(newParentPath);
        let newParentRemoteId: string;
        if (cachedParentId !== undefined) {
          newParentRemoteId = cachedParentId;
        } else {
          try {
            const newParent = await this._statFromRoot(newParentPath);
            newParentRemoteId = newParent.remoteId!;
            this._parentRemoteIdCache.set(newParentPath, newParentRemoteId);
          } catch (e: unknown) {
            results[i] = {
              ok: false,
              status: 0,
              error: e instanceof Error ? e : new Error(String(e)),
            };
            continue;
          }
        }
        patchOps.push({
          id: String(i),
          url: `/drive/items/${oldRemoteId}`,
          body: {
            name,
            parentReference: { id: newParentRemoteId },
          },
          opIndex: i,
        });
      } else {
        // Pure rename: item-id PATCH with just name
        patchOps.push({
          id: String(i),
          url: `/drive/items/${oldRemoteId}`,
          body: { name },
          opIndex: i,
        });
      }
    }

    // Batch the collected PATCH operations
    if (patchOps.length > 0) {
      const batchResults = await this._batchPatch(
        patchOps.map(({ id, url, body }) => ({ id, url, body }))
      );
      for (const patchOp of patchOps) {
        const result = batchResults.get(patchOp.id);
        if (result === undefined) {
          results[patchOp.opIndex] = {
            ok: false,
            status: 0,
            error: new Error("batch response missing for this op"),
          };
        } else {
          const ok = result.status >= 200 && result.status < 300;
          results[patchOp.opIndex] = {
            ok,
            status: result.status,
            error: ok
              ? undefined
              : new Error(
                  `batch PATCH failed: ${result.status}` +
                    (result.body?.error?.message
                      ? ` — ${result.body.error.message}`
                      : "")
                ),
          };
          // L1: update prevRemoteEntities — old key → deletedRemotelyKeys,
          // stat new path → uploadedEntities. Without this, batchRename
          // (PATCH) leaves stale old-key entries in prevRemoteEntities →
          // the next sync's merged state is inconsistent → "keptFolder no
          // decisions" crash. rm() already adds to deletedRemotelyKeys;
          // batchRename must do the same for moved items.
          if (ok) {
            const op = ops[patchOp.opIndex];
            this.deletedRemotelyKeys.add(op.key1);
            try {
              const newEntity = await this._statFromRoot(
                getOnedrivePath(op.key2, this.remoteBaseDir)
              );
              if (!newEntity.synthesizedFile) {
                this.uploadedEntities.push(newEntity);
              }
            } catch {
              // best-effort — next sync's delta will add the new entry
            }
          }
        }
      }
    }

    return results;
  }

  async rm(key: string): Promise<void> {
    if (key === "" || key === "/") {
      return;
    }
    const remoteFileName = getOnedrivePath(key, this.remoteBaseDir);

    await this._init();
    await this._deleteJson(remoteFileName);
    // Track for proactive prevRemoteEntities update 鈥?see FakeFs.deletedRemotelyKeys
    this.deletedRemotelyKeys.add(key);
  }

  async checkConnect(callbackFunc?: (err: unknown) => void): Promise<boolean> {
    try {
      const k = await this.getUserDisplayName();
      if (k === "<unknown display name>") {
        throw Error(`unknown display name!`);
      }
    } catch (err) {
      console.debug(err);
      callbackFunc?.(err);
      return false;
    }

    return await this.checkConnectCommonOps(callbackFunc);
  }

  async getUserDisplayName() {
    await this._init();
    const res = await this._getJson<User>("/me?$select=displayName");
    return res.displayName || "<unknown display name>";
  }

  /**
   *
   * https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-protocols-oidc#send-a-sign-out-request
   * https://docs.microsoft.com/en-us/graph/api/user-revokesigninsessions
   * https://docs.microsoft.com/en-us/graph/api/user-invalidateallrefreshtokens
   */
  async revokeAuth() {
    // await this._init();
    // await this._postJson("/me/revokeSignInSessions", {});
    throw new Error("Method not implemented.");
  }

  async getRevokeAddr() {
    return "https://account.live.com/consent/Manage";
  }

  allowEmptyFile(): boolean {
    return false;
  }
}
