import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ServerBootGeneration } from "../Services/ServerBootGeneration.ts";

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 15 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const { bootGenerationId } = yield* ServerBootGeneration;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;
      let deadGenerationSettledCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const isDeadGeneration = binding.bootGenerationId !== bootGenerationId;
        if (isDeadGeneration) {
          // Recovery starts the adapter before it upserts the binding. This CAS
          // is safe on both sides of that upsert: before it, recovery's later
          // running/current-generation upsert wins; after it, the expected old
          // generation no longer matches and this sweep skips the live session.
          const settled = yield* directory
            .settleDeadGenerationBinding({
              threadId: binding.threadId,
              expectedBootGenerationId: binding.bootGenerationId,
            })
            .pipe(
              Effect.tap((didSettle) =>
                didSettle
                  ? Effect.logDebug("provider.session.reaper.dead-generation-settled", {
                      threadId: binding.threadId,
                      provider: binding.provider,
                      currentBootGenerationId: bootGenerationId,
                      persistedBootGenerationId: binding.bootGenerationId,
                    })
                  : Effect.logDebug("provider.session.reaper.generation-changed", {
                      threadId: binding.threadId,
                      currentBootGenerationId: bootGenerationId,
                      persistedBootGenerationId: binding.bootGenerationId,
                    }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.reaper.dead-generation-settle-failed", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  currentBootGenerationId: bootGenerationId,
                  persistedBootGenerationId: binding.bootGenerationId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (settled) {
            deadGenerationSettledCount += 1;
          }
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellByIdIncludingArchived(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        const idleDurationMs = now - lastSeenMs;
        const isArchivedThread = thread?.archivedAt !== null && thread?.archivedAt !== undefined;
        if (!isArchivedThread && idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const projectedActiveTurnId = thread?.session?.activeTurnId ?? null;
        if (
          binding.activeTurnId != null &&
          thread?.session !== null &&
          thread?.session !== undefined &&
          projectedActiveTurnId === null
        ) {
          const reconciled = yield* directory
            .markTurnTerminal({
              threadId: binding.threadId,
              expectedTurnId: binding.activeTurnId,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.reaper.stale-turn-reconcile-failed", {
                  threadId: binding.threadId,
                  activeTurnId: binding.activeTurnId,
                  cause,
                }).pipe(Effect.as(false)),
              ),
            );
          if (reconciled) {
            yield* Effect.logInfo("provider.session.reaper.stale-turn-reconciled", {
              threadId: binding.threadId,
              activeTurnId: binding.activeTurnId,
            });
            // Reconciliation refreshes lastSeenAt, beginning a full warm-idle
            // window rather than immediately killing the recovered session.
            continue;
          }
        }

        if (binding.activeTurnId != null || projectedActiveTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: projectedActiveTurnId ?? binding.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: isArchivedThread ? "archived_thread" : "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (deadGenerationSettledCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.dead-generation-sweep-complete", {
          count: deadGenerationSettledCount,
          currentBootGenerationId: bootGenerationId,
        });
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
