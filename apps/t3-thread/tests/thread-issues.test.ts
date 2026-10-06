import { describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import type { SavedEnvironment, ThreadIssueLink } from "../src/types.js";

const timestamp = "2026-10-03T00:00:00.000Z";
const environment: SavedEnvironment = {
  name: "test",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
  environmentId: "test",
  label: "test",
  serverVersion: "test",
  bearerToken: "test",
  expiresAt: timestamp,
  pairedAt: timestamp,
};
const issue: ThreadIssueLink = {
  host: "git.bradleyprince.com",
  repository: "brad/t3code-fork",
  number: 73,
  url: "https://git.bradleyprince.com/brad/t3code-fork/issues/73",
  linkedAt: timestamp,
  snapshot: { title: "Show linked issues", state: "open", syncedAt: timestamp },
};

describe("worker issue links", () => {
  it("uses the shared server link and unlink RPCs", async () => {
    const request = vi.fn(async (method: string) =>
      method === "threadIssuesLink"
        ? { link: issue, changed: true }
        : { unlinked: true, issue: { host: issue.host, repository: issue.repository, number: 73 } },
    );
    const dispose = vi.fn(async () => undefined);
    const client = new RemoteEnvironmentClient(environment, {
      rpcFactory: () => ({ request, dispose }) as never,
    });

    await expect(client.linkIssue("thread-1", "brad/t3code-fork#73")).resolves.toEqual({
      link: issue,
      changed: true,
    });
    await expect(client.unlinkIssue("thread-1", issue.url)).resolves.toMatchObject({
      unlinked: true,
    });
    expect(request.mock.calls).toEqual([
      ["threadIssuesLink", { threadId: "thread-1", reference: "brad/t3code-fork#73" }],
      ["threadIssuesUnlink", { threadId: "thread-1", reference: issue.url }],
    ]);
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
