import type { GiteaInstanceConfig, OrchestrationProjectShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadIssueLink, resolveThreadIssueReference } from "./ThreadIssueService.ts";

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

const macInstance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://git.home:3000",
  token: "test",
};
const macProject: Pick<OrchestrationProjectShell, "repositoryIdentity"> = {
  repositoryIdentity: {
    canonicalKey: "git.bradleyprince.com/brad/gpu-transcriber",
    provider: "gitea",
    displayName: "brad/gpu-transcriber",
    owner: "brad",
    name: "gpu-transcriber",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "ssh://git@git.home:2222/brad/gpu-transcriber.git",
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

  it.each([
    "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
    "http://git.home/brad/gpu-transcriber/issues/6",
  ])(
    "accepts public and internal issue URLs through the project's configured Gitea route",
    (url) => {
      expect(resolveThreadIssueReference(url, macProject, [macInstance])).toMatchObject({
        instance: macInstance,
        repository: "brad/gpu-transcriber",
        number: 6,
        url,
      });
    },
  );

  it("creates a usable cached badge without a live Gitea response", () => {
    const target = resolveThreadIssueReference(
      "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      macProject,
      [macInstance],
    );
    expect(buildThreadIssueLink(target, null, "2026-10-04T12:00:00.000Z")).toMatchObject({
      repository: "brad/gpu-transcriber",
      number: 6,
      url: "https://git.bradleyprince.com/brad/gpu-transcriber/issues/6",
      snapshot: { title: "brad/gpu-transcriber #6", state: "open" },
    });
  });
});
