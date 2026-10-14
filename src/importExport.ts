import cloneDeep from "lodash/cloneDeep";
import QRCode from "qrcode";

import {
  COMMAND_URI,
  CONFIG_SCHEMA_VERSION,
  type OnedriveConfig,
  type RemotelySavePluginSettings,
  type UriParams,
} from "./baseTypes";

export interface QrResult {
  rawUri: string;
  /** QR data URL, or undefined when the URI is too large to fit a QR code. */
  imgUri?: string;
}

/** Strip device-specific OneDrive secrets in place so the exported config
 *  copy is credential-free (mirrors main.ts stripOnedriveAuthInPlace, kept
 *  here as a pure helper so this module stays side-effect free). */
const stripOnedriveSecretsInPlace = (o: OnedriveConfig) => {
  o.accessToken = "";
  o.refreshToken = "";
  o.accessTokenExpiresInSeconds = 0;
  o.accessTokenExpiresAtTime = 0;
  o.deltaLink = "";
  o.username = "";
  o.credentialsShouldBeDeletedAtTime = 0;
};

/** Render a QR for the URI at the lowest error-correction level (max capacity);
 *  return undefined if it won't fit, so callers can fall back to copy-URI. */
const toQrImg = async (rawUri: string): Promise<string | undefined> => {
  try {
    return await QRCode.toDataURL(rawUri, { errorCorrectionLevel: "L" });
  } catch (e) {
    console.warn("QR too large, returning URI only:", e);
    return undefined;
  }
};

const buildUri = (func: string, vault: string, version: string, data: string) =>
  `obsidian://${COMMAND_URI}?func=${func}&sv=${CONFIG_SCHEMA_VERSION}` +
  `&version=${encodeURIComponent(version)}&vault=${encodeURIComponent(vault)}` +
  `&data=${data}`;

/**
 * Export the credential-free preferences — exactly what data.json holds.
 * OneDrive auth tokens, deltaLink, username and the vault password are
 * stripped (they live in IndexedDB and are transferred separately via
 * exportCredentialsUri). This QR is share-safe.
 */
export const exportConfigUri = async (
  settings: RemotelySavePluginSettings,
  currentVaultName: string,
  pluginVersion: string
): Promise<QrResult> => {
  const settings2 = cloneDeep(settings) as Partial<RemotelySavePluginSettings>;
  stripOnedriveSecretsInPlace(settings2.onedrive!);
  settings2.password = "";
  delete settings2.vaultRandomID;
  const data = encodeURIComponent(JSON.stringify(settings2));
  const rawUri = buildUri("settings", currentVaultName, pluginVersion, data);
  return { rawUri, imgUri: await toQrImg(rawUri) };
};

/** Fields carried by the credentials QR — everything needed to use the
 *  OneDrive connection on a new device. Excludes per-device / short-lived
 *  junk: deltaLink is per-device, accessToken is short-lived. */
export interface CredentialsPayload {
  refreshToken: string;
  password: string;
  username: string;
  credentialsShouldBeDeletedAtTime?: number;
  clientID?: string;
  authority?: string;
}

/**
 * Export the OneDrive connection credentials (refreshToken + vault password +
 * username + expiry + clientID/authority). Sensitive — must never be shared
 * like the config QR. Kept separate from the config QR so the common export
 * stays small and share-safe.
 */
export const exportCredentialsUri = async (
  payload: CredentialsPayload,
  currentVaultName: string,
  pluginVersion: string
): Promise<QrResult> => {
  const data = encodeURIComponent(JSON.stringify(payload));
  const rawUri = buildUri(
    "onedrive_auth",
    currentVaultName,
    pluginVersion,
    data
  );
  return { rawUri, imgUri: await toQrImg(rawUri) };
};

/**
 * @deprecated Use exportConfigUri (credential-free) / exportCredentialsUri.
 * Kept as a thin wrapper so the legacy single-QR modal keeps compiling until
 * the two-section modal lands.
 */
export const exportQrCodeUri = async (
  settings: RemotelySavePluginSettings,
  currentVaultName: string,
  pluginVersion: string
): Promise<QrResult> => {
  return exportConfigUri(settings, currentVaultName, pluginVersion);
};

export interface ProcessQrCodeResultType {
  status: "error" | "ok";
  message: string;
  /** "settings" (config) or "onedrive_auth" (credentials). */
  func?: string;
  /** The JSON-parsed payload (a settings object for func=settings, a
   *  CredentialsPayload for func=onedrive_auth). */
  parsed?: Record<string, unknown>;
  /** Schema version from the URI, for the caller to gate on. */
  sv?: string;
}

/**
 * we also support directly parse the uri, instead of relying on web browser.
 * Accepts both func=settings and func=onedrive_auth.
 * @param input
 */
export const parseUriByHand = (input: string) => {
  if (!input.startsWith(`obsidian://${COMMAND_URI}?func=`)) {
    throw Error(`not valid string`);
  }

  const k = new URL(input);
  const output = Object.fromEntries(k.searchParams);
  return output;
};

/**
 * Validate + parse an imported URI. Does NOT apply the result — the caller
 * (RemotelySavePlugin.applyImportedUriParams) dispatches on `func` and does
 * the merge routing. Schema-version mismatch is surfaced for the caller to
 * turn into a localized Notice.
 */
export const importQrCodeUri = (
  inputParams: UriParams,
  currentVaultName: string
): ProcessQrCodeResultType => {
  const params = inputParams;
  if (params.func === undefined || params.func === "") {
    return {
      status: "error",
      message: `the uri is not for importing settings/credentials`,
    };
  }
  if (params.func !== "settings" && params.func !== "onedrive_auth") {
    return { status: "error", message: `unknown func: ${params.func}` };
  }
  if (params.vault === undefined) {
    return { status: "error", message: `missing vault` };
  }
  if (params.vault !== currentVaultName) {
    return {
      status: "error",
      message: `the target vault is ${params.vault} but you are currently in ${currentVaultName}`,
    };
  }
  if (params.data === undefined) {
    return { status: "error", message: `missing data` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(params.data) as Record<string, unknown>;
  } catch {
    return { status: "error", message: `errors while parsing data` };
  }
  return {
    status: "ok",
    message: "ok",
    func: params.func,
    parsed,
    sv: params.sv,
  };
};
