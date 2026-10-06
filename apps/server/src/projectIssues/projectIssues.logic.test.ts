import type { GiteaInstanceConfig, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectThreadTree,
  deriveProjectIssueStatus,
  deriveRequestStage,
  findRootThreadId,
  formatRequestMarker,
  giteaRepositoryForIdentity,
  isPartOf,
  parseBlockedBy,
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

describe("request stages", () => {
  it("derives the stage Brad sees from state and labels", () => {
    expect(deriveRequestStage("open", ["ask"])).toBe("requested");
    expect(deriveRequestStage("open", ["ask", "in-progress"])).toBe("in-progress");
    expect(deriveRequestStage("open", ["ask", "needs-review"])).toBe("ready");
    expect(deriveRequestStage("open", ["ask", "awaiting-release"])).toBe("awaiting-release");
    expect(deriveRequestStage("open", ["ask", "needs-test", "in-progress"])).toBe("needs-test");
    expect(deriveRequestStage("closed", ["ask", "needs-test"])).toBe("settled");
  });

  it("puts the release stages in the board lane of whoever acts next", () => {
    expect(deriveProjectIssueStatus("open", ["needs-test"])).toBe("needs-review");
    expect(deriveProjectIssueStatus("open", ["awaiting-release"])).toBe("in-progress");
  });
});

describe("isPartOf", () => {
  it("matches a body that opens with Part of #N, any case", () => {
    expect(isPartOf("Part of #109\n\nDetails", 109)).toBe(true);
    expect(isPartOf("  part of #109", 109)).toBe(true);
  });

  it("ignores other parents, mentions further down and longer numbers", () => {
    expect(isPartOf("Part of #110", 109)).toBe(false);
    expect(isPartOf("Part of #1090", 109)).toBe(false);
    expect(isPartOf("Details\nPart of #109", 109)).toBe(false);
    expect(isPartOf(null, 109)).toBe(false);
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

describe("parseBlockedBy", () => {
  it("reads every same-repository reference after 'Blocked by'", () => {
    expect(parseBlockedBy("Blocked by #12, #14 and #12.\nSee #99.")).toEqual([12, 14]);
    expect(parseBlockedBy("blocked by: the auth work (#7)")).toEqual([7]);
  });

  it("ignores cross-repository references and text without the phrase", () => {
    expect(parseBlockedBy("Blocked by brad/other#5")).toEqual([]);
    expect(parseBlockedBy("Follows #3")).toEqual([]);
    expect(parseBlockedBy(null)).toEqual([]);
  });
});
