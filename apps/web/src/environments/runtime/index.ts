export {
  getEnvironmentHttpBaseUrl,
  getSavedEnvironmentRecord,
  getSavedEnvironmentRuntimeState,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  readSavedEnvironmentBearerToken,
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
  resolveEnvironmentHttpUrl,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  type SavedEnvironmentRecord,
  type SavedEnvironmentRuntimeState,
} from "./catalog";

export {
  addSavedEnvironment,
  connectDesktopSshEnvironment,
  disconnectSavedEnvironment,
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  reconnectSavedEnvironment,
  removeSavedEnvironment,
  requestSavedEnvironmentRemoteUpgrade,
  requireEnvironmentConnection,
  resetEnvironmentServiceForTests,
  startEnvironmentConnectionService,
  subscribeEnvironmentConnections,
  type SavedEnvironmentUpgradeResult,
} from "./service";

export { resolveRemoteUpgradeEligibility, type RemoteUpgradeEligibility } from "./remoteUpgrade";
