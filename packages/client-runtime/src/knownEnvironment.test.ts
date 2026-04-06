import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  createKnownEnvironmentFromWsUrl,
  getKnownEnvironmentHttpBaseUrl,
} from "./knownEnvironment";
import { scopedRefKey, scopeProjectRef, scopeThreadRef } from "./scoped";

describe("known environment bootstrap helpers", () => {
  it("creates known environments from explicit ws urls", () => {
    expect(
      createKnownEnvironmentFromWsUrl({
        label: "Remote environment",
        wsUrl: "wss://remote.example.com/ws",
      }),
    ).toEqual({
      id: "ws:Remote environment",
      label: "Remote environment",
      source: "manual",
      target: {
        type: "ws",
        wsUrl: "wss://remote.example.com/ws",
      },
    });
  });

  it("converts websocket base urls into fetchable http origins", () => {
    expect(
      getKnownEnvironmentHttpBaseUrl(
        createKnownEnvironmentFromWsUrl({
          label: "Local environment",
          wsUrl: "ws://localhost:3773/ws",
        }),
      ),
    ).toBe("http://localhost:3773/ws");

    expect(
      getKnownEnvironmentHttpBaseUrl(
        createKnownEnvironmentFromWsUrl({
          label: "Remote environment",
          wsUrl: "wss://remote.example.com/api/ws",
        }),
      ),
    ).toBe("https://remote.example.com/api/ws");
  });
});

describe("scoped refs", () => {
  const environmentId = EnvironmentId.makeUnsafe("environment-test");
  const projectRef = scopeProjectRef(environmentId, ProjectId.makeUnsafe("project-1"));
  const threadRef = scopeThreadRef(environmentId, ThreadId.makeUnsafe("thread-1"));

  it("builds stable scoped project and thread keys", () => {
    expect(scopedRefKey(projectRef)).toBe("environment-test:project-1");
    expect(scopedRefKey(threadRef)).toBe("environment-test:thread-1");
  });

  it("returns typed scoped refs", () => {
    expect(projectRef).toEqual({
      environmentId,
      projectId: ProjectId.makeUnsafe("project-1"),
    });
    expect(threadRef).toEqual({
      environmentId,
      threadId: ThreadId.makeUnsafe("thread-1"),
    });
  });
});
