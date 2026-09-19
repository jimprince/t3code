import { describe, expect, it, vi } from "vite-plus/test";

import {
  openModelInOrcaSlicer,
  safeModelFileName,
  type OrcaSlicerHandoffDependencies,
} from "./OrcaSlicer.ts";

function dependencies(
  overrides: Partial<OrcaSlicerHandoffDependencies> = {},
): OrcaSlicerHandoffDependencies {
  return {
    platform: "darwin",
    tempDirectory: "/private/tmp",
    makeTempDirectory: vi.fn(async () => "/private/tmp/t3-orcaslicer-random"),
    writeFile: vi.fn(async () => undefined),
    removeDirectory: vi.fn(async () => undefined),
    launch: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("OrcaSlicer handoff", () => {
  it("stages private STL bytes and launches the named macOS app with argument boundaries", async () => {
    const deps = dependencies();
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(
      openModelInOrcaSlicer({ name: "gear;$(touch owned).stl", bytes }, deps),
    ).resolves.toEqual({ opened: true });

    expect(deps.writeFile).toHaveBeenCalledWith(
      "/private/tmp/t3-orcaslicer-random/gear_touch owned_.stl",
      bytes,
      { flag: "wx", mode: 0o600 },
    );
    expect(deps.launch).toHaveBeenCalledWith("/usr/bin/open", [
      "-a",
      "OrcaSlicer",
      "/private/tmp/t3-orcaslicer-random/gear_touch owned_.stl",
    ]);
  });

  it("removes traversal and rejects unsupported and oversized payloads before filesystem access", async () => {
    expect(safeModelFileName("../../nested\\part.stl")).toBe("part.stl");
    expect(safeModelFileName("../../nested\\project.3MF")).toBe("project.3mf");
    expect(safeModelFileName("../../nested\\bracket.STEP")).toBe("bracket.step");
    const deps = dependencies();
    await expect(
      openModelInOrcaSlicer({ name: "part.glb", bytes: new Uint8Array([1]) }, deps),
    ).resolves.toMatchObject({
      opened: false,
      error: expect.stringContaining("STL, 3MF, and STEP files only"),
    });
    await expect(
      openModelInOrcaSlicer(
        { name: "part.stl", bytes: new Uint8Array(50 * 1024 * 1024 + 1) },
        deps,
      ),
    ).resolves.toMatchObject({ opened: false, error: expect.stringContaining("50 MB") });
    expect(deps.makeTempDirectory).not.toHaveBeenCalled();
  });

  it("reports a useful missing-app error and removes the staged copy", async () => {
    const deps = dependencies({
      launch: vi.fn(async () => Promise.reject(new Error("not found"))),
    });
    await expect(
      openModelInOrcaSlicer({ name: "part.stl", bytes: new Uint8Array([1]) }, deps),
    ).resolves.toEqual({
      opened: false,
      error: "OrcaSlicer could not be opened. Install OrcaSlicer in Applications and try again.",
    });
    expect(deps.removeDirectory).toHaveBeenCalledWith("/private/tmp/t3-orcaslicer-random");
  });
});
