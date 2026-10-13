import {
  WS_METHODS,
  type DashboardSnapshot,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "../state/runtime.ts";
import {
  dashboardAnswersAtom,
  overlayDashboardAnswers,
  dashboardAnswerConfirmed,
  registerDashboardDecisions,
  type DashboardAnswer,
} from "./answers.ts";
import { readOlderDashboard } from "./fallback.ts";
export { mergeDashboardSnapshots, compareDashboardVersions, overlayAnswered } from "./merge.ts";

/** Cache lifetime is independent of the subscription lifetime; unmount closes all network reads. */
export function createDashboardAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: {
    readonly config: (id: EnvironmentId) => Atom.Atom<ServerConfig | null>;
    readonly readCached?: (id: EnvironmentId) => DashboardSnapshot | null;
    readonly shell: (id: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  },
) {
  const subscription = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "dashboard:subscription",
    tag: WS_METHODS.subscribeDashboard,
    idleTtlMs: 0,
  });
  const clock = runtime
    .atom(Clock.currentTimeMillis)
    .pipe(Atom.withRefresh(60_000), Atom.setIdleTTL(0));
  const cache = new Map<EnvironmentId, DashboardSnapshot>();
  const confirmedAnswers = new WeakSet<DashboardAnswer>();
  const initialized = new Set<EnvironmentId>();
  const configs = new Map<EnvironmentId, ServerConfig>();
  const shells = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
  const fallback = createEnvironmentQueryAtomFamily(runtime, {
    label: "dashboard:older-server",
    idleTtlMs: 0,
    staleTimeMs: 60_000,
    refreshIntervalMs: 60_000,
    execute: (
      input: { environmentId: EnvironmentId },
      emit: (value: DashboardSnapshot) => Effect.Effect<void>,
    ) => {
      const shell = shells.get(input.environmentId);
      const config = configs.get(input.environmentId);
      return shell
        ? readOlderDashboard(
            shell,
            cache.get(input.environmentId),
            config
              ? { version: config.environment.serverVersion, label: config.environment.label }
              : undefined,
            emit,
          )
        : Effect.never;
    },
  });
  const snapshot = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      if (!initialized.has(environmentId)) {
        initialized.add(environmentId);
        const stored = options.readCached?.(environmentId);
        if (stored) cache.set(environmentId, stored);
      }
      const config = get(options.config(environmentId));
      if (config) configs.set(environmentId, config);
      const capable = config?.environment.capabilities.dashboardSnapshot === true;
      const shell = get(options.shell(environmentId));
      if (shell) shells.set(environmentId, shell);
      // Config absence is still connecting, never permission to try an unsupported RPC.
      const result = capable
        ? get(subscription({ environmentId, input: {} }))
        : config && shell
          ? get(fallback({ environmentId, input: { environmentId } }))
          : null;
      const value = result ? Option.getOrNull(AsyncResult.value(result)) : null;
      if (value) cache.set(environmentId, value);
      const cached = cache.get(environmentId) ?? null;
      if (cached) registerDashboardDecisions(environmentId, cached);
      const answers = get(dashboardAnswersAtom);
      if (value)
        for (const answer of answers) {
          if (
            answer.environmentId === environmentId &&
            dashboardAnswerConfirmed(value, answer) &&
            (!answer.attentionId ||
              [...cache.values()].every(
                (snapshot) =>
                  !snapshot.projects.some((p) =>
                    p.attention.some((a) => a.id === answer.attentionId),
                  ),
              ))
          )
            confirmedAnswers.add(answer);
        }
      const pendingAnswers = answers.filter((answer) => !confirmedAnswers.has(answer));
      return {
        snapshot: cached
          ? overlayDashboardAnswers(
              cached,
              environmentId,
              pendingAnswers,
              Option.getOrElse(AsyncResult.value(get(clock)), () => 0),
            )
          : null,
        refreshing: result?.waiting ?? false,
        failed: result ? AsyncResult.isFailure(result) : false,
        olderServer: !!config && !capable,
        source: value ? ("live" as const) : cached ? ("cached" as const) : ("empty" as const),
      };
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`dashboard:${environmentId}`)),
  );
  /** Re-opens a failed subscription (or re-reads an older server); the last good snapshot stays. */
  const retry = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    const capable =
      registry.get(options.config(environmentId))?.environment.capabilities.dashboardSnapshot ===
      true;
    registry.refresh(
      capable
        ? subscription({ environmentId, input: {} })
        : fallback({ environmentId, input: { environmentId } }),
    );
  };
  return { snapshot, retry };
}
