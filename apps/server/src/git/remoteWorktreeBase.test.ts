import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { resolveRemoteWorktreeBase, selectRemoteWorktreeBase } from "./remoteWorktreeBase.ts";

describe("selectRemoteWorktreeBase", () => {
  it.each([
    ["main", ["origin", "gitea"], "gitea"],
    ["main", ["origin"], "origin"],
    ["main", ["gitea"], "gitea"],
    ["origin/main", ["origin", "gitea"], "origin"],
    ["upstream/main", ["origin", "gitea", "upstream"], "upstream"],
    ["team/upstream/main", ["team", "team/upstream", "origin"], "team/upstream"],
    ["upstream/main", ["upstream"], "upstream"],
    ["feature/topic", ["origin", "gitea"], "gitea"],
    ["main", [], null],
    ["main", ["upstream"], null],
  ])("selects the remote for %s with %j", (baseBranch, remoteNames, expected) => {
    expect(selectRemoteWorktreeBase({ baseBranch, remoteNames })).toBe(expected);
  });
});

describe("resolveRemoteWorktreeBase", () => {
  it.each([
    [
      "feature",
      "origin",
      "refs/heads/feature",
      { remoteName: "origin", refName: "origin/feature" },
    ],
    ["feature", "gitea", "refs/heads/feature", { remoteName: "gitea", refName: "gitea/feature" }],
    ["local-alias", "origin", "refs/heads/main", { remoteName: "origin", refName: "origin/main" }],
    [
      "team/upstream/main",
      "origin",
      "refs/heads/feature",
      { remoteName: "team/upstream", refName: "team/upstream/main" },
    ],
    ["gitea/main", "origin", "refs/heads/main", { remoteName: "gitea", refName: "gitea/main" }],
    ["feature", null, null, { remoteName: "gitea", refName: "feature" }],
    ["feature", ".", "refs/heads/main", { remoteName: "gitea", refName: "feature" }],
    ["feature", "removed", "refs/heads/feature", null],
  ])("resolves %s tracking %s %s", async (baseBranch, remote, merge, expected) => {
    const result = await Effect.runPromise(
      resolveRemoteWorktreeBase(
        {
          listRemoteNames: () => Effect.succeed(["gitea", "origin", "team", "team/upstream"]),
          readConfigValue: (_cwd, key) =>
            Effect.succeed(key === `branch.${baseBranch}.remote` ? remote : merge),
        },
        { cwd: "/workspace", baseBranch },
      ),
    );
    expect(result).toEqual(expected);
  });
});
