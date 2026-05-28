import type { ScopedThreadRef } from "@t3tools/contracts";

export function shouldRenderServerThreadRoute(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly bootstrapComplete: boolean;
}): boolean {
  return input.threadRef !== null && input.bootstrapComplete;
}

export function shouldDelayMissingThreadRedirect(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly bootstrapComplete: boolean;
  readonly routeThreadExists: boolean;
  readonly environmentHasAnyThreads: boolean;
}): boolean {
  return Boolean(
    input.threadRef &&
    input.bootstrapComplete &&
    !input.routeThreadExists &&
    input.environmentHasAnyThreads,
  );
}
