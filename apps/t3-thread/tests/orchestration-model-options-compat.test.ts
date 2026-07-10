import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ClientOrchestrationCommand,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "../src/vendor/t3contracts/orchestration.js";

const decodeShellStreamItem = Schema.decodeUnknownSync(OrchestrationShellStreamItem);
const decodeThreadStreamItem = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);
const encodeClientCommand = Schema.encodeSync(ClientOrchestrationCommand);

describe("orchestration model option compatibility", () => {
  it("decodes legacy array-shaped model options in shell snapshots", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [],
        threads: [
          {
            id: "thread-1",
            projectId: "project-1",
            title: "Thread title",
            modelSelection: {
              provider: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
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
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.threads[0]?.modelSelection.options?.reasoningEffort).toBe("high");
  });

  it("decodes instanceId-shaped model selections in shell snapshots", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [
          {
            id: "project-1",
            title: "Project title",
            workspaceRoot: "/tmp/project",
            repositoryIdentity: null,
            defaultModelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: "thread-1",
            projectId: "project-1",
            title: "Thread title",
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [{ id: "reasoningEffort", value: "high" }],
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
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.projects[0]?.defaultModelSelection?.provider).toBe("codex");
    expect(parsed.snapshot.threads[0]?.modelSelection.provider).toBe("codex");
    expect(parsed.snapshot.threads[0]?.modelSelection.options?.reasoningEffort).toBe("high");
  });

  it("decodes opencode model selections in shell snapshots", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [
          {
            id: "project-opencode",
            title: "OpenCode project",
            workspaceRoot: "/tmp/project",
            repositoryIdentity: null,
            defaultModelSelection: {
              instanceId: "opencode",
              model: "google/antigravity-gemini-3.5-flash-high",
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        threads: [
          {
            id: "thread-opencode",
            projectId: "project-opencode",
            title: "OpenCode thread",
            modelSelection: {
              instanceId: "opencode",
              model: "google/antigravity-gemini-3.5-flash-low",
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
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.projects[0]?.defaultModelSelection).toEqual({
      provider: "opencode",
      model: "google/antigravity-gemini-3.5-flash-high",
    });
    expect(parsed.snapshot.threads[0]?.modelSelection).toEqual({
      provider: "opencode",
      model: "google/antigravity-gemini-3.5-flash-low",
    });
  });

  it("decodes app-visible custom provider instances in shell snapshots", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [
          {
            id: "project-custom-provider",
            title: "Custom provider project",
            workspaceRoot: "/tmp/project",
            repositoryIdentity: null,
            defaultModelSelection: {
              instanceId: "codex_personal",
              model: "gpt-5.5",
              options: [{ id: "reasoningEffort", value: "high" }],
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        threads: [
          {
            id: "thread-cursor",
            projectId: "project-custom-provider",
            title: "Cursor thread",
            modelSelection: {
              instanceId: "cursor",
              model: "composer-2",
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
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.projects[0]?.defaultModelSelection).toEqual({
      provider: "codex_personal",
      model: "gpt-5.5",
      options: {
        reasoningEffort: "high",
      },
    });
    expect(parsed.snapshot.threads[0]?.modelSelection).toEqual({
      provider: "cursor",
      model: "composer-2",
    });
  });

  it("encodes outbound model selections using the app's instanceId wire shape", () => {
    const encoded = encodeClientCommand({
      type: "project.create",
      commandId: "cmd-custom-provider",
      projectId: "project-custom-provider",
      title: "Custom provider project",
      workspaceRoot: "/tmp/project",
      defaultModelSelection: {
        provider: "cursor",
        model: "composer-2",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(encoded).toMatchObject({
      defaultModelSelection: {
        instanceId: "cursor",
        model: "composer-2",
      },
    });
    expect("provider" in (encoded as { defaultModelSelection: Record<string, unknown> }).defaultModelSelection).toBe(
      false,
    );
  });

  it("decodes exact legacy subscribeShell snapshot model selections", () => {
    const parsed = decodeShellStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [
          {
            id: "project-legacy",
            title: "Legacy project",
            workspaceRoot: "/tmp/project",
            repositoryIdentity: null,
            defaultModelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        threads: [],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.projects[0]?.defaultModelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("decodes exact legacy subscribeThread snapshot model selections", () => {
    const parsed = decodeThreadStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          id: "thread-legacy",
          projectId: "project-legacy",
          title: "Legacy thread",
          modelSelection: {
            instanceId: "codex",
            model: "gpt-5.5",
            options: [{ id: "reasoningEffort", value: "medium" }],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      },
    });

    expect(parsed.kind).toBe("snapshot");
    if (parsed.kind !== "snapshot") {
      throw new Error("Expected snapshot");
    }
    expect(parsed.snapshot.thread.modelSelection).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      options: {
        reasoningEffort: "medium",
      },
    });
  });
});
