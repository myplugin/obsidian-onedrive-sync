import type { Entity, RemotelySavePluginSettings } from "./baseTypes";
import type { FakeFs } from "./fsAll";
import { FakeFsOnedrive } from "./fsOnedrive";

/**
 * To avoid circular dependency, we need a new file here.
 */
export function getClient(
  settings: RemotelySavePluginSettings,
  vaultName: string,
  saveUpdatedConfigFunc: () => Promise<void>,
  prevRemoteEntities?: Entity[]
): FakeFs {
  switch (settings.serviceType) {
    case "onedrive":
      return new FakeFsOnedrive(
        settings.onedrive,
        vaultName,
        saveUpdatedConfigFunc,
        prevRemoteEntities
      );
    default:
      throw Error(`cannot init client for serviceType=${settings.serviceType}`);
  }
}
