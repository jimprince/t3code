import { validateRemoteParent } from "./RemoteParentService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { resetThreadOrder } from "./ThreadOrderReset.ts";
import { ForkThreadMetadataError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeNestingService } from "./NestingService.ts";

const isMetadataError = Schema.is(ForkThreadMetadataError);

export const makeMetadataHandlers = Effect.gen(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = String(yield* environment.getEnvironmentId);
  const sql = yield* SqlClient.SqlClient;
  const management = yield* ThreadManagement.ThreadManagementService;
  const service = yield* makeNestingService(
    sql,
    management.getThreadShell,
    management.dispatch,
  ).pipe(Effect.orDie);
  const mapError = (cause: unknown) =>
    isMetadataError(cause) ? cause : new ForkThreadMetadataError({ message: String(cause) });
  return {
    "fork.threads.order.reset": (input: Parameters<typeof resetThreadOrder>[1]) =>
      resetThreadOrder(management, input).pipe(Effect.mapError(mapError)),
    "fork.threads.metadata.list": () => service.list().pipe(Effect.mapError(mapError)),
    "fork.threads.metadata.update": (input: Parameters<typeof service.update>[0]) =>
      validateRemoteParent(environmentId, input).pipe(
        Effect.andThen(service.update(input)),
        Effect.mapError(mapError),
      ),
  };
});
