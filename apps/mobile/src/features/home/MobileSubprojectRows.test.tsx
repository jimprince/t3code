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
  } = {},
): OrchestratorThreadShell => ({
  ...makeThreadShellFixture({
    environmentId: env,
    id: ThreadId.make(id),
    title: id,
    settledOverride: options.settled ? "settled" : null,
  }),
  parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
  subproject: options.parent && !options.worker ? "on" : "auto",
  purpose: options.purpose ?? null,
  supervisionMetadataPresent: true,
});

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
