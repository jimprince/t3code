import { describe, expect, it } from "vitest";

import {
  buildModelSelection,
  buildProjectCreateCommand,
  buildProjectDeleteCommand,
  buildProjectMetaUpdateCommand,
  deriveProjectTitle,
  findExistingProjectByPath,
  listThreadsForProject,
  normalizeProjectPath,
  parseModelOptionEntries,
  resolveProjectTarget,
} from "../src/projects.js";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "../src/types.js";

function makeProject(overrides: Partial<OrchestrationProjectShell> = {}): OrchestrationProjectShell {
  return {
    id: "project-1",
    title: "Project One",
    workspaceRoot: "/tmp/project-one",
    defaultModelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Thread One",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("project helpers", () => {
  it("rejects relative project paths", () => {
    expect(() => normalizeProjectPath("relative/path")).toThrow("Project path must be absolute");
  });

  it("rejects unexpanded home paths", () => {
    expect(() => normalizeProjectPath("~/Programming/repo")).toThrow("shell-expand '~'");
  });

  it("normalizes trailing slashes", () => {
    expect(normalizeProjectPath("/tmp/project-one/")).toBe("/tmp/project-one");
  });

  it("supports Windows-style absolute paths for remote Windows environments", () => {
    expect(normalizeProjectPath("C:\\Users\\brad\\repo\\")).toBe("C:\\Users\\brad\\repo");
  });

  it("derives titles from workspace basenames", () => {
    expect(deriveProjectTitle("/home/brad/Programming/t3-thread")).toBe("t3-thread");
  });

  it("normalizes explicit titles", () => {
    expect(deriveProjectTitle("/home/brad/repo", " Repo Title ")).toBe("Repo Title");
  });

  it("resolves a project by id before checking workspace paths", () => {
    const project = resolveProjectTarget(
      [
        makeProject({ id: "/tmp/project-one", workspaceRoot: "/tmp/other" }),
        makeProject({ id: "project-2", workspaceRoot: "/tmp/project-one" }),
      ],
      "/tmp/project-one",
    );

    expect(project.id).toBe("/tmp/project-one");
  });

  it("resolves a project by exact normalized workspace root", () => {
    const project = resolveProjectTarget(
      [makeProject({ id: "project-1", workspaceRoot: "/tmp/project-one/" })],
      "/tmp/project-one",
    );

    expect(project.id).toBe("project-1");
  });

  it("rejects ambiguous duplicate workspace roots", () => {
    expect(() =>
      resolveProjectTarget(
        [
          makeProject({ id: "project-1", workspaceRoot: "/tmp/project-one" }),
          makeProject({ id: "project-2", workspaceRoot: "/tmp/project-one/" }),
        ],
        "/tmp/project-one",
      ),
    ).toThrow("Multiple active projects");
  });

  it("finds an existing project by normalized workspace root", () => {
    const project = findExistingProjectByPath(
      [makeProject({ workspaceRoot: "/tmp/project-one/" })],
      "/tmp/project-one",
    );

    expect(project?.id).toBe("project-1");
  });

  it("parses model option entries", () => {
    expect(parseModelOptionEntries(["reasoningEffort=high", "fastMode=true"])).toEqual({
      reasoningEffort: "high",
      fastMode: true,
    });
  });

  it("builds the default model selection", () => {
    expect(buildModelSelection({})).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("builds a custom model selection", () => {
    expect(
      buildModelSelection({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        optionEntries: ["thinking=true", "effort=high"],
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: {
        thinking: true,
        effort: "high",
      },
    });
  });

  it("normalizes opencode model aliases to provider/model slugs", () => {
    expect(
      buildModelSelection({
        provider: "opencode",
        model: "antigravity-gemini-3.5-flash-high",
      }),
    ).toEqual({
      provider: "opencode",
      model: "google/antigravity-gemini-3.5-flash-high",
    });
  });

  it("uses an opencode default model when provider is opencode", () => {
    expect(
      buildModelSelection({
        provider: "opencode",
      }),
    ).toEqual({
      provider: "opencode",
      model: "google/antigravity-gemini-3.5-flash-high",
    });
  });

  it("returns null when clearing or disabling default model selection", () => {
    expect(buildModelSelection({ clear: true })).toBeNull();
    expect(buildModelSelection({ noDefault: true })).toBeNull();
  });

  it("rejects conflicting clear/default model flags", () => {
    expect(() => buildModelSelection({ clear: true, provider: "codex", model: "gpt-5.4" })).toThrow(
      "`--clear` cannot be combined",
    );
    expect(() => buildModelSelection({ noDefault: true, model: "gpt-5.4" })).toThrow(
      "`--no-default-model` cannot be combined",
    );
  });

  it("builds project.create payloads", () => {
    expect(
      buildProjectCreateCommand({
        commandId: "cmd-1",
        projectId: "project-1",
        title: "Project One",
        workspaceRoot: "/tmp/project-one/",
        createWorkspaceRootIfMissing: true,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      type: "project.create",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "Project One",
      workspaceRoot: "/tmp/project-one",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("builds project.meta.update payloads for rename and model changes", () => {
    expect(
      buildProjectMetaUpdateCommand({
        commandId: "cmd-1",
        projectId: "project-1",
        title: " New Name ",
      }),
    ).toEqual({
      type: "project.meta.update",
      commandId: "cmd-1",
      projectId: "project-1",
      title: "New Name",
    });

    expect(
      buildProjectMetaUpdateCommand({
        commandId: "cmd-2",
        projectId: "project-1",
        defaultModelSelection: null,
      }),
    ).toEqual({
      type: "project.meta.update",
      commandId: "cmd-2",
      projectId: "project-1",
      defaultModelSelection: null,
    });
  });

  it("builds project.delete payloads with force only when explicit", () => {
    expect(buildProjectDeleteCommand({ commandId: "cmd-1", projectId: "project-1" })).toEqual({
      type: "project.delete",
      commandId: "cmd-1",
      projectId: "project-1",
    });
    expect(
      buildProjectDeleteCommand({ commandId: "cmd-1", projectId: "project-1", force: true }),
    ).toEqual({
      type: "project.delete",
      commandId: "cmd-1",
      projectId: "project-1",
      force: true,
    });
  });

  it("lists threads for a project", () => {
    expect(
      listThreadsForProject(
        [makeThread(), makeThread({ id: "thread-2", projectId: "project-2" })],
        "project-1",
      ).map((thread) => thread.id),
    ).toEqual(["thread-1"]);
  });
});
