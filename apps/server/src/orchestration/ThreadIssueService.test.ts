import type { GiteaInstanceConfig, OrchestrationProjectShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadIssueReference } from "./ThreadIssueService.ts";

const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.bradleyprince.com",
  sshAliases: [],
  sshPorts: [22],
  webOrigin: "https://git.bradleyprince.com",
  apiOrigin: "https://git.bradleyprince.com",
  token: "test",
};

const project: Pick<OrchestrationProjectShell, "repositoryIdentity"> = {
  repositoryIdentity: {
    canonicalKey: "git.bradleyprince.com/brad/t3code-fork",
    provider: "gitea",
    displayName: "brad/t3code-fork",
    owner: "brad",
    name: "t3code-fork",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://git@git.bradleyprince.com/brad/t3code-fork.git",
    },
  },
};

describe("Gitea issue reference resolution", () => {
  it.each(["brad/t3code-fork#73", "https://git.bradleyprince.com/brad/t3code-fork/issues/73"])(
    "accepts configured Gitea reference %s",
    (reference) => {
      expect(resolveThreadIssueReference(reference, project, [instance])).toMatchObject({
        host: "git.bradleyprince.com",
        repository: "brad/t3code-fork",
        number: 73,
      });
    },
  );

  it.each([
    "https://github.com/brad/t3code-fork/issues/73",
    "https://git.bradleyprince.com/brad/t3code-fork/pulls/73",
    "https://git.bradleyprince.com/brad/t3code-fork/issues/73?tab=activity",
  ])("rejects non-Gitea or noncanonical reference %s", (reference) => {
    expect(() => resolveThreadIssueReference(reference, project, [instance])).toThrow();
  });

  it("rejects a short reference for a non-Gitea project", () => {
    expect(() =>
      resolveThreadIssueReference("brad/t3code-fork#73", { repositoryIdentity: null }, [instance]),
    ).toThrow(/requires the thread project to use configured Gitea/);
  });
});
