import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ThreadId, RunId } from "@t3tools/contracts";
import { RecoveryToolkit, RecoveryHandlersLive } from "./tools.ts";
import { RecoveryAuthority } from "../../../threadRecovery/RecoveryAuthority.ts";

it.effect(
  "provider MCP cannot elevate full access or supplied administrative context into an administrative grant",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* RecoveryToolkit.pipe(Effect.provide(RecoveryHandlersLive));
      const outputs = yield* toolkit
        .handle("thread_session_reset", {
          threadId: ThreadId.make("target"),
          runId: RunId.make("run"),
          expectedGeneration: 0,
          requestId: "reset",
          reason: "operator_reset",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatchObject({
        isFailure: true,
        result: { _tag: "ThreadRecoveryError", code: "forbidden" },
      });
    }).pipe(
      Effect.provideService(RecoveryAuthority, {
        principal: "provider",
        scopes: ["access:write", "orchestration:operate"],
      }),
    ),
);
