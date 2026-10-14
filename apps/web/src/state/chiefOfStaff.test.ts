import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

// Stand-ins for the three upstream atoms so the real key atom (shared by the sidebar row, the
// Cmd+Opt+Y shortcut and the command palette through useChiefOfStaffRef) runs unchanged.
vi.mock("./server", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("./server")>()),
    environmentServerConfigsAtom: Atom.make(() => mocks.state.configs),
  };
});
vi.mock("./threads", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await importOriginal<typeof import("./threads")>();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellsAtom: Atom.make(() => mocks.state.shells),
    },
  };
});
vi.mock("./primaryEnvironment", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("./primaryEnvironment")>()),
    primaryEnvironmentIdAtom: Atom.make(() => mocks.state.primary),
  };
});

import { chiefOfStaffKeyAtom } from "./chiefOfStaff";

const mac = EnvironmentId.make("mac");
const devVm = EnvironmentId.make("dev-vm");
const shell = (environmentId: EnvironmentId, id: string, title: string) => ({
  environmentId,
  id: ThreadId.make(id),
  title,
  updatedAt: "2026-10-13T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
});

function resolve(input: {
  configs: Array<[EnvironmentId, string | null]>;
  shells: ReturnType<typeof shell>[];
}) {
  mocks.state.configs = new Map(
    input.configs.map(([environmentId, threadId]) => [
      environmentId,
      { settings: threadId === null ? {} : { chiefOfStaffThreadId: threadId } },
    ]),
  );
  mocks.state.shells = input.shells;
  mocks.state.primary = mac;
  return AtomRegistry.make().get(chiefOfStaffKeyAtom);
}

describe("chiefOfStaffKeyAtom", () => {
  const shells = [
    shell(mac, "mac-other", "Some project"),
    shell(devVm, "82b73eb7", "Chief of Staff inbox"),
    shell(devVm, "e942f826", "Chief of Staff"),
  ];

  it("resolves the desk that lives on the dev-vm when no server names it", () => {
    expect(
      resolve({
        configs: [
          [mac, null],
          [devVm, null],
        ],
        shells,
      }),
    ).toBe("dev-vm:e942f826");
  });

  it("is not blocked by a stale preference on the Mac", () => {
    expect(
      resolve({
        configs: [
          [mac, "deleted"],
          [devVm, null],
        ],
        shells,
      }),
    ).toBe("dev-vm:e942f826");
  });

  it("lets an existing preference win over the title match", () => {
    expect(resolve({ configs: [[devVm, "82b73eb7"]], shells })).toBe("dev-vm:82b73eb7");
  });

  it("is null when nothing matches", () => {
    expect(resolve({ configs: [[mac, null]], shells: [shells[0]!, shells[1]!] })).toBeNull();
  });
});
