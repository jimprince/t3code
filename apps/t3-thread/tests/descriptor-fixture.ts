import type { ExecutionEnvironmentDescriptor, SavedEnvironment } from "../src/types.js";
/** RPC fixtures opt out of network discovery; nesting tests provide their own descriptor. */
export const descriptorFixture =
  (environment: SavedEnvironment) => async (): Promise<ExecutionEnvironmentDescriptor> => ({
    environmentId: environment.environmentId,
    label: environment.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: environment.serverVersion,
    orchestrationProtocolVersion: 2,
    capabilities: {},
  });
