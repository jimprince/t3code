import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { supervisionParents, supervisionAttention, supervisionSoundEligible } from "./forkNesting.ts";
const id = ThreadId.make;
const threads = ["p", "c", "g"].map(name => ({ id: id(name), projectId: "own-project", archivedAt: null }));
const metadata = [{ threadId: id("c"), parentThreadId: id("p") }, { threadId: id("g"), parentThreadId: id("c") }];
describe("organizational supervision", () => {
 it("rolls up descendant attention but keeps nested sounds silent", () => {
  const parents = supervisionParents(threads, metadata);
  expect(supervisionAttention(parents, new Set([id("g")]), id("p"))).toBe(true);
  expect(supervisionSoundEligible(parents, id("c"))).toBe(false);
  expect(supervisionSoundEligible(parents, id("p"))).toBe(true);
 });
 it("keeps children reachable when parents are filtered, archived or cyclic", () => {
  expect(supervisionParents(threads.slice(1), metadata).get(id("c"))).toBeNull();
  expect(supervisionParents(threads.map(t => t.id === id("p") ? { ...t, archivedAt: "now" } : t), metadata).get(id("c"))).toBeNull();
  const cyclic = [...metadata, { threadId: id("p"), parentThreadId: id("g") }];
  expect([...supervisionParents(threads, cyclic).values()]).toEqual([null, null, null]);
 });
});
