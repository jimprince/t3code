import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { buildOrchestratorSummaries, joinOrchestratorMetadata } from "./orchestrators.ts";
import {
  partitionThreadPurposes,
  purposeMoveFor,
  subprojectPurposeTag,
  threadPurposes,
} from "./threadPurpose.ts";

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

describe("purposeMoveFor", () => {
  const rows = (
    metadata: ReadonlyArray<{
      id: string;
      parent?: string;
      purpose?: "harness" | "project";
      subproject?: "on";
    }>,
  ) => {
    const threads = joinOrchestratorMetadata(
      metadata.map(({ id }) =>
        presentThreadShell(EnvironmentId.make("env"), {
          ...v2ThreadShell,
          id: ThreadId.make(id),
          archivedAt: null,
        }),
      ),
      metadata.map((row) => ({
        environmentId: "env",
        threadId: ThreadId.make(row.id),
        parentThreadId: row.parent === undefined ? null : ThreadId.make(row.parent),
        ...(row.purpose === undefined ? {} : { purpose: row.purpose }),
        ...(row.subproject === undefined ? {} : { subproject: row.subproject }),
      })),
    );
    return (id: string) => purposeMoveFor(threads, `env:${id}`);
  };

  it("offers Move to Harness on a top-level project or plain thread, writing an explicit harness purpose", () => {
    const move = rows([{ id: "root" }, { id: "worker", parent: "root" }, { id: "plain" }]);
    for (const id of ["root", "plain"]) {
      expect(move(id)).toEqual({
        id: "move-to-harness",
        label: "Move to Harness",
        purpose: "harness",
      });
    }
  });

  it("says where a move back returns to: Projects for a project-shaped root, Threads for a plain one", () => {
    const move = rows([
      { id: "head", purpose: "harness" },
      { id: "worker", parent: "head" },
      { id: "marked", purpose: "harness", subproject: "on" },
      { id: "alone", purpose: "harness" },
    ]);
    // A top-level thread's default is already project, so moving back clears its override.
    expect(move("head")).toEqual({
      id: "move-to-projects",
      label: "Move back to Projects",
      purpose: null,
    });
    expect(move("marked")?.id).toBe("move-to-projects");
    expect(move("alone")).toEqual({
      id: "move-to-threads",
      label: "Move back to Threads",
      purpose: null,
    });
  });

  it("clears the override when the supervisor says project, pins project only under a Harness parent", () => {
    const move = rows([
      { id: "project-root" },
      { id: "under-project", parent: "project-root", purpose: "harness" },
      { id: "harness-root", purpose: "harness" },
      { id: "under-harness", parent: "harness-root", purpose: "harness" },
    ]);
    // Cleared: it follows its supervisor later, so a re-nest under Harness moves it with the parent.
    expect(move("under-project")?.purpose).toBeNull();
    // Explicit project: the supervisor is Harness and the thread must stay in Projects.
    expect(move("under-harness")?.purpose).toBe("project");
    expect(move("harness-root")?.purpose).toBeNull();
  });

  it("pins project when the supervisor's purpose is not known yet, rather than guessing", () => {
    const threads = joinOrchestratorMetadata(
      [
        presentThreadShell(EnvironmentId.make("env"), {
          ...v2ThreadShell,
          id: ThreadId.make("remote-child"),
          archivedAt: null,
        }),
      ],
      [
        {
          environmentId: "env",
          threadId: ThreadId.make("remote-child"),
          parentThreadId: ThreadId.make("gone"),
          purpose: "harness",
        },
      ],
    );
    expect(purposeMoveFor(threads, "env:remote-child")?.purpose).toBe("project");
  });

  it("leaves a worker with its root, but lets an explicit override move on its own", () => {
    const move = rows([
      { id: "head", purpose: "harness" },
      { id: "worker", parent: "head" },
      { id: "override", parent: "head", purpose: "project" },
    ]);
    expect(move("worker")).toBeNull();
    expect(move("override")?.id).toBe("move-to-harness");
  });

  it("offers nothing when the purpose is unknown or the thread is archived", () => {
    const threads = joinOrchestratorMetadata(
      [
        presentThreadShell(EnvironmentId.make("env"), {
          ...v2ThreadShell,
          id: ThreadId.make("orphan"),
          archivedAt: null,
        }),
      ],
      [
        {
          environmentId: "env",
          threadId: ThreadId.make("orphan"),
          parentThreadId: ThreadId.make("gone"),
        },
      ],
    );
    expect(purposeMoveFor(threads, "env:orphan")).toBeNull();
    expect(purposeMoveFor([], "env:missing")).toBeNull();
  });
});

it("keeps a project whose purpose is unknown in Projects, never hiding it", () => {
  const threads = joinOrchestratorMetadata(
    ["orphan", "orphan-worker"].map((id) =>
      presentThreadShell(EnvironmentId.make("env"), {
        ...v2ThreadShell,
        id: ThreadId.make(id),
        archivedAt: null,
      }),
    ),
    [
      {
        environmentId: "env",
        threadId: ThreadId.make("orphan"),
        parentThreadId: null,
        remoteParent: { environmentId: "other", threadId: ThreadId.make("away") },
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("orphan-worker"),
        parentThreadId: ThreadId.make("orphan"),
      },
    ],
  );
  const result = partitionThreadPurposes(threads, buildOrchestratorSummaries(threads, []));
  expect(result.purposes.get("env:orphan")).toBeNull();
  expect(result.projects.map((summary) => summary.root.id)).toEqual(["orphan"]);
  expect(result.harness).toEqual([]);
});

it("keeps a Harness subproject in its project's card with a tag, and as a Harness root too", () => {
  const ids = ["project", "plain", "reliability", "dashboard"];
  const threads = joinOrchestratorMetadata(
    ids.map((id) =>
      presentThreadShell(EnvironmentId.make("env"), {
        ...v2ThreadShell,
        id: ThreadId.make(id),
        archivedAt: null,
      }),
    ),
    [
      {
        environmentId: "env",
        threadId: ThreadId.make("project"),
        parentThreadId: null,
        purpose: "project" as const,
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("plain"),
        parentThreadId: ThreadId.make("project"),
        subproject: "on" as const,
      },
      {
        environmentId: "env",
        threadId: ThreadId.make("reliability"),
        parentThreadId: ThreadId.make("project"),
        subproject: "on" as const,
        purpose: "harness" as const,
      },
      // Inherits Harness from its supervisor.
      {
        environmentId: "env",
        threadId: ThreadId.make("dashboard"),
        parentThreadId: ThreadId.make("reliability"),
        subproject: "on" as const,
      },
    ],
  );
  const summaries = buildOrchestratorSummaries(threads, []);
  const project = summaries.find((summary) => summary.root.id === "project")!;
  const reliability = project.subprojects.find((sub) => sub.root.id === "reliability")!;
  const purposes = threadPurposes(threads);
  expect(project.subprojects.map((sub) => sub.root.id).toSorted()).toEqual([
    "plain",
    "reliability",
  ]);
  const tags = project.subprojects.map((sub) => [
    sub.root.id,
    subprojectPurposeTag(project, sub, purposes),
  ]);
  expect(tags.toSorted()).toEqual([
    ["plain", null],
    ["reliability", "Harness"],
  ]);
  // Under a Harness parent it already shares the purpose: no tag.
  expect(subprojectPurposeTag(reliability, reliability.subprojects[0]!, purposes)).toBeNull();
  // The Harness root is also listed in the Harness tab.
  const partition = partitionThreadPurposes(threads, summaries);
  expect(partition.projects.map((sub) => sub.root.id)).toEqual(["project"]);
  expect(partition.harness.map((row) => ("root" in row ? row.root.id : row.id))).toEqual([
    "reliability",
  ]);
});
