import {
  CommandId,
  EventId,
  SessionResetReceipt,
  ThreadRecoveryError,
  SessionResetInput,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as ResetHook from "./ProviderSessionResetHook.ts";
import { requireAdmin, RecoveryAuthority, assertWithinCeiling } from "./RecoveryAuthority.ts";

const fail = (cause: unknown) =>
  Schema.is(ThreadRecoveryError)(cause)
    ? cause
    : new ThreadRecoveryError({ code: "storage", message: "Could not commit the session reset." });
export class SessionResetService extends Context.Service<
  SessionResetService,
  {
    readonly reset: (
      input: SessionResetInput,
    ) => Effect.Effect<SessionResetReceipt, ThreadRecoveryError, RecoveryAuthority>;
  }
>()("t3/threadRecovery/SessionResetService") {}
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* RecoveryStore.RecoveryStore;
  const reset: SessionResetService["Service"]["reset"] = (raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(SessionResetInput)(raw).pipe(
        Effect.mapError(
          () =>
            new ThreadRecoveryError({
              code: "conflict",
              message: "Invalid session reset parameters.",
            }),
        ),
      );
      const authority = yield* requireAdmin;
      const id = `reset:${authority.principal}:${input.requestId}`;
      const fingerprint = yield* Schema.encodeEffect(Schema.fromJsonString(SessionResetInput))(
        input,
      );
      const receipt = yield* locks.withLock(
        input.threadId,
        store
          .transaction(
            Effect.gen(function* () {
              const existing = yield* store.get(id);
              if (existing) {
                if (existing.fingerprint !== fingerprint)
                  return yield* new ThreadRecoveryError({
                    code: "conflict",
                    message: "Request ID already identifies a different reset.",
                  });
                return yield* Schema.decodeUnknownEffect(SessionResetReceipt)(existing.payload);
              }
              if ((yield* store.generation(input.threadId)) !== input.expectedGeneration)
                return yield* new ThreadRecoveryError({
                  code: "conflict",
                  message: "Thread generation changed.",
                });
              const p = yield* threads.getThreadRecords(input.threadId, [
                "runs",
                "attempts",
                "nodes",
                "providerThreads",
                "providerTurns",
                "providerSessions",
                "runtimeRequests",
                "turnItems",
              ]);
              yield* assertWithinCeiling(authority, p.thread.runtimeMode);
              const run = p.runs.find((r) => r.id === input.runId);
              if (!run)
                return yield* new ThreadRecoveryError({
                  code: "not_found",
                  message: "Exact run does not belong to this thread.",
                });
              if (
                p.runs.some(
                  (r) =>
                    r.ordinal > run.ordinal &&
                    r.status !== "queued" &&
                    (!["cancelled", "rolled_back"].includes(r.status) ||
                      r.providerThreadId !== null ||
                      r.startedAt !== null),
                )
              )
                return yield* new ThreadRecoveryError({
                  code: "conflict",
                  message: "A newer run owns this thread; original run was preserved.",
                });
              const pt = p.providerThreads.find((t) => t.id === run.providerThreadId);
              const session = p.providerSessions.find((s) => s.id === pt?.providerSessionId);
              if (!pt || !session)
                return yield* new ThreadRecoveryError({
                  code: "not_found",
                  message: "Exact run has no provider session to reset.",
                });
              const newGeneration = yield* store.advance(input.threadId, input.expectedGeneration);
              const receipt: SessionResetReceipt = {
                requestId: input.requestId,
                threadId: input.threadId,
                runId: input.runId,
                providerSessionId: session.id,
                oldGeneration: input.expectedGeneration,
                newGeneration,
                status: "fenced",
                isolation: null,
                principal: authority.principal,
              };
              yield* store.save(id, authority.principal, fingerprint, receipt);
              yield* store.fence(session.id, input.threadId, id, run.ordinal);
              const now = yield* DateTime.now;
              const base = { threadId: input.threadId, occurredAt: now };
              const event = (suffix: string) => ({
                ...base,
                id: EventId.make(`event:${id}:${suffix}`),
              });
              const events: OrchestrationV2DomainEvent[] = [];
              if (
                !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                  run.status,
                )
              )
                events.push({
                  ...event("run"),
                  type: "run.updated",
                  payload: { ...run, status: "cancelled", completedAt: now },
                });
              for (const attempt of p.attempts.filter(
                (a) => a.runId === run.id && ["pending", "running"].includes(a.status),
              ))
                events.push({
                  ...event(`attempt:${attempt.id}`),
                  type: "run-attempt.updated",
                  payload: { ...attempt, status: "cancelled", completedAt: now },
                });
              for (const node of p.nodes.filter(
                (n) => n.runId === run.id && ["pending", "running", "waiting"].includes(n.status),
              ))
                events.push({
                  ...event(`node:${node.id}`),
                  type: "node.updated",
                  payload: { ...node, status: "cancelled", completedAt: now },
                });
              for (const turn of p.providerTurns.filter(
                (t) =>
                  t.runAttemptId === run.activeAttemptId &&
                  ["starting", "running", "waiting"].includes(t.status),
              ))
                events.push({
                  ...event(`turn:${turn.id}`),
                  type: "provider-turn.updated",
                  payload: { ...turn, status: "cancelled", completedAt: now },
                });
              for (const request of p.runtimeRequests.filter(
                (r) =>
                  p.nodes.some((n) => n.runId === run.id && n.id === r.nodeId) &&
                  r.status === "pending",
              ))
                events.push({
                  ...event(`request:${request.id}`),
                  type: "runtime-request.updated",
                  payload: { ...request, status: "cancelled", resolvedAt: now },
                });
              for (const item of p.turnItems.filter(
                (i) => i.runId === run.id && ["pending", "running", "waiting"].includes(i.status),
              ))
                events.push({
                  ...event(`item:${item.id}`),
                  type: "turn-item.updated",
                  payload: { ...item, status: "cancelled", completedAt: now },
                });
              events.push({
                ...event("detach"),
                type: "provider-session.detached",
                payload: { providerSessionId: session.id, detachedAt: now, reason: input.reason },
              });
              events.push({
                ...event("provider-thread"),
                type: "provider-thread.updated",
                payload: {
                  ...pt,
                  providerSessionId: null,
                  status: "not_loaded",
                  updatedAt: now,
                  ...(input.reason === "discard_native"
                    ? {
                        nativeThreadRef: null,
                        nativeConversationHeadRef: null,
                        nativeMetadata: null,
                      }
                    : {}),
                },
              });
              yield* sink.write({ commandId: CommandId.make(id), events });
              return receipt;
            }),
          )
          .pipe(Effect.mapError(fail)),
      );
      if (receipt.status === "completed") return receipt;
      const hook = yield* ResetHook.ProviderSessionResetHook;
      const result = yield* hook.reset({
        ...input,
        providerSessionId: receipt.providerSessionId,
        oldGeneration: receipt.oldGeneration,
        newGeneration: receipt.newGeneration,
      });
      if (!result.stopped)
        return yield* new ThreadRecoveryError({
          code: "teardown",
          message: "Session fenced; owned teardown is incomplete. Retry the same request ID.",
        });
      const completed: SessionResetReceipt = {
        ...receipt,
        status: "completed",
        isolation: result.isolation,
      };
      yield* store.save(id, authority.principal, fingerprint, completed);
      return completed;
    }).pipe(Effect.mapError(fail));
  return SessionResetService.of({ reset });
});
export const layer = Layer.effect(SessionResetService, make);
