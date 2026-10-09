import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  ThreadRecoveryError,
  type AuthEnvironmentScope,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Supplied by authenticated transports, never decoded from tool or RPC arguments. */
export class RecoveryAuthority extends Context.Service<
  RecoveryAuthority,
  {
    readonly principal: string;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    readonly runtimeModeCeiling?: RuntimeMode;
  }
>()("t3/threadRecovery/RecoveryAuthority") {}

export const requireAdmin = RecoveryAuthority.pipe(
  Effect.flatMap((authority) =>
    authority.principal.length > 0 &&
    authority.scopes.includes(AuthAccessWriteScope) &&
    authority.scopes.includes(AuthOrchestrationOperateScope)
      ? Effect.succeed(authority)
      : Effect.fail(
          new ThreadRecoveryError({
            code: "forbidden",
            message: "Administrative access and orchestration operate scopes are required.",
          }),
        ),
  ),
);

/** Runtime permission never implies administrative authority. */
export const assertWithinCeiling = (
  authority: RecoveryAuthority["Service"],
  target: RuntimeMode,
) => {
  const ranks: Record<RuntimeMode, number> = {
    "approval-required": 0,
    "auto-accept-edits": 1,
    auto: 2,
    "full-access": 3,
  };
  return authority.runtimeModeCeiling === undefined ||
    ranks[target] <= ranks[authority.runtimeModeCeiling]
    ? Effect.void
    : Effect.fail(
        new ThreadRecoveryError({
          code: "forbidden",
          message: "Target runtime exceeds caller permission ceiling.",
        }),
      );
};
