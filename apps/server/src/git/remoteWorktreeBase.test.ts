import { describe, expect, it } from "vite-plus/test";
import { selectRemoteWorktreeBase } from "./remoteWorktreeBase.ts";

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
