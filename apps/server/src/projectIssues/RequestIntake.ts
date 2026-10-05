import {
  CommandId,
  ProjectIssuesError,
  ThreadId,
  type ProjectRequestStartIntakeInput,
  type ProjectRequestStartIntakeResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderRegistryShape } from "../provider/Services/ProviderRegistry.ts";
import { findRootThreadId } from "./projectIssues.logic.ts";
import { buildIntakeBrief, clampTitle, intakeModelSelection } from "./requestLedger.logic.ts";

const fail = (message: string) => new ProjectIssuesError({ message });

/**
 * The New request box's intake: a short-lived thread nested under the project's
 * orchestrator that triages one request with a fixed brief, so the orchestrator
 * is woken only when the request needs starting now or needs its decision. The
 * client sends the brief and Brad's words (with any images) as its first turn.
 */
export const make = (deps: {
  readonly engine: OrchestrationEngineShape;
  readonly providers: ProviderRegistryShape;
}) =>
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const newId = crypto.randomUUIDv4.pipe(Effect.mapError(() => fail("Could not create an id.")));

    const start = (input: ProjectRequestStartIntakeInput) =>
      Effect.gen(function* () {
        const snapshot = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read threads.")));
        const rootThreadId = findRootThreadId(snapshot.threads, input.threadId);
        const root = snapshot.threads.find((thread) => thread.id === rootThreadId);
        const project = root
          ? snapshot.projects.find((candidate) => candidate.id === root.projectId)
          : undefined;
        if (!root || !project) return yield* fail("This project's orchestrator was not found.");
        const providers = yield* deps.providers.getProviders;
        const modelSelection = intakeModelSelection(providers, root.modelSelection);
        const threadId = ThreadId.make(yield* newId);
        const firstLine = input.title.split("\n")[0]!.trim() || "New request";
        yield* deps.engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* newId),
            threadId,
            projectId: project.id,
            title: clampTitle(`Intake: ${firstLine}`).slice(0, 80),
            modelSelection: modelSelection as typeof root.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            parentThreadId: root.id,
            // A finished triage leaves the active list on its own.
            settleOnComplete: true,
          })
          .pipe(Effect.mapError(() => fail("Could not create the intake thread.")));
        return {
          threadId,
          modelSelection: modelSelection as typeof root.modelSelection,
          brief: buildIntakeBrief({
            projectTitle: project.title,
            orchestratorThreadId: root.id,
            orchestratorTitle: root.title,
            projectId: project.id,
          }),
        } satisfies ProjectRequestStartIntakeResult;
      });

    return { start };
  });
