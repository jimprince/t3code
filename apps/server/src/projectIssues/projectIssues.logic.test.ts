import type { GiteaInstanceConfig, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadTree,
  deriveProjectIssueStatus,
  findRootThreadId,
  formatRequestMarker,
  giteaRepositoryForIdentity,
  parseRequestMarker,
  workspaceRepositoryName,
} from "./projectIssues.logic.ts";

const id = (value: string) => value as ThreadId;
const instance = {
  id: "home",
  host: "git.bradleyprince.com",
  sshAliases: ["git.home"],
  sshPorts: [22],
  webOrigin: "https://git.bradleyprince.com",
  apiOrigin: "https://git.bradleyprince.com",
  token: "",
} satisfies GiteaInstanceConfig;

describe("deriveProjectIssueStatus", () => {
  it("matches the Agent Status Board lanes", () => {
    expect(deriveProjectIssueStatus("open", [])).toBe("pending");
    expect(deriveProjectIssueStatus("open", ["Needs-Review"])).toBe("needs-review");
    expect(deriveProjectIssueStatus("open", ["in-progress", "ask"])).toBe("in-progress");
    expect(deriveProjectIssueStatus("open", ["backlog"])).toBe("backlog");
    expect(deriveProjectIssueStatus("closed", ["in-progress"])).toBe("done");
    expect(deriveProjectIssueStatus("closed", ["archived"])).toBe("archived");
  });
});

describe("request marker", () => {
  it("round-trips inside an issue body and ignores malformed markers", () => {
    const source = { threadId: id("t-2"), rootThreadId: id("t-1"), messageId: "m-1" };
    const body = `Can we connect the ReSpeaker?\n\n${formatRequestMarker(source)}\n`;
    expect(parseRequestMarker(body)).toEqual(source);
    expect(parseRequestMarker("<!-- t3-request {not json} -->")).toBeNull();
    expect(parseRequestMarker('<!-- t3-request {"threadId":"t"} -->')).toBeNull();
    expect(parseRequestMarker(null)).toBeNull();
  });
});

describe("thread tree", () => {
  const threads = [
    { id: id("root"), parentThreadId: null },
    { id: id("worker"), parentThreadId: id("root") },
    { id: id("nested"), parentThreadId: id("worker") },
    { id: id("other"), parentThreadId: null },
  ];

  it("collects the root and all descendants", () => {
    expect(collectThreadTree(threads, id("root")).map((thread) => thread.id)).toEqual([
      "root",
      "worker",
      "nested",
    ]);
    expect(collectThreadTree(threads, id("missing"))).toEqual([]);
  });

  it("finds a worker's root and treats a standalone thread as its own root", () => {
    expect(findRootThreadId(threads, id("nested"))).toBe("root");
    expect(findRootThreadId(threads, id("other"))).toBe("other");
  });
});

describe("repository resolution", () => {
  const identity = (remoteUrl: string) =>
    ({
      canonicalKey: "ignored/by/resolution",
      locator: { source: "git-remote", remoteName: "origin", remoteUrl },
    }) as never;

  it("resolves the project remote like Gitea pull-request links do", () => {
    const configured = { ...instance, sshPorts: [2222] };
    for (const remote of [
      "ssh://git@git.home:2222/brad/PrintCell.git",
      "git@git.bradleyprince.com:brad/printcell.git",
      "https://git.bradleyprince.com/brad/printcell",
    ]) {
      expect(giteaRepositoryForIdentity(identity(remote), [configured])).toMatchObject({
        host: "git.bradleyprince.com",
        repository: "brad/printcell",
      });
    }
  });

  it("rejects remotes the PR resolver rejects", () => {
    expect(
      giteaRepositoryForIdentity(identity("ssh://git@git.home:2222/brad/printcell.git"), [
        instance,
      ]),
    ).toBeNull();
    expect(
      giteaRepositoryForIdentity(identity("https://github.com/jimprince/t3code"), [instance]),
    ).toBeNull();
    expect(giteaRepositoryForIdentity(null, [instance])).toBeNull();
  });

  it("names the tracker repository after the workspace directory", () => {
    expect(workspaceRepositoryName("/Users/brad/Programming/t3code-fork/")).toBe("t3code-fork");
    expect(workspaceRepositoryName("C:\\work\\PrintCell")).toBe("printcell");
    expect(workspaceRepositoryName("/")).toBeNull();
  });
});
