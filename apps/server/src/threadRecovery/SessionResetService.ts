import * as Incarnation from "./ServerIncarnation.ts";
import { ResumeAdmission } from "./ResumeAdmission.ts";
import {
  ThreadGenerationInput,
  ThreadGenerationResult,
  ThreadResumeInput,
  ThreadResumeReceipt,
  ThreadStopInput,
  ThreadStopReceipt,
  MessageId,
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
    : new ThreadRecoveryError({ code: "storage", message: "Could not complete thread recovery." });
/** Authenticated authority belongs to each call, never to the shared runtime.
 * @effect-expect-leaking RecoveryAuthority
 */
export class SessionResetService extends Context.Service<
  SessionResetService,
  {
    readonly generation: (
      input: ThreadGenerationInput,
    ) => Effect.Effect<ThreadGenerationResult, ThreadRecoveryError, RecoveryAuthority>;
    readonly resume: (
      input: ThreadResumeInput,
    ) => Effect.Effect<ThreadResumeReceipt, ThreadRecoveryError, RecoveryAuthority>;
    readonly stopReceipt: (
      input: ThreadStopInput,
    ) => Effect.Effect<ThreadStopReceipt, ThreadRecoveryError, RecoveryAuthority>;
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
  const incarnation = yield* Incarnation.ServerIncarnation;
  const generation: SessionResetService["Service"]["generation"] = (input) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      const p = yield* threads.getThreadRecords(input.threadId, []);
      yield* assertWithinCeiling(authority, p.thread.runtimeMode);
      return {
        threadId: input.threadId,
        generation: yield* store.generation(input.threadId),
        serverIncarnation: incarnation.id,
        serverStartedAt: incarnation.startedAt,
      };
    }).pipe(Effect.mapError(fail));
  const resume: SessionResetService["Service"]["resume"] = (raw) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      const input = yield* Schema.decodeUnknownEffect(ThreadResumeInput)(raw).pipe(
        Effect.mapError(
          () =>
            new ThreadRecoveryError({ code: "conflict", message: "Invalid resume parameters." }),
        ),
      );
      const id = `resume:${authority.principal}:${input.requestId}`;
      const commandId = CommandId.make(id);
      const fingerprint = yield* Schema.encodeEffect(Schema.fromJsonString(ThreadResumeInput))(
        input,
      );
      let saved: ThreadResumeReceipt | undefined;
      let refusal: ThreadRecoveryError | undefined;
      const validate = Effect.gen(function* () {
        const p = yield* threads.getThreadRecords(input.threadId, ["runs"]);
        yield* assertWithinCeiling(authority, p.thread.runtimeMode);
        const existing = yield* store.get(id);
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            return yield* new ThreadRecoveryError({
              code: "conflict",
              message: "Request ID already identifies a different resume.",
            });
          saved = yield* Schema.decodeUnknownEffect(ThreadResumeReceipt)(existing.payload);
          return false;
        }
        if ((yield* store.generation(input.threadId)) !== input.expectedGeneration)
          return yield* new ThreadRecoveryError({
            code: "conflict",
            message: "Thread generation changed.",
          });
        if (yield* store.hasPendingReset(input.threadId))
          return yield* new ThreadRecoveryError({
            code: "pending",
            message: "Session teardown is incomplete.",
          });
        if (p.runs.some((r) => ["preparing", "starting", "running", "waiting"].includes(r.status)))
          return yield* new ThreadRecoveryError({
            code: "conflict",
            message: "Thread already has active work.",
          });
        return true;
      }).pipe(
        Effect.mapError(fail),
        Effect.tapError((error) =>
          Effect.sync(() => {
            refusal = error;
          }),
        ),
      );
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId,
          threadId: input.threadId,
          messageId: MessageId.make(`${id}:message`),
          text: input.message ?? "Continue the interrupted work.",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(
          Effect.provideService(ResumeAdmission, {
            commandId,
            accept: validate,
            persist: (events) =>
              Effect.gen(function* () {
                // Recheck under SQLite write ownership too; reset uses the same thread lock.
                if ((yield* store.generation(input.threadId)) !== input.expectedGeneration)
                  return yield* new ThreadRecoveryError({
                    code: "conflict",
                    message: "Thread generation changed.",
                  });
                const run = events.find((e) => e.type === "run.created");
                if (!run || run.type !== "run.created" || run.payload.status === "queued")
                  return yield* new ThreadRecoveryError({
                    code: "conflict",
                    message: "Resume did not start a new run.",
                  });
                saved = {
                  threadId: input.threadId,
                  requestId: input.requestId,
                  runId: run.payload.id,
                  generation: input.expectedGeneration,
                  acceptedAt: DateTime.formatIso(run.occurredAt),
                  serverIncarnation: incarnation.id,
                };
                yield* store.save(id, authority.principal, fingerprint, saved);
              }).pipe(
                Effect.mapError(fail),
                Effect.tapError((error) =>
                  Effect.sync(() => {
                    refusal = error;
                  }),
                ),
              ),
          }),
          Effect.mapError((cause) => refusal ?? fail(cause)),
        );
      if (!saved)
        return yield* new ThreadRecoveryError({
          code: "storage",
          message: "Resume receipt was not committed.",
        });
      return saved;
    }).pipe(Effect.mapError(fail));
  const stopReceipt: SessionResetService["Service"]["stopReceipt"] = (input) =>
    Effect.gen(function* () {
      const authority = yield* requireAdmin;
      return yield* locks.withLock(
        input.threadId,
        store.transaction(
          Effect.gen(function* () {
            const p = yield* threads.getThreadRecords(input.threadId, ["runs", "turnItems"], {
              runIds: [input.runId],
              turnItemTypes: ["run_interrupt_request", "run_interrupt_result"],
            });
            yield* assertWithinCeiling(authority, p.thread.runtimeMode);
            const run = p.runs.find((r) => r.id === input.runId);
            if (!run)
              return yield* new ThreadRecoveryError({
                code: "not_found",
                message: "Exact run does not belong to this thread.",
              });
            const reset = yield* store.get(`stop-reset:${input.threadId}:${input.runId}`);
            const request = p.turnItems.find(
              (i) => i.runId === input.runId && i.type === "run_interrupt_request",
            );
            const result = p.turnItems.find(
              (i) => i.runId === input.runId && i.type === "run_interrupt_result",
            );
            const terminal = [
              "completed",
              "failed",
              "cancelled",
              "interrupted",
              "rolled_back",
            ].includes(run.status);
            if (reset)
              return {
                ...(yield* Schema.decodeUnknownEffect(ThreadStopReceipt)(reset.payload)),
                status: run.status,
                terminal,
                completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
              };
            const endedBy =
              result?.type === "run_interrupt_result" && result.stopOutcome
                ? result.stopOutcome
                : request?.type === "run_interrupt_request" && request.stopOutcome === "ack"
                  ? ("ack" as const)
                  : null;
            const stopped =
              terminal && result?.type === "run_interrupt_result" && result.stopOutcome === "ack";
            return {
              threadId: input.threadId,
              runId: input.runId,
              status: run.status,
              terminal,
              providerStopped: stopped,
              endedBy,
              generation:
                request?.type === "run_interrupt_request"
                  ? (request.sessionGeneration ?? null)
                  : null,
              requestedAt: request?.startedAt ? DateTime.formatIso(request.startedAt) : null,
              acknowledgedAt:
                request?.type === "run_interrupt_request" && request.stopOutcome === "ack"
                  ? DateTime.formatIso(request.updatedAt)
                  : null,
              completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
              stoppedAt: stopped && result ? DateTime.formatIso(result.updatedAt) : null,
            };
          }),
        ),
      );
    }).pipe(Effect.mapError(fail));
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
              yield* store.save(
                `stop-reset:${input.threadId}:${input.runId}`,
                authority.principal,
                fingerprint,
                {
                  threadId: input.threadId,
                  runId: input.runId,
                  status: "cancelled",
                  terminal: true,
                  providerStopped: false,
                  endedBy: "reset",
                  generation: newGeneration,
                  requestedAt: DateTime.formatIso(now),
                  acknowledgedAt: null,
                  completedAt: null,
                  stoppedAt: null,
                } satisfies ThreadStopReceipt,
              );
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
      yield* store.transaction(
        Effect.gen(function* () {
          const stop = yield* store.get(`stop-reset:${input.threadId}:${input.runId}`);
          // A pre-readback server may have persisted the reset intent without a stop proof.
          // Its retry can record the stop proved now; historical request time stays unknown.
          const payload = stop
            ? yield* Schema.decodeUnknownEffect(ThreadStopReceipt)(stop.payload)
            : {
                threadId: input.threadId,
                runId: input.runId,
                status: "cancelled",
                terminal: true,
                providerStopped: false,
                endedBy: "reset" as const,
                generation: receipt.newGeneration,
                requestedAt: null,
                acknowledgedAt: null,
                completedAt: null,
                stoppedAt: null,
              };
          const stoppedAt = payload.stoppedAt ?? DateTime.formatIso(yield* DateTime.now);
          yield* store.save(
            `stop-reset:${input.threadId}:${input.runId}`,
            authority.principal,
            fingerprint,
            {
              ...payload,
              providerStopped: true,
              stoppedAt,
            },
          );
          yield* store.save(id, authority.principal, fingerprint, completed);
        }),
      );
      return completed;
    }).pipe(Effect.mapError(fail));
  return SessionResetService.of({ reset, generation, resume, stopReceipt });
});
export const layer = Layer.effect(SessionResetService, make);
