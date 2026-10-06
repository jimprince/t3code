import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  isProjectPullRequestDetail,
  owningProjectReturn,
  projectReturnState,
} from "./projectNavigation";

describe("project navigation", () => {
  it("records the project page for main-area thread, pull-request, and issue destinations", () => {
    expect(
      projectReturnState({
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("root-1"),
      }),
    ).toEqual({
      projectReturn: { environmentId: "env-1", threadId: "root-1" },
    });
  });

  it("uses the full-width PR detail only for a complete project-origin selection", () => {
    const project = {
      environmentId: EnvironmentId.make("env-1"),
      threadId: ThreadId.make("root-1"),
    };
    expect(isProjectPullRequestDetail(project, "brad/t3code", 42)).toBe(true);
    expect(isProjectPullRequestDetail(undefined, "brad/t3code", 42)).toBe(false);
    expect(isProjectPullRequestDetail(project, undefined, 42)).toBe(false);
    expect(isProjectPullRequestDetail(project, "brad/t3code", undefined)).toBe(false);
  });

  it("finds the project page of a thread that was loaded directly", () => {
    const thread = (environmentId: string, id: string) => ({
      environmentId: EnvironmentId.make(environmentId),
      id: ThreadId.make(id),
    });
    const summaries = [
      { root: thread("env-1", "root-1"), descendants: [thread("env-1", "worker-1")] },
      { root: thread("env-1", "root-2"), descendants: [thread("env-2", "worker-1")] },
    ];
    const expected = (threadId: string) => ({
      environmentId: "env-1",
      threadId,
    });
    expect(
      owningProjectReturn(summaries, EnvironmentId.make("env-1"), ThreadId.make("worker-1")),
    ).toEqual(expected("root-1"));
    // The same thread id in another environment is another thread.
    expect(
      owningProjectReturn(summaries, EnvironmentId.make("env-2"), ThreadId.make("worker-1")),
    ).toEqual(expected("root-2"));
    expect(
      owningProjectReturn(summaries, EnvironmentId.make("env-1"), ThreadId.make("root-2")),
    ).toEqual(expected("root-2"));
    expect(
      owningProjectReturn(summaries, EnvironmentId.make("env-1"), ThreadId.make("standalone")),
    ).toBeNull();
  });
});
