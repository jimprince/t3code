import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnectionSummary } from "./presentation.ts";
import type { EnvironmentShellState } from "./shell.ts";
import {
  createThreadLinkAtoms,
  resolveThreadAcrossEnvironments,
  threadLinkKey,
  threadLinkTarget,
  type ThreadLinkEnvironment,
} from "./threadLinkResolution.ts";

const devVm = EnvironmentId.make("dev-vm");
const mac = EnvironmentId.make("local-mbp");
const laptop = EnvironmentId.make("laptop");

interface TestShell {
  readonly id: ThreadId;
}

function environment(
  environmentId: EnvironmentId,
  label: string,
  input: {
    readonly threads?: ReadonlyArray<string>;
    readonly state?: "live" | "connecting" | "disconnected";
  } = {},
): ThreadLinkEnvironment<TestShell> {
  const state = input.state ?? "live";
  return {
    environmentId,
    label,
    live: state === "live",
    connecting: state === "connecting",
    threads: new Map(
      (input.threads ?? []).map((id) => [ThreadId.make(id), { id: ThreadId.make(id) }] as const),
    ),
  };
}

const resolve = (
  threadId: string,
  environments: ReadonlyArray<ThreadLinkEnvironment<TestShell>>,
  preferred = devVm,
) =>
  resolveThreadAcrossEnvironments({
    threadId: ThreadId.make(threadId),
    preferredEnvironmentId: preferred,
    environments,
  });

describe("resolveThreadAcrossEnvironments", () => {
  it("finds a thread that lives in another connected environment", () => {
    const result = resolve("target", [
      environment(devVm, "Dev VM", { threads: ["source"] }),
      environment(mac, "Mac", { threads: ["target"] }),
    ]);
    expect(result).toMatchObject({
      kind: "found",
      environmentId: mac,
      label: "Mac",
      threadId: "target",
      inPreferredEnvironment: false,
    });
  });

  it("keeps the message's own environment when the thread is there", () => {
    const result = resolve("target", [
      environment(devVm, "Dev VM", { threads: ["target"] }),
      environment(mac, "Mac"),
    ]);
    expect(result).toMatchObject({
      kind: "found",
      environmentId: devVm,
      inPreferredEnvironment: true,
    });
  });

  it("prefers the message's environment when the same id lives in two environments", () => {
    const result = resolve("target", [
      environment(mac, "Mac", { threads: ["target"] }),
      environment(devVm, "Dev VM", { threads: ["target"] }),
    ]);
    expect(result).toMatchObject({ kind: "found", environmentId: devVm });
  });

  it("reports ambiguity only when the preferred environment lacks the id and two others have it", () => {
    const result = resolve("target", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["target"] }),
      environment(laptop, "Laptop", { threads: ["target"] }),
    ]);
    expect(result).toEqual({
      kind: "ambiguous",
      threadId: "target",
      candidates: [
        { environmentId: mac, label: "Mac" },
        { environmentId: laptop, label: "Laptop" },
      ],
    });
  });

  it("is unavailable, not found, once every environment answered live without the id", () => {
    const result = resolve("missing", [
      environment(devVm, "Dev VM", { threads: ["source"] }),
      environment(mac, "Mac"),
    ]);
    expect(result).toEqual({ kind: "unavailable", reason: "not-found" });
  });

  it("cannot call a thread missing while an environment is disconnected", () => {
    const result = resolve("missing", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { state: "disconnected" }),
      environment(laptop, "Laptop", { state: "disconnected" }),
    ]);
    expect(result).toEqual({
      kind: "unavailable",
      reason: "disconnected",
      environments: ["Mac", "Laptop"],
    });
  });

  it("stays quiet while an environment is still connecting", () => {
    const result = resolve("missing", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { state: "connecting" }),
    ]);
    expect(result).toEqual({ kind: "unavailable", reason: "loading" });
  });

  it("still finds a thread in a disconnected environment's cached snapshot", () => {
    const result = resolve("target", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["target"], state: "disconnected" }),
    ]);
    expect(result).toMatchObject({ kind: "found", environmentId: mac });
  });

  it("keeps opaque ids whole", () => {
    const environments = [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["mcp:abc-123", "thread:xyz"] }),
    ];
    expect(resolve("mcp:abc-123", environments)).toMatchObject({
      kind: "found",
      environmentId: mac,
      threadId: "mcp:abc-123",
    });
    expect(resolve("thread:xyz", environments)).toMatchObject({
      kind: "found",
      threadId: "thread:xyz",
    });
    // A prefix is part of the id; it never matches the bare id behind it.
    expect(resolve("abc-123", environments)).toMatchObject({ kind: "unavailable" });
  });

  it("falls back to the percent-decoded id only when the written id names no thread", () => {
    const environments = [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["mcp:abc"] }),
    ];
    expect(resolve("mcp%3Aabc", environments)).toMatchObject({
      kind: "found",
      environmentId: mac,
      threadId: "mcp:abc",
    });
  });

  it("prefers a literal %3A id as written over its decoded form", () => {
    const environments = [
      environment(devVm, "Dev VM", { threads: ["mcp:abc"] }),
      environment(mac, "Mac", { threads: ["mcp%3Aabc"] }),
    ];
    expect(resolve("mcp%3Aabc", environments)).toMatchObject({
      kind: "found",
      environmentId: mac,
      threadId: "mcp%3Aabc",
    });
  });
});

describe("threadLinkTarget", () => {
  const written = { environmentId: devVm, threadId: ThreadId.make("mcp%3Aabc") };

  it("goes to the environment and id where the thread was found", () => {
    const resolution = resolve("mcp%3Aabc", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["mcp:abc"] }),
    ]);
    expect(threadLinkTarget(resolution, written)).toEqual({
      environmentId: mac,
      threadId: "mcp:abc",
    });
  });

  it("goes where the link was written when the thread is not found or ambiguous", () => {
    const missing = resolve("mcp%3Aabc", [environment(devVm, "Dev VM")]);
    expect(threadLinkTarget(missing, written)).toEqual(written);
    const ambiguous = resolve("mcp%3Aabc", [
      environment(devVm, "Dev VM"),
      environment(mac, "Mac", { threads: ["mcp:abc"] }),
      environment(laptop, "Laptop", { threads: ["mcp:abc"] }),
    ]);
    expect(threadLinkTarget(ambiguous, written)).toEqual(written);
  });
});

describe("createThreadLinkAtoms", () => {
  const summary = (
    environmentId: EnvironmentId,
    environmentLabel: string,
    connectionState: EnvironmentConnectionSummary["connectionState"],
  ): EnvironmentConnectionSummary => ({
    environmentId,
    environmentLabel,
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState,
    connectionError: null,
    connectionErrorTraceId: null,
  });
  const shellState = (status: EnvironmentShellState["status"]): EnvironmentShellState => ({
    snapshot: Option.none(),
    status,
    error: Option.none(),
  });
  const thread = (id: string) => ({ id: ThreadId.make(id) }) as OrchestrationV2ThreadShell;

  function harness() {
    const environmentsAtom = Atom.make<ReadonlyArray<EnvironmentConnectionSummary>>([
      summary(devVm, "Dev VM", "connected"),
      summary(mac, "Mac", "connecting"),
    ]);
    const threadIndex = (...ids: string[]) =>
      Atom.make<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>(
        new Map(ids.map((id) => [ThreadId.make(id), thread(id)] as const)),
      );
    const indexes = new Map([
      [devVm, threadIndex("source")],
      [mac, threadIndex()],
    ]);
    const states = new Map([
      [devVm, Atom.make<EnvironmentShellState>(shellState("live"))],
      [mac, Atom.make<EnvironmentShellState>(shellState("empty"))],
    ]);
    const atoms = createThreadLinkAtoms({
      environmentsAtom,
      threadIndexAtom: (id) => indexes.get(id)!,
      shellStateValueAtom: (id) => states.get(id)!,
    });
    const registry = AtomRegistry.make();
    return { atoms, registry, indexes, states, environmentsAtom };
  }

  it("follows a link as the other environment connects and its threads arrive", () => {
    const { atoms, registry, indexes, states, environmentsAtom } = harness();
    const atom = atoms(threadLinkKey(devVm, ThreadId.make("target")));
    registry.mount(atom);
    expect(registry.get(atom)).toEqual({ kind: "unavailable", reason: "loading" });

    registry.set(environmentsAtom, [
      summary(devVm, "Dev VM", "connected"),
      summary(mac, "Mac", "offline"),
    ]);
    expect(registry.get(atom)).toEqual({
      kind: "unavailable",
      reason: "disconnected",
      environments: ["Mac"],
    });

    registry.set(environmentsAtom, [
      summary(devVm, "Dev VM", "connected"),
      summary(mac, "Mac", "connected"),
    ]);
    registry.set(states.get(mac)!, shellState("live"));
    expect(registry.get(atom)).toEqual({ kind: "unavailable", reason: "not-found" });

    registry.set(indexes.get(mac)!, new Map([[ThreadId.make("target"), thread("target")]]));
    expect(registry.get(atom)).toMatchObject({ kind: "found", environmentId: mac, label: "Mac" });
  });

  it("hands back the same answer object when unrelated shell updates leave it unchanged", () => {
    const { atoms, registry, indexes } = harness();
    const atom = atoms(threadLinkKey(devVm, ThreadId.make("source")));
    registry.mount(atom);
    const before = registry.get(atom);
    registry.set(indexes.get(mac)!, new Map([[ThreadId.make("other"), thread("other")]]));
    expect(registry.get(atom)).toBe(before);
  });

  it("ignores disabled environments", () => {
    const { atoms, registry, environmentsAtom } = harness();
    registry.set(environmentsAtom, [
      summary(devVm, "Dev VM", "connected"),
      { ...summary(mac, "Mac", "offline"), isEnabled: false },
    ]);
    const atom = atoms(threadLinkKey(devVm, ThreadId.make("nobody")));
    registry.mount(atom);
    expect(registry.get(atom)).toEqual({ kind: "unavailable", reason: "not-found" });
  });
});
