import * as Effect from "effect/Effect";
import * as SystemRecovery from "./diagnostics/SystemRecovery.ts";
/** Middleware enforces the declared read/operate scopes. */
export const resourceRecoveryHandlers = () => ({
  "server.previewRecovery": () =>
    Effect.flatMap(SystemRecovery.SystemRecovery, (service) => service.preview),
  "server.executeRecovery": (
    input: Parameters<SystemRecovery.SystemRecovery["Service"]["execute"]>[0],
  ) => Effect.flatMap(SystemRecovery.SystemRecovery, (service) => service.execute(input)),
});
