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
  COMMAND_CALLBACK_ONEDRIVE,
  DEFAULT_CONTENT_TYPE,
  type Entity,
  OAUTH2_FORCE_EXPIRE_MILLISECONDS,
  ONEDRIVE_AUTHORITY,
  ONEDRIVE_CLIENT_ID,
  type OnedriveConfig,
} from "./baseTypes";
import { VALID_REQURL } from "./baseTypes";
import { classifyDeltaItems, mergeDeltaWithPrevState } from "./deltaMerge";
import { fromDriveItemToEntity } from "./driveItemConvert";
import { FakeFs } from "./fsAll";
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
function isHttp404(e: any): boolean {
  const status: number | undefined = e?.status ?? e?.response?.status;
  if (status === 404) return true;
  if (typeof e?.message === "string" && e.message.includes("status 404")) {
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
function extractHttpStatus(e: any): number | undefined {
  const fromProps: unknown = e?.status ?? e?.response?.status;
  if (typeof fromProps === "number") {
    return fromProps;
  }
  if (typeof e?.message === "string") {
    const m = e.message.match(/(?:status\s+|:\s+)(\d{3})/i);
    if (m !== null) {
      return Number.parseInt(m[1], 10);
    }
  }
  return undefined;
}

/**
 * Build a recognizable error for the "remote file was deleted between the
 * walk and the stat/download" race condition. The sync collects these in an
 * AggregateError; main.ts groups them into a single friendly notice.
 */
function remoteNotFoundError(key: string): Error {
  const err = new Error(
    `Remote file not found (deleted since sync started): ${key}`
  );
  (err as any).code = "REMOTE_NOT_FOUND";
  (err as any).key = key;
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
  (err as any).code = "REMOTE_ETAG_MISMATCH";
  (err as any).key = key;
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
  e: any
): "REMOTE_ETAG_MISMATCH" | "REMOTE_NOT_FOUND" | null {
  const status = extractHttpStatus(e);
  if (status === 412) return "REMOTE_ETAG_MISMATCH";
  if (status === 404) return "REMOTE_NOT_FOUND";
  return null;
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
  const item: any = { "@microsoft.graph.conflictBehavior": "replace" };
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
  errorCallBack: any
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
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        code: authCode,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }).toString(),
    });

    const rsp2 = JSON.parse(rsp1);
    // console.info(rsp2);

    if (rsp2.error !== undefined) {
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
        tenant: "consumers",
        client_id: clientID,
        scope: SCOPES.join(" "),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });

    const rsp2 = JSON.parse(rsp1);
    // console.info(rsp2);

    if (rsp2.error !== undefined) {
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
  saveUpdatedConfigFunc: () => Promise<any> | undefined
) => {
  console.info("start updating local info of OneDrive token");
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

  console.info("finish updating local info of Onedrive token");
};

////////////////////////////////////////////////////////////////////////////////
// Other usual common methods
////////////////////////////////////////////////////////////////////////////////

const getOnedrivePath = (fileOrFolderPath: string, remoteBaseDir: string) => {
  // https://docs.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder?view=odsp-graph-online
  const prefix = `/drive/special/approot:/${remoteBaseDir}`;

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
  saveUpdatedConfigFunc: () => Promise<any>;
  private refreshPromise: Promise<string> | null = null;
  constructor(
    onedriveConfig: OnedriveConfig,
    saveUpdatedConfigFunc: () => Promise<any>
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
    if ((r as any).error !== undefined) {
      const r2 = r as AccessCodeResponseFailedType;
      throw Error(
        `Error while refreshing accessToken: ${r2.error}, ${r2.error_codes}: ${r2.error_description}`
      );
    }
    const r2 = r as AccessCodeResponseSuccessfulType;
    this.onedriveConfig.accessToken = r2.access_token;
    this.onedriveConfig.refreshToken = r2.refresh_token!;
    this.onedriveConfig.accessTokenExpiresInSeconds = r2.expires_in;
    this.onedriveConfig.accessTokenExpiresAtTime =
      currentTs + r2.expires_in * 1000 - 60 * 2 * 1000;
    await this.saveUpdatedConfigFunc();
    console.info("Onedrive accessToken updated");
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

export class FakeFsOnedrive extends FakeFs {
  kind: "onedrive";
  onedriveConfig: OnedriveConfig;
  remoteBaseDir: string;
  vaultFolderExists: boolean;
  authGetter: MyAuthProvider;
  saveUpdatedConfigFunc: () => Promise<any>;
  foldersCreatedBefore: Set<string>;
  /**
   * The full remote entity list from the previous sync's walk().
   * When present AND deltaLink is set, walk() uses the OneDrive delta API
   * incrementally (only changed items) and merges with this state,
   * avoiding a full re-enumeration of all remote files.
   */
  prevRemoteEntities?: Entity[];
  /**
   * The result of the most recent walk() call. main.ts saves this to the
   * DB after sync so the next sync can use it for incremental enumeration.
   */
  lastWalkResult?: Entity[];

  constructor(
    onedriveConfig: OnedriveConfig,
    vaultName: string,
    saveUpdatedConfigFunc: () => Promise<any>,
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
      const k = await this._getJson("/drive/special/approot/children");
      // console.debug(k);
      this.vaultFolderExists =
        (k.value as DriveItem[]).filter((x) => x.name === this.remoteBaseDir)
          .length > 0;
      if (!this.vaultFolderExists) {
        console.info(`remote does not have folder /${this.remoteBaseDir}`);
        await this._postJson("/drive/special/approot/children", {
          name: `${this.remoteBaseDir}`,
          folder: {},
          "@microsoft.graph.conflictBehavior": "replace",
        });
        console.info(`remote folder /${this.remoteBaseDir} created`);
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
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (e: any) {
        lastError = e;
        const status = extractHttpStatus(e);
        const isThrottled = status === 429;
        const isTransientServerError =
          status !== undefined &&
          (status === 500 ||
            status === 502 ||
            status === 503 ||
            status === 504);

        if (!isThrottled && !isTransientServerError) {
          throw e;
        }
        if (attempt >= maxRetries) {
          throw e;
        }
        // Retry-After (seconds) is authoritative when present; otherwise
        // fall back to exponential backoff, capped to avoid unbounded waits.
        const retryAfterRaw: string | undefined =
          (e?.headers as any)?.["Retry-After"] ||
          (e?.headers as any)?.["retry-after"] ||
          (e?.response?.headers as any)?.["Retry-After"];
        const retryAfterSec = retryAfterRaw
          ? Number.parseInt(retryAfterRaw, 10)
          : Math.min(2 ** attempt, 10);
        const waitMs = retryAfterSec * 1000;
        console.warn(
          `Graph API transient error (status ${status ?? "unknown"}), ` +
            `waiting ${retryAfterSec}s (attempt ${attempt + 1}/${maxRetries})`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError;
  }

  async _getJson(pathFragOrig: string) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`getJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError(async () => {
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
      );
    });
  }

  async _postJson(
    pathFragOrig: string,
    payload: any,
    headers?: Record<string, string>
  ) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`postJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError(async () => {
      return JSON.parse(
        await request({
          url: theUrl,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(payload),
          headers: {
            // Caller-supplied headers (e.g. If-Match precondition);
            // Authorization is always set here with a fresh token.
            ...headers,
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        })
      );
    });
  }

  async _patchJson(pathFragOrig: string, payload: any) {
    const theUrl = this._buildUrl(pathFragOrig);
    console.debug(`patchJson, theUrl=${theUrl}`);
    return await this._retryOnTransientError(async () => {
      return JSON.parse(
        await request({
          url: theUrl,
          method: "PATCH",
          contentType: "application/json",
          body: JSON.stringify(payload),
          headers: {
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        })
      );
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
        } catch (e: any) {
          const status: number | undefined = e?.status ?? e?.response?.status;
          // 404 = already deleted, treat as success (idempotent delete)
          if (status === 404) {
            return;
          }
          throw e;
        }
      } else {
        const res = await fetch(theUrl, {
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
          throw { status: 429, headers: res.headers } as any;
        }
        if (!res.ok && res.status !== 204) {
          const body = await res.text().catch(() => "");
          const err = new Error(
            `OneDrive DELETE failed: ${res.status} ${pathFragOrig} ${body}`
          );
          (err as any).status = res.status;
          (err as any).headers = res.headers;
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
      // TODO:
      // 20220401: On Android, requestUrl has issue that text becomes base64.
      // Use fetch everywhere instead!
      // biome-ignore lint/correctness/noConstantCondition: hard code
      if (false /*VALID_REQURL*/) {
        const res = await requestUrl({
          url: theUrl,
          method: "PUT",
          body: payload,
          contentType: DEFAULT_CONTENT_TYPE,
          headers: {
            "Content-Type": DEFAULT_CONTENT_TYPE,
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        });
        return res.json as DriveItem | UploadSession;
      } else {
        // _buildPutRequest is the unit-tested header builder (adds If-Match
        // only when ifMatch is a non-empty string); Authorization is filled
        // here with a fresh token on every (re)attempt.
        const req = _buildPutRequest(theUrl, payload, ifMatch);
        req.headers.Authorization = `Bearer ${await this.authGetter.getAccessToken()}`;
        const res = await fetch(theUrl, {
          method: "PUT",
          body: payload,
          headers: req.headers,
        });
        if (res.status === 429) {
          throw { status: 429, headers: res.headers } as any;
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
          throw new Error(
            `OneDrive PUT failed: ${res.status} ${theUrl} ${body}`
          );
        }
        return (await res.json()) as DriveItem | UploadSession;
      }
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
      // TODO:
      // 20220401: On Android, requestUrl has issue that text becomes base64.
      // Use fetch everywhere instead!
      // biome-ignore lint/correctness/noConstantCondition: hard code
      if (false /*VALID_REQURL*/) {
        const res = await requestUrl({
          url: theUrl,
          method: "PUT",
          body: bufferToArrayBuffer(payload.subarray(rangeStart, rangeEnd)),
          contentType: DEFAULT_CONTENT_TYPE,
          headers: {
            // no "Content-Length" allowed here
            "Content-Range": `bytes ${rangeStart}-${rangeEnd - 1}/${size}`,
            /* "Cache-Control": "no-cache", not allowed here!!! */
          },
        });
        return res.json as DriveItem | UploadSession;
      } else {
        const res = await fetch(theUrl, {
          method: "PUT",
          body: payload.subarray(
            rangeStart,
            rangeEnd
          ) as Uint8Array<ArrayBuffer>,
          headers: {
            "Content-Length": `${rangeEnd - rangeStart}`,
            "Content-Range": `bytes ${rangeStart}-${rangeEnd - 1}/${size}`,
            "Content-Type": DEFAULT_CONTENT_TYPE,
            /* "Cache-Control": "no-cache", not allowed here!!! */
          },
        });
        if (res.status === 429) {
          throw { status: 429, headers: res.headers } as any;
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
      }
    });
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

    let res: any;
    try {
      res = await this._getJson(startUrl);
    } catch (e) {
      if (canIncremental) {
        // deltaLink may have expired 鈥?fall back to full enumeration
        console.info(
          "deltaLink query failed, falling back to full enumeration",
          e
        );
        canIncremental = false;
        startUrl = buildDeltaStartUrl(false, "", this.remoteBaseDir);
        res = await this._getJson(startUrl);
      } else {
        throw e;
      }
    }

    const driveItems = res.value as DriveItem[];

    while (NEXT_LINK_KEY in res) {
      res = await this._getJson(res[NEXT_LINK_KEY]);
      driveItems.push(...(res.value as DriveItem[]));
    }

    // Save deltaLink for next sync's incremental query
    if (DELTA_LINK_KEY in res) {
      this.onedriveConfig.deltaLink = res[DELTA_LINK_KEY];
      await this.saveUpdatedConfigFunc();
    }

    if (canIncremental && this.prevRemoteEntities) {
      // Merge incremental delta results with the previous full state.
      // classifyDeltaItems handles BOTH @removed and the `deleted` facet 鈥?      // Graph uses either marker to signal deletions depending on tenant.
      // Checking only @removed leaks stale entries 鈫?404 AggregateErrors.
      const { deltaEntities, deletedKeys, skippedAddedOrModified } =
        classifyDeltaItems(
          driveItems,
          this.remoteBaseDir,
          fromDriveItemToEntity
        );

      // Self-heal for silently-skipped added/modified items: unlike the 404
      // path (handled in main.ts), a parse failure here produces NO error
      // signal, so the item would be permanently lost from the merged list
      // until the deltaLink expires. Invalidate deltaLink so the NEXT sync
      // does a full re-enumeration (which, with the full-walk tolerance
      // above, re-fetches the item cleanly). The current sync proceeds with
      // a minor gap (a possibly-stale entry → at most a redundant upload);
      // next sync recovers fully.
      if (skippedAddedOrModified > 0) {
        console.warn(
          `walk: ${skippedAddedOrModified} added/modified delta item(s) could not be parsed — ` +
            "invalidating deltaLink; next sync will do a full re-enumeration."
        );
        this.onedriveConfig.deltaLink = "";
        await this.saveUpdatedConfigFunc();
      }

      const merged = mergeDeltaWithPrevState(
        this.prevRemoteEntities,
        deltaEntities,
        deletedKeys
      );
      this.lastWalkResult = merged;
      this.lastWalkDeltaCount = driveItems.length;
      return merged;
    } else {
      // Full enumeration — convert all items to entities. Tolerate per-item
      // parse failures (e.g. parentReference.path omitted for a
      // special-folder-relative item) with a warn-and-skip, mirroring
      // classifyDeltaItems' incremental-path tolerance — otherwise a single
      // unparseable item would crash the whole sync, and the self-heal
      // fallback (which re-runs full enumeration after a 404) would be
      // fragile against the very items that triggered self-heal.
      const unifiedContents: Entity[] = [];
      for (const x of driveItems) {
        try {
          const entity = fromDriveItemToEntity(x, this.remoteBaseDir);
          if (entity.key !== "/") {
            unifiedContents.push(entity);
          }
        } catch (e) {
          console.warn(
            "walk: skipping item in full enumeration (parse failed)",
            e instanceof Error ? e.message : e,
            JSON.stringify(x).slice(0, 200)
          );
        }
      }

      this.lastWalkResult = unifiedContents;
      this.lastWalkDeltaCount = undefined;
      return unifiedContents;
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
    const res = await this._getJson(
      `/drive/special/approot:/${this.remoteBaseDir}:/delta`
    );
    const driveItems = res.value as DriveItem[];
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
    const rsp = await this._getJson(
      `${key}?$select=cTag,eTag,fileSystemInfo,folder,file,name,parentReference,size`
    );
    // console.info(rsp);
    const driveItem = rsp as DriveItem;
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
      const playload: any = {
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      };
      const fileSystemInfo: Record<string, string> = {};
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
      let driveItem: any;
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
          driveItem = await this._patchJson(key, {
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
      const playload: any = _buildCreateUploadSessionBody(
        hasTimes ? mtimeStr : undefined,
        hasTimes ? ctimeStr : undefined,
        expectedEtag
      );
      const s: UploadSession = await this._postJson(
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
      let lastResult: any;
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
          return fromDriveItemToEntity(
            lastResult as DriveItem,
            this.remoteBaseDir
          );
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
    let rsp: any;
    try {
      rsp = await this._getJson(
        `${downloadFile}?$select=id,name,size,fileSystemInfo,folder,file,parentReference,@microsoft.graph.downloadUrl`
      );
    } catch (e) {
      if (isHttp404(e)) {
        throw remoteNotFoundError(key);
      }
      throw e;
    }
    const driveItem = rsp as DriveItem;
    const entity = fromDriveItemToEntity(driveItem, this.remoteBaseDir);

    const downloadUrl: string = rsp["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) {
      // Fallback: if the annotation is absent (folders, some items),
      // use the two-call path.
      const content = await this._readFileFromRoot(downloadFile);
      return { entity, content };
    }

    // Download content using the pre-authenticated URL
    let content: ArrayBuffer;
    // biome-ignore lint/correctness/noConstantCondition: hard code
    if (false /*VALID_REQURL*/) {
      content = (
        await requestUrl({
          url: downloadUrl,
          headers: { "Cache-Control": "no-cache" },
        })
      ).arrayBuffer;
    } else {
      try {
        content = await (
          await fetch(downloadUrl, { cache: "no-store" })
        ).arrayBuffer();
      } catch (e) {
        // CORS fallback
        content = (
          await requestUrl({
            url: downloadUrl,
            headers: { "Cache-Control": "no-cache" },
          })
        ).arrayBuffer;
      }
    }
    return { entity, content };
  }

  async _readFileFromRoot(key: string): Promise<ArrayBuffer> {
    const rsp = await this._getJson(
      `${key}?$select=@microsoft.graph.downloadUrl`
    );
    const downloadUrl: string = rsp["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) {
      // Fallback: when the pre-auth download URL annotation is absent
      // (not reliably returned for OneDrive App Folder), use the standard
      // /content endpoint which returns a 302 redirect to the download URL.
      return await this._retryOnTransientError(async () => {
        const res = await fetch(this._buildUrl(`${key}:/content`), {
          headers: {
            Authorization: `Bearer ${await this.authGetter.getAccessToken()}`,
          },
        });
        if (res.status === 429) {
          throw { status: 429, headers: res.headers } as any;
        }
        if (!res.ok) {
          const err = new Error(
            `OneDrive content download failed: ${res.status}`
          );
          (err as any).status = res.status;
          throw err;
        }
        return await res.arrayBuffer();
      });
    }
    // biome-ignore lint/correctness/noConstantCondition: <explanation>
    if (false /*VALID_REQURL*/) {
      const content = (
        await requestUrl({
          url: downloadUrl,
          headers: { "Cache-Control": "no-cache" },
        })
      ).arrayBuffer;
      return content;
    } else {
      // so strange, sometimes (!!!)
      // we cannot download the file because of CORS
      try {
        // cannot set no-cache here, will have cors error
        const content = await (
          await fetch(downloadUrl, { cache: "no-store" })
        ).arrayBuffer();
        return content;
      } catch (e) {
        // let's try again to bypass the CORS
        const content = (
          await requestUrl({
            url: downloadUrl,
            headers: { "Cache-Control": "no-cache" },
          })
        ).arrayBuffer;
        return content;
      }
    }
  }

  // WARNING: This method is NOT called by the sync algorithm (sync.ts).
  // The implementation is incorrect: it passes a full Graph API path as
  // the `name` field, but the API expects just the new filename (e.g.
  // "new.md", not "/drive/special/approot:/vault/folder/new.md").
  // Fix before enabling remote rename in the sync flow.
  async rename(key1: string, key2: string): Promise<void> {
    if (key1 === "" || key1 === "/" || key2 === "" || key2 === "/") {
      return;
    }
    const remoteFileName1 = getOnedrivePath(key1, this.remoteBaseDir);
    const remoteFileName2 = getOnedrivePath(key2, this.remoteBaseDir);
    await this._init();
    await this._patchJson(remoteFileName1, {
      name: remoteFileName2,
    });
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

  async checkConnect(callbackFunc?: any): Promise<boolean> {
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
    const res: User = await this._getJson("/me?$select=displayName");
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
