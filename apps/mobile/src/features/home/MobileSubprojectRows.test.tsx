import {
  buildOrchestratorSummaries,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import { threadPurposes } from "@t3tools/client-runtime/state/thread-purpose";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";

vi.mock("react-native", () => ({
  View: "div",
  Pressable: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <button aria-label={accessibilityLabel}>{children}</button>,
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("./MobileDecisionFeed", () => ({ MobileDecisionFeed: () => null }));
vi.mock("./MobileProjectRequests", () => ({ MobileProjectRequests: () => null }));
vi.mock("./MobileTaskFraction", () => ({ MobileTaskFraction: () => null }));

import { MobileSubprojectRows } from "./MobileSubprojectRows";

const env = EnvironmentId.make("env");
const shell = (
  id: string,
  options: {
    parent?: string;
    purpose?: "project" | "harness";
    settled?: boolean;
    worker?: boolean;
    subagent?: "native" | "delegate";
    activity?: string;
  } = {},
): OrchestratorThreadShell => {
  const base = makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make(id),
    title: id,
    settledOverride: options.settled ? "settled" : null,
    latestUserMessageAt: options.activity ?? null,
  });
  const lineage =
    options.subagent && options.parent
      ? {
          rootThreadId: ThreadId.make(options.parent),
          parentThreadId: ThreadId.make(options.parent),
          relationshipToParent: "subagent" as const,
        }
      : base.lineage;
  return {
    ...base,
    lineage,
    source: {
      ...base.source,
      lineage,
      ...(options.subagent
        ? {
            createdBy: "agent" as const,
            creationSource:
              options.subagent === "native" ? ("provider" as const) : ("mcp" as const),
          }
        : {}),
    },
    parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
    subproject: options.parent && !options.worker && !options.subagent ? "on" : "auto",
    purpose: options.purpose ?? null,
    supervisionMetadataPresent: true,
  };
};

/** The shape of Brad's live Projects tab: a project whose active children are mostly Harness. */
const threads = [
  shell("orchestrator", { purpose: "project" }),
  shell("worker", { parent: "orchestrator", worker: true }),
  shell("reliability", { parent: "orchestrator", purpose: "harness" }),
  shell("product", { parent: "orchestrator", purpose: "harness" }),
  shell("dashboard", { parent: "product" }),
  shell("delivery-tools", { parent: "orchestrator" }),
  shell("v2-port", { parent: "orchestrator", settled: true }),
];

describe("MobileSubprojectRows", () => {
  const orchestrator = buildOrchestratorSummaries(threads, []).find(
    (summary) => summary.root.id === "orchestrator",
  )!;
  const markup = renderToStaticMarkup(
    <MobileSubprojectRows
      summary={orchestrator}
      purposes={threadPurposes(threads)}
      quietCutoff={0}
      onSelectThread={vi.fn()}
    />,
  );
  const rowOf = (title: string) =>
    markup.slice(markup.indexOf(`aria-label="Open ${title} subproject"`)).split("</button>")[0]!;

  it("lists every active subproject, Harness ones included", () => {
    const opened = [...markup.matchAll(/aria-label="Open ([^"]+) subproject"/g)].map((m) => m[1]);
    expect(opened.toSorted()).toEqual(["dashboard", "delivery-tools", "product", "reliability"]);
  });

  it("tags only the Harness subproject whose parent is not Harness", () => {
    expect(rowOf("reliability")).toContain(">Harness<");
    expect(rowOf("product")).toContain(">Harness<");
    expect(rowOf("dashboard")).not.toContain(">Harness<");
    expect(rowOf("delivery-tools")).not.toContain(">Harness<");
  });

  it("keeps the settled subproject in the collapsed Settled row", () => {
    expect(markup).toContain("Settled (1)");
    expect(markup).not.toContain("Open v2-port subproject");
  });
});

describe("MobileSubprojectRows subagents", () => {
  const forest = [
    shell("orchestrator", { purpose: "project" }),
    shell("worker", { parent: "orchestrator", worker: true }),
    shell("claude-task", {
      parent: "orchestrator",
      subagent: "native",
      activity: "2026-10-13T09:00:00.000Z",
    }),
    shell("delegate", {
      parent: "orchestrator",
      subagent: "delegate",
      activity: "2026-10-13T10:00:00.000Z",
    }),
    shell("deep", { parent: "worker", subagent: "native", activity: "2026-10-13T08:00:00.000Z" }),
    shell("old-task", { parent: "orchestrator", subagent: "delegate", settled: true }),
    shell("harness-helper", { parent: "orchestrator", subagent: "native", purpose: "harness" }),
    shell("delivery-tools", { parent: "orchestrator" }),
    shell("v2-port", { parent: "orchestrator", settled: true }),
  ];
  const orchestrator = buildOrchestratorSummaries(forest, []).find(
    (summary) => summary.root.id === "orchestrator",
  )!;
  const markup = renderToStaticMarkup(
    <MobileSubprojectRows
      summary={orchestrator}
      purposes={threadPurposes(forest)}
      quietCutoff={0}
      onSelectThread={vi.fn()}
    />,
  );
  const agentRow = (title: string) =>
    markup.slice(markup.indexOf(`aria-label="Open ${title} subagent"`)).split("</button>")[0]!;

  it("lists subagents after the subproject rows, newest first, a worker's too", () => {
    const opened = [...markup.matchAll(/aria-label="Open ([^"]+) subagent"/g)].map((m) => m[1]);
    expect(opened).toEqual(["delegate", "claude-task", "deep"]);
    expect(markup.indexOf("Open delivery-tools subproject")).toBeLessThan(
      markup.indexOf("Open delegate subagent"),
    );
  });

  it("tags provider-native subagents read-only and names the worker that spawned one", () => {
    expect(agentRow("claude-task")).toContain(">read-only<");
    expect(agentRow("delegate")).not.toContain("read-only");
    expect(agentRow("deep")).toContain("deep");
    expect(agentRow("deep")).toContain("· worker");
  });

  it("folds the settled subagent into the one Settled row with the settled subproject", () => {
    expect(markup).toContain("Settled (2)");
    expect(markup).not.toContain("Open old-task subagent");
  });

  it("keeps a Harness subagent off the card", () => {
    expect(markup).not.toContain("harness-helper");
  });

  it("counts a delegated child's run that the navigation list used to drop", () => {
    const running: OrchestratorThreadShell[] = forest.map((thread) =>
      thread.id === "delegate"
        ? {
            ...thread,
            runtime: {
              status: "running" as const,
              activeRunId: null,
              providerInstanceId: thread.providerInstanceId,
              providerName: null,
              lastError: null,
              updatedAt: thread.updatedAt,
            },
          }
        : thread,
    );
    // navigationThreadShellsAtom leaves out every lineage "subagent": the old Projects input.
    const oldInput = running.filter((thread) => thread.lineage.relationshipToParent !== "subagent");
    const rollup = (threads: typeof running) =>
      buildOrchestratorSummaries(threads, []).find((summary) => summary.root.id === "orchestrator")!
        .rollup.working;
    expect(rollup(oldInput)).toBe(0);
    expect(rollup(running)).toBe(1);
  });
});

describe("MobileSubprojectRows workers", () => {
  const withWorkers = [
    shell("orchestrator", { purpose: "project" }),
    shell("mine", { parent: "orchestrator", worker: true, activity: "2026-10-13T10:00:00.000Z" }),
    shell("done", { parent: "orchestrator", worker: true, settled: true }),
    shell("harness-chore", { parent: "orchestrator", worker: true, purpose: "harness" }),
  ];
  const orchestrator = buildOrchestratorSummaries(withWorkers, []).find(
    (summary) => summary.root.id === "orchestrator",
  )!;
  const markup = renderToStaticMarkup(
    <MobileSubprojectRows
      summary={orchestrator}
      purposes={threadPurposes(withWorkers)}
      quietCutoff={0}
      onSelectThread={vi.fn()}
    />,
  );

  it("lists a nested worker as a tagged row, a settled one in Settled, a Harness one not at all", () => {
    const opened = [...markup.matchAll(/aria-label="Open ([^"]+) worker"/g)].map((m) => m[1]);
    expect(opened).toEqual(["mine"]);
    const row = markup
      .slice(markup.indexOf('aria-label="Open mine worker"'))
      .split("</button>")[0]!;
    expect(row).toContain(">worker<");
    expect(markup).toContain("Settled (1)");
    expect(markup).not.toContain("harness-chore");
  });
});
