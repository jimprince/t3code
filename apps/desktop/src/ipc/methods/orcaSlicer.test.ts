import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const { nativeHandoff } = vi.hoisted(() => ({
  nativeHandoff: vi.fn(async () => ({ opened: true as const })),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: () => null, fromWebContents: () => null },
  webContents: { getFocusedWebContents: () => null },
}));

vi.mock("../../model/OrcaSlicer.ts", () => ({
  nodeOrcaSlicerHandoffDependencies: (platform: NodeJS.Platform) => ({ platform }),
  openModelInOrcaSlicer: nativeHandoff,
}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { openModelInOrcaSlicer as ipcOpenModelInOrcaSlicer } from "./window.ts";

const environmentLayer = Layer.mock(DesktopEnvironment.DesktopEnvironment)({
  platform: "darwin",
} as DesktopEnvironment.DesktopEnvironment["Service"]);

describe("openModelInOrcaSlicer IPC", () => {
  it.effect("decodes a bounded byte payload and routes it to the client platform handoff", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([1, 2, 3]);
      const result = yield* ipcOpenModelInOrcaSlicer.handler({ name: "part.stl", bytes });
      assert.deepEqual(result, { opened: true });
      assert.deepEqual(nativeHandoff.mock.calls, [
        [{ name: "part.stl", bytes }, { platform: "darwin" }],
      ]);
    }).pipe(Effect.provide(environmentLayer)),
  );

  it.effect("rejects empty and malformed payloads before the native handoff", () =>
    Effect.gen(function* () {
      nativeHandoff.mockClear();
      const empty = yield* Effect.exit(
        ipcOpenModelInOrcaSlicer.handler({ name: "part.stl", bytes: new Uint8Array() }),
      );
      const malformed = yield* Effect.exit(
        ipcOpenModelInOrcaSlicer.handler({ name: "../part.stl", bytes: "not bytes" }),
      );
      assert.isTrue(Exit.isFailure(empty));
      assert.isTrue(Exit.isFailure(malformed));
      assert.equal(nativeHandoff.mock.calls.length, 0);
    }).pipe(Effect.provide(environmentLayer)),
  );
});
