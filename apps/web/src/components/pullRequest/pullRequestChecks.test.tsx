import type { EnvironmentId, ProjectId, PullRequestCheck } from "@t3tools/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { PullRequestRow } from "./PullRequestRow";
import { pullRequestChecksState } from "./pullRequestPresentation";
import { Checkbox } from "../ui/checkbox";

function check(status: PullRequestCheck["status"]): PullRequestCheck {
  return { name: `check-${status}`, status, description: null, url: null };
}

describe("pullRequestChecksState", () => {
  it("lets a failure outrank a run still going, and reports nothing without checks", () => {
    expect(pullRequestChecksState([check("success"), check("pending"), check("failure")])).toBe(
      "failing",
    );
    expect(pullRequestChecksState([check("success"), check("cancelled")])).toBe("failing");
    expect(pullRequestChecksState([check("success"), check("pending")])).toBe("pending");
    expect(pullRequestChecksState([check("success")])).toBe("passing");
    // Skipped and neutral are neither a pass nor a failure, so they are no verdict at all.
    expect(pullRequestChecksState([check("skipped"), check("neutral")])).toBe(null);
    expect(pullRequestChecksState([])).toBe(null);
  });
});

/** Every element of the tree the row returned, so a nested indicator can be looked for. */
function flatten(node: ReactNode): ReadonlyArray<ReturnType<typeof Object>> {
  const found: unknown[] = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    found.push(child);
    found.push(...flatten((child.props as { readonly children?: ReactNode }).children));
  }
  return found as ReadonlyArray<ReturnType<typeof Object>>;
}

function entry(overrides: Partial<EnvironmentPullRequestEntry>): EnvironmentPullRequestEntry {
  return {
    environmentId: "env-1" as EnvironmentId,
    projectId: "project-1" as ProjectId,
    provider: "github",
    repository: "pingdotgg/t3code",
    number: 1,
    title: "Add the pull requests page",
    url: "https://github.com/pingdotgg/t3code/pull/1",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  } as EnvironmentPullRequestEntry;
}

function row(
  overrides: Partial<EnvironmentPullRequestEntry>,
  checked = false,
  onCheckedChange: (entry: EnvironmentPullRequestEntry) => void = () => {},
): ReactNode {
  return PullRequestRow.type({
    entry: entry(overrides),
    selected: false,
    checked,
    showProjectTitle: false,
    showProvider: false,
    onSelect: () => {},
    onCheckedChange,
  });
}

describe("PullRequestRow selection", () => {
  it("renders selection beside the primary row action and reports the selected entry", () => {
    let selectedNumber: number | undefined;
    const rendered = row({}, true, (selected) => {
      selectedNumber = selected.number;
    });
    expect(isValidElement(rendered)).toBe(true);
    if (!isValidElement<{ readonly children?: ReactNode }>(rendered)) return;
    const children = Children.toArray(rendered.props.children);
    expect(children.map((child) => (isValidElement(child) ? child.type : null))).toEqual([
      Checkbox,
      "button",
    ]);

    const checkbox = children[0];
    expect(isValidElement(checkbox)).toBe(true);
    if (
      !isValidElement<{
        readonly checked: boolean;
        readonly onCheckedChange: () => void;
        readonly "aria-label": string;
      }>(checkbox)
    )
      return;
    expect(checkbox.props.checked).toBe(true);
    expect(checkbox.props["aria-label"]).toBe("Select pull request #1: Add the pull requests page");
    checkbox.props.onCheckedChange();
    expect(selectedNumber).toBe(1);
  });
});

describe("PullRequestRow checks indicator", () => {
  function indicators(node: ReactNode): number {
    return flatten(node).filter(
      (element) => (element as { type?: unknown }).type === PullRequestChecksPopover,
    ).length;
  }

  it("shows the indicator only for a row the host reported a rollup for", () => {
    expect(indicators(row({ checksState: "failing" }))).toBe(1);
    expect(indicators(row({}))).toBe(0);
  });
});
