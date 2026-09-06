import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  OrchestrationThreadStreamItem,
  decodeShellSnapshotItem,
  decodeShellStreamItem as decodeAnyShellStreamItem,
  decodeThreadSnapshotItem,
  decodeThreadStreamItem as decodeAnyThreadStreamItem,
  encodeClientOrchestrationCommand,
} from "../src/contracts.js";

const decodeShellStreamItem = decodeShellSnapshotItem;
const decodeThreadStreamItem = decodeThreadSnapshotItem;
const encodeClientCommand = encodeClientOrchestrationCommand;
const decodeThreadStreamCodec = Schema.decodeUnknownSync(OrchestrationThreadStreamItem);
const encodeThreadStreamCodec = Schema.encodeUnknownSync(OrchestrationThreadStreamItem);

describe("orchestration model option compatibility", () => {
  it("converts declared selections without rewriting opaque activity payloads", () => {
    const opaque = {
      model: "opaque-model",
      provider: "opaque-provider",
      instanceId: "opaque-instance",
      options: {
        nested: {
          model: "nested-model",
          provider: "nested-provider",
          instanceId: "nested-instance",
          options: [{ id: "opaque", value: { model: "value-model", provider: "value-provider" } }],
        },
      },
    };
    const wire = {
      kind: "snapshot" as const,
      snapshot: {
        snapshotSequence: 1,
        thread: {
          id: "thread-opaque",
          projectId: "project-opaque",
          title: "Opaque payload fixture",
          modelSelection: {
            instanceId: "codex_personal",
            model: "gpt-5.5",
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
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [
            {
              id: "activity-opaque",
              tone: "tool",
              kind: "provider.payload",
              summary: "Opaque provider payload",
              payload: opaque,
              turnId: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          checkpoints: [],
          session: null,
        },
      },
    };

    const decoded = decodeThreadStreamCodec(wire);
    expect(decoded).toMatchObject({
      snapshot: {
        thread: {
          modelSelection: {
            provider: "codex_personal",
            model: "gpt-5.5",
            options: { reasoningEffort: "high" },
          },
          activities: [{ payload: opaque }],
        },
      },
    });

    const encoded = encodeThreadStreamCodec(decoded);
    expect(encoded).toMatchObject({
      snapshot: {
        thread: {
          modelSelection: {
            instanceId: "codex_personal",
            model: "gpt-5.5",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          activities: [{ payload: opaque }],
        },
      },
    });
  });

  it("round-trips model selections declared by historical events", () => {
    const wire = {
      kind: "event" as const,
      event: {
        sequence: 2,
        eventId: "event-model-selection",
        aggregateKind: "thread",
        aggregateId: "thread-opaque",
        occurredAt: "2026-01-01T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.meta-updated" as const,
        payload: {
          threadId: "thread-opaque",
          modelSelection: {
            instanceId: "claudeAgent_ucalgary",
            model: "claude-opus-5",
            options: [{ id: "effort", value: "high" }],
          },
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };

    const decoded = decodeThreadStreamCodec(wire);
    expect(decoded).toMatchObject({
      event: {
        payload: {
          modelSelection: {
            provider: "claudeAgent_ucalgary",
            model: "claude-opus-5",
            options: { effort: "high" },
          },
        },
      },
    });
    expect(encodeThreadStreamCodec(decoded)).toEqual(wire);
  });

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
    expect(
      "provider" in
        (encoded as { defaultModelSelection: Record<string, unknown> }).defaultModelSelection,
    ).toBe(false);
  });

  it("encodes both turn-start model-selection fields without visiting message payloads", () => {
    const encoded = encodeClientCommand({
      type: "thread.turn.start",
      commandId: "cmd-bootstrap-model",
      threadId: "thread-bootstrap-model",
      message: {
        messageId: "message-bootstrap-model",
        role: "user",
        text: "Start the worker",
        attachments: [],
      },
      modelSelection: {
        provider: "codex_personal",
        model: "gpt-5.5",
        options: { reasoningEffort: "high" },
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-bootstrap-model",
          title: "Bootstrap model",
          modelSelection: {
            provider: "codex_personal",
            model: "gpt-5.5",
            options: { reasoningEffort: "high" },
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(encoded).toMatchObject({
      modelSelection: {
        instanceId: "codex_personal",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
      bootstrap: {
        createThread: {
          modelSelection: {
            instanceId: "codex_personal",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        },
      },
    });
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

  it("preserves historical goals and both attachment generations while defaulting lifecycle", () => {
    const parsed = decodeThreadStreamItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 7,
        thread: {
          id: "thread-history",
          projectId: "project-history",
          title: "Historical thread",
          modelSelection: {
            provider: "claudeAgent",
            model: "claude-opus-5",
            options: { effort: "high" },
          },
          runtimeMode: "full-access",
          branch: null,
          worktreePath: "/tmp/history",
          latestTurn: null,
          goal: {
            goal: "Finish the migration",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            achievedAt: null,
            lastEvaluatedAt: null,
            lastReason: null,
            lastTurnId: null,
            continuationCount: 2,
          },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          deletedAt: null,
          messages: [
            {
              id: "message-history",
              role: "user",
              text: "Inspect both files",
              attachments: [
                {
                  type: "file",
                  id: "current-file",
                  name: "current.txt",
                  mimeType: "text/plain",
                  sizeBytes: 12,
                },
              ],
              fileAttachments: [
                {
                  type: "file",
                  id: "legacy-file",
                  name: "legacy.txt",
                  mimeType: "text/plain",
                  sizeBytes: 12,
                  path: "/tmp/t3-file-attachments/legacy.txt",
                },
              ],
              turnId: null,
              streaming: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        },
      },
    });

    expect(parsed.snapshot.thread).toMatchObject({
      interactionMode: "default",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      goal: { goal: "Finish the migration", continuationCount: 2 },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-5",
        options: { effort: "high" },
      },
    });
    expect(parsed.snapshot.thread.messages[0]).toMatchObject({
      attachments: [{ id: "current-file", type: "file" }],
      fileAttachments: [{ id: "legacy-file", path: "/tmp/t3-file-attachments/legacy.txt" }],
    });
  });

  it("keeps shared shell and historical thread event schemas active", () => {
    expect(
      decodeAnyShellStreamItem({
        kind: "thread-removed",
        sequence: 9,
        threadId: "thread-history",
      }),
    ).toMatchObject({ kind: "thread-removed", sequence: 9, threadId: "thread-history" });

    expect(
      decodeAnyThreadStreamItem({
        kind: "event",
        event: {
          sequence: 10,
          eventId: "event-history",
          aggregateKind: "thread",
          aggregateId: "thread-history",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: { historyImport: true },
          type: "thread.message-sent",
          payload: {
            threadId: "thread-history",
            messageId: "message-history",
            role: "user",
            text: "Legacy handoff",
            fileAttachments: [
              {
                type: "file",
                id: "legacy-file",
                name: "legacy.txt",
                mimeType: "text/plain",
                sizeBytes: 12,
                path: "/tmp/t3-file-attachments/legacy.txt",
              },
            ],
            turnId: null,
            streaming: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    ).toMatchObject({
      kind: "event",
      event: {
        type: "thread.message-sent",
        payload: { fileAttachments: [{ id: "legacy-file" }] },
      },
    });
  });
});
