import { expect, it } from "vite-plus/test";
import { matchesCurrentParent, recipientKey, sameNotificationRoute } from "../src/parentRouting.js";

const state = {
  environments: [
    { name: "local", environmentId: "local-id" },
    { name: "renamed", environmentId: "remote-id" },
  ],
};
const route = {
  sourceEnvironment: "local",
  sourceThreadId: "child",
  subscriberEnvironment: "local",
  subscriberThreadId: "parent",
};
const environments = state;

it("routes local parents only on the child's host despite duplicate UUIDs", () => {
  expect(matchesCurrentParent({ parentThreadId: "parent" }, route, environments)).toBe(true);
  expect(
    matchesCurrentParent(
      { parentThreadId: "parent" },
      {
        ...route,
        subscriberEnvironment: "renamed",
      },
      environments,
    ),
  ).toBe(false);
});
it("keeps a remote parent scoped across alias changes and disconnected pairings", () => {
  const parent = { remoteParent: { environmentId: "remote-id", threadId: "parent" } };
  expect(
    matchesCurrentParent(parent, { ...route, subscriberEnvironment: "renamed" }, environments),
  ).toBe(true);
  expect(
    matchesCurrentParent(
      parent,
      { ...route, subscriberEnvironment: "old-name", subscriberEnvironmentId: "remote-id" },
      { environments: [] },
    ),
  ).toBe(true);
  expect(matchesCurrentParent(parent, route, environments)).toBe(false);
});
it("never guesses a parent without organizational metadata", () => {
  expect(matchesCurrentParent({ parentThreadId: null }, route, environments)).toBe(false);
});
it("does not supersede another host's same-UUID source or recipient", () => {
  expect(
    sameNotificationRoute(route, { ...route, sourceEnvironment: "renamed" }, environments),
  ).toBe(false);
  expect(
    sameNotificationRoute(route, { ...route, subscriberEnvironment: "renamed" }, environments),
  ).toBe(false);
});
it("serializes renamed recipient routes together while keeping other hosts independent", () => {
  const remote = { ...route, subscriberEnvironment: "renamed" };
  expect(recipientKey(remote, environments)).toBe(
    recipientKey(
      { ...remote, subscriberEnvironment: "old-name", subscriberEnvironmentId: "remote-id" },
      environments,
    ),
  );
  expect(recipientKey(remote, environments)).not.toBe(recipientKey(route, environments));
});
