import { EnvironmentId, ThreadId, ProjectId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { makeThreadFixture } from "../../test-fixtures";
import {
  flattenSupervisionChildren,
  groupQuietChildren,
  supervisionProjectLabel,
} from "./nestedThreadVisibility.logic";
const env = EnvironmentId.make("env");
const children = ["a", "b"].map((id) => ({
  ...makeThreadFixture({ environmentId: env, id: ThreadId.make(id) }),
  latestRun: null,
  runtime: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  pinnedAt: null,
  createdAt: "2026-10-05T00:00:00Z",
  updatedAt: "2026-10-05T00:00:00Z",
}));
const input = {
  children,
  parentKey: "env:parent",
  visiblePaths: new Set<string>(),
  activeCounts: new Map<string, number>(),
};
it("groups untouched two-minute bursts separately from completed quiet work", () => {
  expect(groupQuietChildren(input).groups.map((g) => g.kind)).toEqual(["burst"]);
  expect(
    groupQuietChildren({
      ...input,
      children: children.map((t) => ({ ...t, updatedAt: "2026-10-05T00:04:00Z" })),
    }).groups.map((g) => g.kind),
  ).toEqual(["quiet"]);
});
it("keeps pins, input, opened paths and ancestors of active children visible", () => {
  const a = children[0]!,
    b = children[1]!;
  expect(
    groupQuietChildren({
      ...input,
      children: [
        { ...a, pinnedAt: "now" },
        { ...b, hasPendingUserInput: true },
      ],
    }).visible,
  ).toHaveLength(2);
  expect(
    groupQuietChildren({
      ...input,
      visiblePaths: new Set(["env:a"]),
      activeCounts: new Map([["env:b", 1]]),
    }).groups,
  ).toEqual([]);
  expect(supervisionProjectLabel(a, b, new Map())).toBeNull();
});

it("promotes a first active run out of the untouched burst and labels only different projects", () => {
  const a = children[0]!,
    b = children[1]!;
  expect(
    groupQuietChildren({
      ...input,
      children: [
        {
          ...a,
          runtime: {
            status: "running",
            activeRunId: null,
            providerInstanceId: a.providerInstanceId,
            providerName: null,
            lastError: null,
            updatedAt: a.updatedAt,
          },
        },
        b,
      ],
    }).visible.map((t) => t.id),
  ).toEqual(["a"]);
  const other = { ...a, projectId: ProjectId.make("other") };
  expect(supervisionProjectLabel(other, b, new Map([["env:other", "Other project"]]))).toBe(
    "Other project",
  );
  expect(supervisionProjectLabel(other, b, new Map())).toBeNull();
});

it("flattens only drawn rows, folding quiet children behind a group row", () => {
  const parent = makeThreadFixture({ environmentId: env, id: ThreadId.make("parent") });
  const [a, b] = children.map((t) => ({ ...t, updatedAt: "2026-10-05T00:04:00Z" }));
  const base = {
    root: parent,
    children: new Map([["env:parent", [a!, b!]]]),
    activeCounts: new Map<string, number>(),
    visiblePaths: new Set<string>(),
    expandedParents: new Set<string>(),
    expandedGroups: new Set<string>(),
  };
  expect(flattenSupervisionChildren(base)).toEqual([]);
  const folded = flattenSupervisionChildren({ ...base, expandedParents: new Set(["env:parent"]) });
  expect(folded.map((row) => (row.kind === "group" ? row.label : row.key))).toEqual(["2 done"]);
  const open = flattenSupervisionChildren({
    ...base,
    expandedParents: new Set(["env:parent"]),
    expandedGroups: new Set(["done:env:parent"]),
  });
  expect(open.map((row) => row.kind)).toEqual(["group", "thread", "thread"]);
  expect(open.every((row) => row.depth === 1)).toBe(true);
});
