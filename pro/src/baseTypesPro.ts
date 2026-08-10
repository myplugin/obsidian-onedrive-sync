////////////////////////////////////////////////////////////
// hacks
////////////////////////////////////////////////////////////

declare global {
  var DEFAULT_REMOTELYSAVE_WEBSITE: string;
  var DEFAULT_REMOTELYSAVE_CLIENT_ID: string;
  var DEFAULT_GOOGLEDRIVE_CLIENT_ID: string;
  var DEFAULT_GOOGLEDRIVE_CLIENT_SECRET: string;
  var DEFAULT_BOX_CLIENT_ID: string;
  var DEFAULT_BOX_CLIENT_SECRET: string;
  var DEFAULT_PCLOUD_CLIENT_ID: string;
  var DEFAULT_PCLOUD_CLIENT_SECRET: string;
  var DEFAULT_YANDEXDISK_CLIENT_ID: string;
  var DEFAULT_YANDEXDISK_CLIENT_SECRET: string;
  var DEFAULT_KOOFR_CLIENT_ID: string;
  var DEFAULT_KOOFR_CLIENT_SECRET: string;
}

//////////////////////////////////////////////////////////
// PRO
//////////////////////////////////////////////////////////

export type PRO_FEATURE_TYPE =
  | "feature-smart_conflict"
  | "feature-clear_dup_files";

export interface FeatureInfo {
  featureName: PRO_FEATURE_TYPE;
  enableAtTimeMs: bigint;
  expireAtTimeMs: bigint;
}

//////////////////////////////////////////////////////////
// smart conflict
//////////////////////////////////////////////////////////

export const MERGABLE_SIZE = 1000 * 1000; // 1 MB
