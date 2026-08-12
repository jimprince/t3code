import { describe, expect, it } from "vite-plus/test";

import { selectRemoteWorktreeBase } from "./remoteWorktreeBase.ts";

describe("selectRemoteWorktreeBase", () => {
  it("prefers gitea when both supported remotes exist", () => {
    expect(selectRemoteWorktreeBase({ baseBranch: "main", hasGitea: true, hasOrigin: true })).toBe(
      "gitea",
    );
  });
  it("uses whichever supported remote exists", () => {
    expect(selectRemoteWorktreeBase({ baseBranch: "main", hasGitea: true, hasOrigin: false })).toBe(
      "gitea",
    );
    expect(selectRemoteWorktreeBase({ baseBranch: "main", hasGitea: false, hasOrigin: true })).toBe(
      "origin",
    );
  });
  it("honors an explicit qualified supported remote", () => {
    expect(
      selectRemoteWorktreeBase({ baseBranch: "origin/main", hasGitea: true, hasOrigin: true }),
    ).toBe("origin");
    expect(
      selectRemoteWorktreeBase({ baseBranch: "gitea/main", hasGitea: true, hasOrigin: true }),
    ).toBe("gitea");
  });
  it("returns no selection when no supported remote exists", () => {
    expect(
      selectRemoteWorktreeBase({ baseBranch: "main", hasGitea: false, hasOrigin: false }),
    ).toBeNull();
  });
});
