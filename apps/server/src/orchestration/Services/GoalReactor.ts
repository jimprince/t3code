import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface GoalReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class GoalReactor extends Context.Service<GoalReactor, GoalReactorShape>()(
  "t3/orchestration/Services/GoalReactor",
) {}
