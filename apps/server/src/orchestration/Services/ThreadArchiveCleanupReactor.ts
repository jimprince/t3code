/**
 * ThreadArchiveCleanupReactor - Archive cleanup reactor service interface.
 *
 * @module ThreadArchiveCleanupReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * ThreadArchiveCleanupReactorShape - Service API for cleanup after a thread is archived.
 */
export interface ThreadArchiveCleanupReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

/**
 * ThreadArchiveCleanupReactor - Service tag for thread archive cleanup workers.
 */
export class ThreadArchiveCleanupReactor extends Context.Service<
  ThreadArchiveCleanupReactor,
  ThreadArchiveCleanupReactorShape
>()("t3/orchestration/Services/ThreadArchiveCleanupReactor") {}
