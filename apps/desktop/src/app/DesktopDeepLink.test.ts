import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: {} }));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  DesktopDeepLink,
  findDesktopThreadDeepLink,
  layer,
  parseDesktopThreadDeepLink,
} from "./DesktopDeepLink.ts";

const environmentId = "c9d5fd19-15d1-45f1-856d-3d05a939854d";
const threadId = "058233fa-53c0-4058-93ae-0c883d8f654b";

const makeScenario = () => {
  const listeners = new Map<string, (...args: readonly unknown[]) => void>();
  const openThread = vi.fn(() => Effect.void);
  const setAsDefaultProtocolClient = vi.fn(() => Effect.succeed(true));
  const electronApp = ElectronApp.ElectronApp.of({
    setAsDefaultProtocolClient,
    on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
      Effect.sync(() => {
        listeners.set(eventName, listener as (...args: readonly unknown[]) => void);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"]);
  const desktopWindow = DesktopWindow.DesktopWindow.of({
    openThread,
  } as unknown as DesktopWindow.DesktopWindow["Service"]);
  return {
    listeners,
    openThread,
    setAsDefaultProtocolClient,
    layer: layer.pipe(
      Layer.provideMerge(Layer.succeed(ElectronApp.ElectronApp, electronApp)),
      Layer.provideMerge(Layer.succeed(DesktopWindow.DesktopWindow, desktopWindow)),
    ),
  };
};

describe("DesktopDeepLink", () => {
  it("parses exactly the shared thread deep-link contract across both schemes", () => {
    assert.deepEqual(parseDesktopThreadDeepLink(`t3code://threads/${environmentId}/${threadId}`), {
      environmentId,
      threadId,
    });
    assert.deepEqual(
      parseDesktopThreadDeepLink(`t3code-dev://threads/${environmentId}/${threadId}`),
      { environmentId, threadId },
    );
  });

  it.each([
    `t3code://app/threads/${environmentId}/${threadId}`,
    `t3code://threads/not-a-uuid/${threadId}`,
    `t3code://threads/${environmentId}/not-a-uuid`,
    `t3code://threads/${environmentId}/${threadId}/extra`,
    `https://threads/${environmentId}/${threadId}`,
  ])("rejects malformed or non-thread URLs: %s", (url) => {
    assert.equal(parseDesktopThreadDeepLink(url), null);
  });

  it("finds a valid activation URL among normal process arguments", () => {
    assert.deepEqual(
      findDesktopThreadDeepLink([
        "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
        "--flag",
        `t3code-dev://threads/${environmentId}/${threadId}`,
      ]),
      { environmentId, threadId },
    );
  });

  it.effect("queues an initial activation URL until startup flushes it", () =>
    Effect.gen(function* () {
      const scenario = makeScenario();
      const originalArgv = [...process.argv];
      process.argv.splice(
        0,
        process.argv.length,
        "T3 Code",
        `t3code://threads/${environmentId}/${threadId}`,
      );
      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const deepLink = yield* DesktopDeepLink;
            yield* deepLink.configure;
            assert.equal(scenario.openThread.mock.calls.length, 0);

            yield* deepLink.flush;
            assert.deepEqual(scenario.openThread.mock.calls, [[{ environmentId, threadId }]]);
          }).pipe(Effect.provide(scenario.layer)),
        );
      } finally {
        process.argv.splice(0, process.argv.length, ...originalArgv);
      }
    }),
  );

  it("leaves Clerk OAuth callback URLs outside the thread-link handler", () => {
    assert.equal(parseDesktopThreadDeepLink("t3code://app/?__clerk_synced=true"), null);
  });
});
