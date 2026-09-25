import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  partitionProjectsByKind,
  groupChatProjectsByEnvironment,
  selectCanonicalChatProjectsByEnvironment,
  selectChatProjectForEnvironment,
  selectDefaultThreadProject,
  selectRecentThreadProjectRef,
} from "./projectKind";

describe("partitionProjectsByKind", () => {
  it("keeps chat projects out of workspace project grouping", () => {
    const projects = [
      { id: "workspace-a", kind: "workspace" },
      { id: "chat-primary", kind: "chat" },
      { id: "legacy-workspace" },
      { id: "chat-remote", kind: "chat" },
    ] as const;

    expect(partitionProjectsByKind(projects)).toEqual({
      chatProjects: [projects[1], projects[3]],
      workspaceProjects: [projects[0], projects[2]],
    });
  });

  it("prefers a workspace project for generic new-thread actions", () => {
    const chat = { id: "chat", kind: "chat" } as const;
    const workspace = { id: "workspace", kind: "workspace" } as const;

    expect(selectDefaultThreadProject([chat, workspace])).toBe(workspace);
    expect(selectDefaultThreadProject([chat])).toBe(chat);
    expect(selectDefaultThreadProject([])).toBeNull();
  });

  it("selects chat only for the requested environment", () => {
    const projects = [
      { id: "workspace", environmentId: "primary", kind: "workspace" },
      { id: "remote-chat", environmentId: "remote", kind: "chat" },
      { id: "primary-chat", environmentId: "primary", kind: "chat" },
    ] as const;

    expect(selectChatProjectForEnvironment(projects, "primary")).toBe(projects[2]);
    expect(selectChatProjectForEnvironment(projects, "missing")).toBeNull();
    expect(selectChatProjectForEnvironment(projects, null)).toBeNull();
  });

  it("selects the newest canonical chat and groups legacy chat projects", () => {
    const legacy = {
      id: "legacy-chat",
      environmentId: "primary",
      kind: "chat",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const canonical = {
      id: "canonical-chat",
      environmentId: "primary",
      kind: "chat",
      createdAt: "2026-07-18T00:00:00.000Z",
    } as const;
    const remote = {
      id: "remote-chat",
      environmentId: "remote",
      kind: "chat",
      createdAt: "2026-07-18T00:00:00.000Z",
    } as const;

    expect(selectChatProjectForEnvironment([legacy, canonical, remote], "primary")).toBe(canonical);
    expect(groupChatProjectsByEnvironment([legacy, canonical, remote])).toEqual([
      [legacy, canonical],
      [remote],
    ]);
    expect(selectCanonicalChatProjectsByEnvironment([legacy, canonical, remote])).toEqual([
      canonical,
      remote,
    ]);
  });
});

describe("selectRecentThreadProjectRef", () => {
  const environmentId = EnvironmentId.make("env-1");
  const project = (id: string) => ({ environmentId, id: ProjectId.make(id) });
  const thread = (projectId: string, latestUserMessageAt: string | null, archivedAt = null) => ({
    environmentId,
    projectId: ProjectId.make(projectId),
    latestUserMessageAt,
    archivedAt,
  });
  const projects = [project("chat"), project("t3code"), project("job")];

  it("REGRESSION: picks the project the user most recently messaged, not General Chat", () => {
    // New threads always opened in General Chat, even right after working
    // in a repository.
    expect(
      selectRecentThreadProjectRef(
        [
          thread("chat", "2026-09-25T10:00:00.000Z"),
          thread("t3code", "2026-09-25T12:00:00.000Z"),
          thread("job", "2026-09-25T11:00:00.000Z"),
        ],
        projects,
      ),
    ).toEqual({ environmentId, projectId: "t3code" });
  });

  it("skips archived threads, unmessaged threads, and projects that are not loaded", () => {
    expect(
      selectRecentThreadProjectRef(
        [
          thread("job", "2026-09-25T09:00:00.000Z"),
          {
            ...thread("t3code", "2026-09-25T12:00:00.000Z"),
            archivedAt: "2026-09-25T13:00:00.000Z",
          },
          thread("chat", null),
          thread("deleted", "2026-09-25T14:00:00.000Z"),
        ],
        projects,
      ),
    ).toEqual({ environmentId, projectId: "job" });
  });

  it("is null when there is no messaged thread", () => {
    expect(selectRecentThreadProjectRef([], projects)).toBeNull();
  });
});
