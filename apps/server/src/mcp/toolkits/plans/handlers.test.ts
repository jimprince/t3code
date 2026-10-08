import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type PlanPublicationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { makeHandlers } from "./handlers.ts";

const threadId = ThreadId.make("caller");
const providerInstanceId = ProviderInstanceId.make("codex");
const scope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "session",
  issuedAt: 0,
  thread: { threadId, providerSessionId: "session", providerInstanceId },
  client: undefined,
  capabilities: new Set(["pull-requests", "orchestration"] as const),
};
const input = {
  title: "Parser",
  owner: "Manager",
  source: { type: "markdown" as const, key: "parser", markdown: "- Parse input" },
};

describe("MCP plan publication", () => {
  it.effect(
    "uses the caller by default and forwards the approved source to the publication service",
    () => {
      const calls: PlanPublicationInput[] = [];
      const handlers = makeHandlers({
        publish: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return { epic: { number: 1, url: "https://git.test/owner/repo/issues/1" }, tasks: [] };
          }),
      });
      return Effect.gen(function* () {
        const result = yield* handlers.t3_plan_publish(input);
        expect(result.epic.number).toBe(1);
        expect(calls).toEqual([{ ...input, threadId }]);
      }).pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagementService, {} as never),
      );
    },
  );
  it.effect(
    "refuses task-worker creation by an approval-required caller before publishing any issues",
    () => {
      let writes = 0;
      const handlers = makeHandlers({
        publish: () =>
          Effect.sync(() => {
            writes++;
            return { epic: { number: 1, url: "https://git.test/owner/repo/issues/1" }, tasks: [] };
          }),
      });
      return Effect.gen(function* () {
        const error = yield* handlers
          .t3_plan_publish({ ...input, createThreads: true })
          .pipe(Effect.flip);
        expect(error.message).toContain("full-access/default");
        expect(writes).toBe(0);
      }).pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagementService, {
          getThreadShell: () =>
            Effect.succeed({
              id: threadId,
              providerInstanceId,
              deletedAt: null,
              archivedAt: null,
              activeRunId: "run",
              runtimeMode: "approval-required",
              interactionMode: "default",
            }),
        } as never),
      );
    },
  );
});
