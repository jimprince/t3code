import {
  CommandId,
  ProjectIssuesError,
  ThreadId,
  type ProjectRequestStartIntakeInput,
  type ProjectRequestStartIntakeResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { listMetadata } from "../forkThreads/MetadataStore.ts";
import { makeNestingService } from "../forkThreads/NestingService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { findRootThreadId } from "./projectIssues.logic.ts";
import { buildIntakeBrief, clampTitle, intakeModelSelection } from "./requestLedger.logic.ts";
import { deriveRequestTitle } from "./requestTitle.logic.ts";

const fail = (message: string) => new ProjectIssuesError({ message });

/**
 * The New request box's intake: a short-lived thread nested under the project's
 * orchestrator that triages one request with a fixed brief, so the orchestrator
 * is woken only when the request needs starting now or needs its decision. The
 * client sends the brief and Brad's words (with any images) as its first turn.
 */
export const make = (deps: { readonly providers: ProviderRegistry["Service"] }) =>
  Effect.gen(function* () {
    const engine = yield* ThreadManagement.ThreadManagementService;
    const projectService = yield* ProjectService.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const nesting = yield* makeNestingService(sql, engine.getThreadShell, engine.dispatch).pipe(
      Effect.orDie,
    );
    const newId = crypto.randomUUIDv4.pipe(Effect.mapError(() => fail("Could not create an id.")));

    const start = (input: ProjectRequestStartIntakeInput) =>
      Effect.gen(function* () {
        const snapshot = yield* engine
          .getShellSnapshot()
          .pipe(Effect.mapError(() => fail("Could not read threads.")));
        const parents = new Map(
          (yield* listMetadata(sql).pipe(
            Effect.mapError(() => fail("Could not read thread parents.")),
          )).map((row) => [row.threadId, row.parentThreadId]),
        );
        const threads = [...snapshot.threads, ...snapshot.archivedThreads].map((thread) => ({
          ...thread,
          parentThreadId: parents.get(thread.id) ?? null,
        }));
        const rootThreadId = findRootThreadId(threads, input.threadId);
        const root = threads.find((thread) => thread.id === rootThreadId);
        const project = root
          ? Option.getOrNull(
              yield* projectService
                .getShell(root.projectId)
                .pipe(Effect.mapError(() => fail("Could not read projects."))),
            )
          : null;
        if (!root || !project) return yield* fail("This project's orchestrator was not found.");
        const providers = yield* deps.providers.getProviders;
        const modelSelection = intakeModelSelection(providers, root.modelSelection);
        const threadId = ThreadId.make(yield* newId);
        const asked = deriveRequestTitle(input.title).title;
        yield* engine
          .dispatch({
            type: "thread.create",
            createdBy: "system",
            creationSource: "server",
            commandId: CommandId.make(yield* newId),
            threadId,
            projectId: project.id,
            title: clampTitle(`Intake: ${asked}`).slice(0, 80),
            modelSelection: modelSelection as typeof root.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          })
          .pipe(Effect.mapError(() => fail("Could not create the intake thread.")));
        // A finished triage leaves the active list on its own.
        yield* nesting
          .update({
            commandId: CommandId.make(yield* newId),
            threadId,
            parentThreadId: root.id,
            remoteParent: null,
            settleOnComplete: true,
          })
          .pipe(Effect.mapError(() => fail("Could not nest the intake thread.")));
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
