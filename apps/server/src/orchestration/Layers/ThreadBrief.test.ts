import {
  MessageId,
  ProjectId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  TextGeneration,
  type ThreadBriefGenerationInput,
} from "../../textGeneration/TextGeneration.ts";
import { collectThreadBriefTranscript } from "../../textGeneration/ThreadBriefPrompt.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBrief } from "../Services/ThreadBrief.ts";
import { ThreadBriefLive } from "./ThreadBrief.ts";

const threadId = ThreadId.make("orchestrator");
const projectId = ProjectId.make("project");

function message(
  id: string,
  role: "user" | "assistant",
  createdAt: string,
  text: string,
  fromName?: string,
) {
  return {
    id: MessageId.make(id),
    role,
    text,
    turnId: role === "assistant" ? TurnId.make(`turn-${id}`) : null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...(fromName
      ? { context: makeMessageOriginContext({ source: "worker-notification", fromName }) }
      : {}),
  };
}

function makeThread(messages: ReadonlyArray<ReturnType<typeof message>>): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "t3-orchestrator",
    worktreePath: null,
    messages,
    activities: [
      {
        id: "request-old",
        kind: "approval.requested",
        summary: "Run the old migration?",
        createdAt: "2026-10-02T10:00:30.000Z",
        turnId: null,
      },
      {
        id: "request-new",
        kind: "approval.requested",
        summary: "Home J3 to 0 degrees?",
        createdAt: "2026-10-02T10:05:00.000Z",
        turnId: null,
      },
    ],
  } as unknown as OrchestrationThread;
}

const history = [
  message("early-notice", "user", "2026-10-02T10:00:00.000Z", "notice before", "ci-repair"),
  message("brad", "user", "2026-10-02T10:01:00.000Z", "Keep the arm moving."),
  message("ack", "assistant", "2026-10-02T10:01:30.000Z", "Started arm-calib."),
  message("notice", "user", "2026-10-02T10:04:00.000Z", "arm-calib completed", "arm-calib"),
  message("relay", "assistant", "2026-10-02T10:04:30.000Z", "Asked Brad to approve J3."),
];

describe("collectThreadBriefTranscript", () => {
  it("covers only what happened since the user's last message", () => {
    const transcript = collectThreadBriefTranscript(makeThread(history));

    expect(transcript.turnCount).toBe(1);
    expect(transcript.lines).toEqual([
      "[2026-10-02T10:01:30.000Z] orchestrator: Started arm-calib.",
      "[2026-10-02T10:04:00.000Z] from arm-calib: arm-calib completed",
      "[2026-10-02T10:04:30.000Z] orchestrator: Asked Brad to approve J3.",
      "[2026-10-02T10:05:00.000Z] request to the user: Home J3 to 0 degrees?",
    ]);
  });
});

function layer(input: {
  readonly thread: OrchestrationThread;
  readonly generateThreadBrief?: TextGeneration["Service"]["generateThreadBrief"];
}) {
  return ThreadBriefLive.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: () => Effect.succeed(Option.some(input.thread)),
        getProjectShellById: () =>
          Effect.succeed(Option.some({ id: projectId, workspaceRoot: "/srv/agents/k1" } as never)),
      }),
    ),
    Layer.provide(
      Layer.mock(TextGeneration)(
        input.generateThreadBrief ? { generateThreadBrief: input.generateThreadBrief } : {},
      ),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
  );
}

describe("ThreadBrief", () => {
  it.effect("summarizes the transcript with the text generation model", () => {
    const requests: ThreadBriefGenerationInput[] = [];
    return Effect.gen(function* () {
      const brief = yield* (yield* ThreadBrief).briefThread({ threadId });

      expect(brief).toMatchObject({
        turnCount: 1,
        needsYou: ["Approve J3 homing (robot-arm)."],
        done: [],
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ cwd: "/srv/agents/k1", threadTitle: "t3-orchestrator" });
      expect(requests[0]!.transcript.lines).toHaveLength(4);
    }).pipe(
      Effect.provide(
        layer({
          thread: makeThread(history),
          generateThreadBrief: (request) => {
            requests.push(request);
            return Effect.succeed({
              needsYou: ["Approve J3 homing (robot-arm)."],
              done: [],
              moving: [],
              blocked: [],
            });
          },
        }),
      ),
    );
  });

  it.effect("answers without a model call when nothing happened since the user spoke", () =>
    Effect.gen(function* () {
      const brief = yield* (yield* ThreadBrief).briefThread({ threadId });

      expect(brief).toMatchObject({
        turnCount: 0,
        needsYou: [],
        done: [],
        moving: [],
        blocked: [],
      });
    }).pipe(
      Effect.provide(
        layer({
          thread: { ...makeThread(history.slice(0, 2)), activities: [] },
          generateThreadBrief: () => Effect.die("must not generate an empty brief"),
        }),
      ),
    ),
  );

  it.effect("passes the model's failure through to the caller", () =>
    Effect.gen(function* () {
      const error = yield* (yield* ThreadBrief).briefThread({ threadId }).pipe(Effect.flip);

      expect(error._tag).toBe("OrchestrationBriefThreadError");
      expect(error.message).toBe("Brief me needs a Codex or Claude text generation model.");
    }).pipe(
      Effect.provide(
        layer({
          thread: makeThread(history),
          generateThreadBrief: () =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadBrief",
                detail: "Brief me needs a Codex or Claude text generation model.",
              }),
            ),
        }),
      ),
    ),
  );
});
