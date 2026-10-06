import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import {
  supervisionParents,
  supervisionAttention,
  supervisionSoundEligible,
} from "./forkNesting.ts";
const id = ThreadId.make;
const threads = ["p", "c", "g"].map((name) => ({
  id: id(name),
  projectId: "own-project",
  archivedAt: null,
}));
const metadata = [
  { threadId: id("c"), parentThreadId: id("p") },
  { threadId: id("g"), parentThreadId: id("c") },
];
describe("organizational supervision", () => {
  it("rolls up descendant attention but keeps nested sounds silent", () => {
    const parents = supervisionParents(threads, metadata);
    expect(supervisionAttention(parents, new Set([id("g")]), id("p"))).toBe(true);
    expect(supervisionSoundEligible(parents, id("c"))).toBe(false);
    expect(supervisionSoundEligible(parents, id("p"))).toBe(true);
  });
  it("keeps children reachable when parents are filtered, archived or cyclic", () => {
    expect(supervisionParents(threads.slice(1), metadata).get(id("c"))).toBeNull();
    expect(supervisionParents(threads.slice(1), metadata).get(id("g"))).toBe(id("c"));
    expect(
      supervisionParents(
        threads.map((t) => (t.id === id("p") ? { ...t, archivedAt: "now" } : t)),
        metadata,
      ).get(id("c")),
    ).toBeNull();
    const cyclic = [...metadata, { threadId: id("p"), parentThreadId: id("g") }];
    expect([...supervisionParents(threads, cyclic).values()]).toEqual([null, null, null]);
  });
});

import { connectedSupervisionParents, supervisionKey } from "./forkNesting.ts";
it("scopes colliding IDs, restores remote nesting after reconnect and rejects cross-host cycles", () => {
  const hosts = ["a", "b"].map((environmentId) => ({
    id: id("same"),
    environmentId,
    projectId: environmentId,
    archivedAt: null,
  }));
  const links = [
    {
      environmentId: "b",
      threadId: id("same"),
      parentThreadId: null,
      remoteParent: { environmentId: "a", threadId: id("same") },
    },
  ];
  expect(connectedSupervisionParents(hosts, links).get(supervisionKey("b", "same"))).toBe(
    supervisionKey("a", "same"),
  );
  expect(
    connectedSupervisionParents(hosts.slice(1), links).get(supervisionKey("b", "same")),
  ).toBeNull();
  expect(connectedSupervisionParents(hosts, links).get(supervisionKey("b", "same"))).toBe(
    supervisionKey("a", "same"),
  );
  const cycle = [
    ...links,
    {
      environmentId: "a",
      threadId: id("same"),
      parentThreadId: null,
      remoteParent: { environmentId: "b", threadId: id("same") },
    },
  ];
  expect([...connectedSupervisionParents(hosts, cycle).values()]).toEqual([null, null]);
});

it("cuts cached unavailable parents and keeps reachable descendants", () => {
  const threads = [
    {
      id: ThreadId.make("parent"),
      environmentId: "offline",
      archivedAt: null,
      projectId: "project",
      forkMetadataAvailable: false,
    },
    {
      id: ThreadId.make("child"),
      environmentId: "online",
      archivedAt: null,
      projectId: "project",
      forkMetadataAvailable: true,
    },
    {
      id: ThreadId.make("grandchild"),
      environmentId: "online",
      archivedAt: null,
      projectId: "project",
      forkMetadataAvailable: true,
    },
  ];
  const parents = connectedSupervisionParents(threads, [
    {
      threadId: ThreadId.make("child"),
      environmentId: "online",
      parentThreadId: null,
      remoteParent: { environmentId: "offline", threadId: ThreadId.make("parent") },
    },
    {
      threadId: ThreadId.make("grandchild"),
      environmentId: "online",
      parentThreadId: ThreadId.make("child"),
    },
  ]);
  expect(parents.get("online:child")).toBeNull();
  expect(parents.get("online:grandchild")).toBe("online:child");
});

import { supervisionWorkerLines } from "./forkNesting.ts";
it("lists every descendant of a thread as id and title lines", () => {
  const shell = (environmentId: string, threadId: string, title: string) =>
    ({ environmentId, id: ThreadId.make(threadId), title }) as never;
  const children = new Map([
    ["env:root", [shell("env", "a", "First"), shell("env", "b", "Second")]],
    ["env:a", [shell("env", "c", "Grandchild")]],
  ]);
  const lines = supervisionWorkerLines({ children }, "env:root");
  expect(lines.split("\n").toSorted()).toEqual(["a\tFirst", "b\tSecond", "c\tGrandchild"]);
  expect(supervisionWorkerLines({ children }, "env:b")).toBe("");
  // Unrelated shells changing leaves the string, and so any subscriber to it, unchanged.
  const unrelated = new Map(children).set("env:other", [shell("env", "z", "Elsewhere")]);
  expect(supervisionWorkerLines({ children: unrelated }, "env:root")).toBe(lines);
});
