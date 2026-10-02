import { OrchestrationBriefThreadError } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { collectThreadBriefTranscript } from "../../textGeneration/ThreadBriefPrompt.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadBrief, type ThreadBriefShape } from "../Services/ThreadBrief.ts";

const BRIEF_ACTIVITY_KINDS = ["approval.requested", "user-input.requested"];

const briefError = (message: string) => (cause: unknown) =>
  new OrchestrationBriefThreadError({ message, cause });

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;

  const briefThread: ThreadBriefShape["briefThread"] = (input) =>
    Effect.gen(function* () {
      const thread = yield* snapshots
        .getThreadDetailById(input.threadId, { activityKinds: BRIEF_ACTIVITY_KINDS })
        .pipe(Effect.mapError(briefError("Could not read the thread.")));
      if (Option.isNone(thread)) {
        return yield* new OrchestrationBriefThreadError({ message: "Thread not found." });
      }
      const transcript = collectThreadBriefTranscript(thread.value);
      const generatedAt = DateTime.formatIso(yield* DateTime.now);
      const empty = { needsYou: [], done: [], moving: [], blocked: [] };
      if (transcript.lines.length === 0) {
        return { generatedAt, turnCount: 0, ...empty };
      }
      if (!textGeneration.generateThreadBrief) {
        return yield* new OrchestrationBriefThreadError({
          message: "Brief me is not available on this server.",
        });
      }

      const project = yield* snapshots
        .getProjectShellById(thread.value.projectId)
        .pipe(Effect.mapError(briefError("Could not read the thread's project.")));
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(briefError("Could not read server settings.")),
      );
      const output = yield* textGeneration
        .generateThreadBrief({
          cwd:
            resolveThreadWorkspaceCwd({
              thread: thread.value,
              projects: Option.toArray(project),
            }) ?? process.cwd(),
          threadTitle: thread.value.title,
          transcript,
          modelSelection: resolveProjectSettings(settings, thread.value.projectId).settings
            .textGenerationModelSelection,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationBriefThreadError({
                message: cause.detail.trim() || "Brief generation failed.",
                cause,
              }),
          ),
        );
      return { generatedAt, turnCount: transcript.turnCount, ...output };
    });

  return ThreadBrief.of({ briefThread });
});

export const ThreadBriefLive = Layer.effect(ThreadBrief, make);
