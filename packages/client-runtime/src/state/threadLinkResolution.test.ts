import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadAcrossEnvironments,
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
    expect(resolve("thread:xyz", environments)).toMatchObject({ kind: "found", threadId: "thread:xyz" });
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
