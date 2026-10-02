import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadLaunchInput,
} from "@t3tools/contracts";
import {
  OrchestrationThreadStreamItem,
  decodeShellSnapshotItem,
  decodeShellStreamItem,
  decodeThreadSnapshotItem,
  decodeThreadStreamItem,
  encodeClientOrchestrationCommand,
} from "../src/contracts.js";
import { at, item, projection, shell, shellSnapshot } from "./v2-fixture.js";

const encodeProjection = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadProjection));
const encodeLaunch = Schema.encodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const snapshot = (value: ReturnType<typeof projection>) => ({
  kind: "snapshot" as const,
  snapshotSequence: 1,
  projection: value,
});
const selection = {
  instanceId: "codex_personal",
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

describe("V2 orchestration model option compatibility", () => {
  it("converts declared selections without rewriting opaque tool payloads", () => {
    const opaque = {
      provider: "opaque-provider",
      instanceId: "opaque-instance",
      model: "opaque-model",
      options: { nested: [{ id: "opaque", value: { provider: "value-provider" } }] },
    };
    const base = projection();
    const native = projection({
      thread: {
        ...encodeProjection(base).thread,
        modelSelection: selection,
      },
      turnItems: [
        item("dynamic_tool", at(), { toolName: "opaque", input: opaque, output: opaque }),
      ],
    });
    const decoded = decodeThreadSnapshotItem(snapshot(native));
    expect(decoded.snapshot.thread.modelSelection).toEqual({
      provider: selection.instanceId,
      model: selection.model,
      options: { reasoningEffort: "high" },
    });
    expect(decoded.snapshot.thread.projection?.turnItems[0]).toMatchObject({
      input: opaque,
      output: opaque,
    });
    const codec = Schema.toCodecJson(OrchestrationThreadStreamItem);
    const roundTrip = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(snapshot(native)));
    expect(roundTrip).toEqual(snapshot(native));
  });

  it("round-trips model selections in native historical events", () => {
    const base = projection();
    const event = {
      kind: "event" as const,
      sequence: 2,
      event: {
        id: "event-model",
        threadId: base.thread.id,
        occurredAt: base.updatedAt,
        type: "thread.model-selection-updated",
        payload: { ...base.thread, modelSelection: selection },
      },
    };
    const codec = Schema.toCodecJson(OrchestrationThreadStreamItem);
    const wire = Schema.encodeUnknownSync(codec)(event);
    expect(Schema.encodeSync(codec)(Schema.decodeUnknownSync(codec)(wire))).toEqual(wire);
  });

  it.each(["codex", "claudeAgent", "opencode", "claudeAgent_ucalgary"])(
    "decodes array-shaped options for the app-visible instance %s",
    (instanceId) => {
      const decoded = decodeShellSnapshotItem(
        shellSnapshot([
          shell({
            providerInstanceId: instanceId,
            modelSelection: { ...selection, instanceId },
          }),
        ]),
      );
      expect(decoded.snapshot.threads[0]?.modelSelection).toEqual({
        provider: instanceId,
        model: selection.model,
        options: { reasoningEffort: "high" },
      });
    },
  );

  it("encodes outbound selections with the native instanceId shape", () => {
    expect(
      encodeClientOrchestrationCommand({
        type: "thread.model-selection.set",
        commandId: "set-model",
        threadId: "worker",
        modelSelection: selection,
      }),
    ).toMatchObject({ modelSelection: selection });
  });

  it("encodes launch selections without visiting message payloads", () => {
    const text = JSON.stringify({ provider: "opaque", model: "opaque-model", options: { x: 1 } });
    const launch = {
      commandId: "launch",
      threadId: "worker",
      projectId: "project",
      title: "Worker",
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { messageId: "prompt", text, attachments: [] },
    };
    const wire = encodeLaunch(launch);
    expect(wire).toMatchObject({ modelSelection: selection, initialMessage: { text } });
  });

  it("reads V2 projections with imported attachments and unset lifecycle fields", () => {
    const native = projection({
      messages: [
        {
          id: "message",
          threadId: "worker",
          runId: null,
          nodeId: null,
          role: "user",
          text: "Imported history",
          attachments: [
            {
              type: "file",
              id: "file-1",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 20,
            },
            {
              type: "future",
              id: "file-2",
              name: "future",
              mimeType: "application/octet-stream",
              sizeBytes: 10,
            },
          ],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: at(),
          updatedAt: at(),
        },
      ],
    });
    const decoded = decodeThreadSnapshotItem(snapshot(native));
    expect(decoded.snapshot.thread.messages[0]?.attachments).toEqual(
      native.messages[0]?.attachments,
    );
    expect(decoded.snapshot.thread.settledAt).toBeNull();
    expect(decoded.snapshot.thread.executionParentThreadId).toBe("parent");
    expect(decoded.snapshot.thread.parentThreadId).toBeNull();
  });

  it("keeps the shared native shell and thread event schemas active", () => {
    expect(
      decodeShellStreamItem({
        kind: "thread.removed",
        location: "active",
        threadId: "worker",
        sequence: 9,
      }),
    ).toMatchObject({ kind: "thread.removed", threadId: "worker" });
    const native = projection();
    expect(
      decodeThreadStreamItem({
        kind: "event",
        sequence: 3,
        event: {
          id: "event-archive",
          threadId: "worker",
          occurredAt: native.updatedAt,
          type: "thread.archived",
          payload: native.thread,
        },
      }),
    ).toMatchObject({
      kind: "event",
      event: { type: "thread.archived" },
    });
  });
  // M3 obligation: fork-thread-goals must port goal recovery into the V2 projection and legacy history view.
  it.skip("preserves historical goals and both attachment generations while defaulting lifecycle", () => {
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

});
