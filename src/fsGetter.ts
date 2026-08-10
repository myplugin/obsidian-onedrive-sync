import type { RemotelySavePluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsLocal } from "./fsLocal";
import { FakeFsMock } from "./fsMock";
import { FakeFsOnedrive } from "./fsOnedrive";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<any>
): FakeFs {
  switch (settings.serviceType) {
    case "onedrive":
      return new FakeFsOnedrive(
        settings.onedrive,
        vaultName,
        saveUpdatedConfigFunc
      );
    default:
      throw Error(`cannot init client for serviceType=${settings.serviceType}`);
  }
}
