import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { buildOrchestratorSummaries, joinOrchestratorMetadata } from "./orchestrators.ts";
import { partitionThreadPurposes, threadPurposes } from "./threadPurpose.ts";

import { describe, expect, it } from "vite-plus/test";
import { effectivePurpose } from "./threadPurpose.ts";

describe("effectivePurpose", () => {
  it("inherits the nearest explicit purpose and changes with the root or parent", () => {
    const nodes = [
      { key: "root", parentKey: null, purpose: "harness" as const },
      { key: "head", parentKey: "root" },
      { key: "worker", parentKey: "head" },
      { key: "project", parentKey: "head", purpose: "project" as const },
      { key: "project-child", parentKey: "project" },
      { key: "plain", parentKey: null },
    ];
    expect([...effectivePurpose(nodes)]).toEqual([
      ["root", "harness"],
      ["head", "harness"],
      ["worker", "harness"],
      ["project", "project"],
      ["project-child", "project"],
      ["plain", "project"],
    ]);
    expect(
      effectivePurpose(
        nodes.map((node) => (node.key === "head" ? { ...node, parentKey: "plain" } : node)),
      ).get("worker"),
    ).toBe("project");
    expect(
      effectivePurpose(
        nodes.map((node) =>
          node.key === "root" ? { ...node, purpose: "project" as const } : node,
        ),
      ).get("worker"),
    ).toBe("project");
  });
  it("keeps unavailable remote ancestry and cycles unknown, while explicit overrides win", () => {
    const resolved = effectivePurpose([
      { key: "a:worker", parentKey: "b:root" },
      { key: "a:override", parentKey: "b:root", purpose: "harness" },
      { key: "loop", parentKey: "loop" },
      { key: "old", parentKey: null, purpose: null },
    ]);
    expect(resolved.get("a:worker")).toBeNull();
    expect(resolved.get("a:override")).toBe("harness");
    expect(resolved.get("loop")).toBeNull();
    expect(resolved.get("old")).toBe("project");
  });
});

it("partitions cross-purpose subprojects and standalone Harness roots after the metadata join", () => {
  const threads = joinOrchestratorMetadata(
    ["head", "worker", "subproject", "plain", "harness-alone", "harness-child"].map((id) =>
      presentThreadShell(EnvironmentId.make("env"), {
        ...v2ThreadShell,
        id: ThreadId.make(id),
        archivedAt: null,
      }),
    ),
    [
      {
        environmentId: "env",
        threadId: ThreadId.make("head"),
        parentThreadId: null,
        purpose: "harness",
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("worker"),
        parentThreadId: ThreadId.make("head"),
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("subproject"),
        parentThreadId: ThreadId.make("head"),
        subproject: "on",
        purpose: "project",
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("harness-alone"),
        parentThreadId: null,
        purpose: "harness",
        subproject: "off",
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("harness-child"),
        parentThreadId: ThreadId.make("harness-alone"),
      },
    ],
  );
  const summaries = buildOrchestratorSummaries(threads, []);
  const result = partitionThreadPurposes(threads, summaries);
  expect(result.projects.map((summary) => summary.root.id)).toEqual(["subproject"]);
  expect(result.harness.map((entry) => ("root" in entry ? entry.root.id : entry.id))).toEqual([
    "head",
    "harness-alone",
  ]);
  expect(result.standalone.map((thread) => thread.id)).toEqual(["plain"]);
  expect(threadPurposes(threads)).toBe(result.purposes);
  expect(summaries.find((summary) => summary.root.id === "head")?.subprojects).toHaveLength(1);
});

it("uses native subagent lineage only while organization has no explicit row", () => {
  const parent = presentThreadShell(EnvironmentId.make("env"), {
    ...v2ThreadShell,
    id: ThreadId.make("native-parent"),
  });
  const child = presentThreadShell(EnvironmentId.make("env"), {
    ...v2ThreadShell,
    id: ThreadId.make("native-child"),
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "subagent",
    },
  });
  const rows = [
    {
      environmentId: "env",
      threadId: parent.id,
      parentThreadId: null,
      purpose: "harness" as const,
    },
  ];
  expect(
    threadPurposes(joinOrchestratorMetadata([parent, child], rows)).get("env:native-child"),
  ).toBe("harness");
  expect(
    threadPurposes(
      joinOrchestratorMetadata(
        [parent, child],
        [
          ...rows,
          { environmentId: "env", threadId: child.id, parentThreadId: null, purpose: null },
        ],
      ),
    ).get("env:native-child"),
  ).toBe("project");
});
