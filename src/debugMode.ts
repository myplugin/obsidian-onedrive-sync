import type { Vault } from "obsidian";

import {
  DEFAULT_DEBUG_FOLDER,
  DEFAULT_PROFILER_RESULT_FILE_PREFIX,
  DEFAULT_SYNC_DECISIONS_FILE_PREFIX,
} from "./baseTypes";
import {
  readAllProfilerResultsByVault,
  readAllSyncPlanRecordTextsByVault,
} from "./localdb";
import type { InternalDBs } from "./localdb";
import { debugInfo } from "./logger";
import { mkdirpInVault } from "./misc";
import type { SyncPlanType } from "./sync";

const getSubsetOfSyncPlan = (x: string, onlyChange: boolean): SyncPlanType => {
  const y: SyncPlanType = JSON.parse(x);
  if (!onlyChange) {
    return y;
  }
  return Object.fromEntries(
    Object.entries(y).filter(([key, val]) => {
      if (key === "/$@meta") {
        return true;
      }
      return val.change === undefined || val.change === true;
    })
  );
};

export const exportVaultSyncPlansToFiles = async (
  db: InternalDBs,
  vault: Vault,
  vaultRandomID: string,
  howMany: number,
  onlyChange: boolean
) => {
  debugInfo("exporting sync plans");
  await mkdirpInVault(DEFAULT_DEBUG_FOLDER, vault);
  const records = await readAllSyncPlanRecordTextsByVault(db, vaultRandomID);
  const selected = howMany <= 0 ? records : records.slice(0, howMany);
  const plans = selected.map((x) => getSubsetOfSyncPlan(x, onlyChange));
  const ts = Date.now();
  const payload = {
    exportedAt: ts,
    onlyChange,
    count: plans.length,
    plans,
  };
  const filePath = `${DEFAULT_DEBUG_FOLDER}${DEFAULT_SYNC_DECISIONS_FILE_PREFIX}${ts}.json`;
  await vault.create(filePath, JSON.stringify(payload, null, 2), {
    mtime: ts,
  });
  debugInfo("finish exporting sync plans");
};

export const exportVaultProfilerResultsToFiles = async (
  db: InternalDBs,
  vault: Vault,
  vaultRandomID: string
) => {
  debugInfo("exporting profiler results");
  await mkdirpInVault(DEFAULT_DEBUG_FOLDER, vault);
  const records = await readAllProfilerResultsByVault(db, vaultRandomID);
  let md = "";
  if (records.length === 0) {
    md = "No profiler results found";
  } else {
    md =
      "Profiler results found:\n\n" +
      records.map((x) => "```\n" + x + "\n```\n").join("\n");
  }
  const ts = Date.now();
  const filePath = `${DEFAULT_DEBUG_FOLDER}${DEFAULT_PROFILER_RESULT_FILE_PREFIX}${ts}.md`;
  await vault.create(filePath, md, {
    mtime: ts,
  });
  debugInfo("finish exporting profiler results");
};
