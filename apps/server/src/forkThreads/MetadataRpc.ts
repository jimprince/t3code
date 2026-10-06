import { ForkThreadMetadataError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeNestingService } from "./NestingService.ts";

export const makeMetadataHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const management = yield* ThreadManagement.ThreadManagementService;
  const service = yield* makeNestingService(
    sql,
    management.getThreadShell,
    management.dispatch,
  ).pipe(Effect.orDie);
  const mapError = (cause: unknown) =>
    cause instanceof ForkThreadMetadataError
      ? cause
      : new ForkThreadMetadataError({ message: String(cause) });
  return {
    "fork.threads.metadata.list": () => service.list().pipe(Effect.mapError(mapError)),
    "fork.threads.metadata.update": (input: Parameters<typeof service.update>[0]) =>
      service.update(input).pipe(Effect.mapError(mapError)),
  };
});
