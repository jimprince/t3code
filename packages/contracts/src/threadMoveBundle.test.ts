import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ThreadMoveBundle, ThreadMoveBundleV1 } from "./orchestration.ts";

const decodeCurrent = Schema.decodeUnknownEffect(ThreadMoveBundle);
const decodeLegacy = Schema.decodeUnknownEffect(ThreadMoveBundleV1);

const threadMoveBundleBase = {
  exportedAt: "2026-01-01T00:00:00.000Z",
  sourceProjectId: "project-1",
  sourceWorkspaceRoot: "/source/project",
  repositoryIdentity: null,
  thread: {
    id: "thread-1",
    title: "Portable thread",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    goal: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
  git: null,
  providerSession: null,
  warnings: [],
} as const;

it.effect("ThreadMoveBundle accepts v1 and v2 while a strict v1 target rejects v2", () =>
  Effect.gen(function* () {
    const v1 = { version: 1, ...threadMoveBundleBase } as const;
    const v2 = {
      version: 2,
      ...threadMoveBundleBase,
      attachments: [{ id: "attachment-1", contentBase64: "AAE=" }],
    } as const;

    assert.strictEqual((yield* decodeCurrent(v1)).version, 1);
    assert.strictEqual((yield* decodeCurrent(v2)).version, 2);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(decodeLegacy(v2))));
  }),
);
