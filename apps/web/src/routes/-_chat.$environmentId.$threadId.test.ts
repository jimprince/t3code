import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  shouldDelayMissingThreadRedirect,
  shouldRenderServerThreadRoute,
} from "./-threadRouteRecovery";

const threadRef = scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1"));

describe("chat thread route recovery guards", () => {
  it("keeps the server thread route mounted even when the thread is temporarily missing", () => {
    expect(
      shouldRenderServerThreadRoute({
        threadRef,
        bootstrapComplete: true,
      }),
    ).toBe(true);
  });

  it("delays redirect while the route thread is missing from the current snapshot", () => {
    expect(
      shouldDelayMissingThreadRedirect({
        threadRef,
        bootstrapComplete: true,
        routeThreadExists: false,
        environmentHasAnyThreads: true,
      }),
    ).toBe(true);
  });

  it("does not delay redirect before bootstrap completes or after the thread recovers", () => {
    expect(
      shouldDelayMissingThreadRedirect({
        threadRef,
        bootstrapComplete: false,
        routeThreadExists: false,
        environmentHasAnyThreads: true,
      }),
    ).toBe(false);

    expect(
      shouldDelayMissingThreadRedirect({
        threadRef,
        bootstrapComplete: true,
        routeThreadExists: true,
        environmentHasAnyThreads: true,
      }),
    ).toBe(false);
  });
});
