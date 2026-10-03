import {
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  NamedAgentError,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerSettingsService } from "../../serverSettings.ts";
import { buildIncarnationMessage, readAgentScope } from "../namedAgentBriefing.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { NamedAgents, type NamedAgentsShape } from "../Services/NamedAgents.ts";

const agentError = (message: string) => (cause: unknown) => new NamedAgentError({ message, cause });

function liveIncarnation(snapshot: OrchestrationShellSnapshot, project: OrchestrationProjectShell) {
  return (
    snapshot.threads.find(
      (thread) =>
        thread.projectId === project.id &&
        thread.archivedAt === null &&
        (thread.parentThreadId ?? null) === null,
    ) ?? null
  );
}

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const serverSettings = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const newId = crypto.randomUUIDv4.pipe(Effect.mapError(agentError("Could not create an id.")));

  const readOptional = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed(() => null as string | null));

  const loadSnapshot = snapshots
    .getShellSnapshot()
    .pipe(Effect.mapError(agentError("Could not read the named agents.")));

  const requireAgent = (snapshot: OrchestrationShellSnapshot, name: string) => {
    const project = snapshot.projects.find((candidate) => candidate.permanentAgent?.name === name);
    return project
      ? Effect.succeed(project)
      : Effect.fail(new NamedAgentError({ message: `No named agent '${name}' on this server.` }));
  };

  /** Create a fresh incarnation and send its first message, built from the agent folder. */
  const startIncarnation = Effect.fn("NamedAgents.startIncarnation")(function* (input: {
    readonly project: OrchestrationProjectShell;
    readonly name: string;
    readonly request: string | undefined;
    readonly handoverFromThreadId?: ThreadId;
  }) {
    const folder = input.project.workspaceRoot;
    const [agentMarkdown, briefingMarkdown] = yield* Effect.all([
      readOptional(path.join(folder, "AGENT.md")),
      readOptional(path.join(folder, "BRIEFING.md")),
    ]);
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(agentError("Could not read server settings.")),
    );
    const modelSelection = resolveProjectSettings(settings, input.project.id, input.project)
      .settings.defaultModelSelection ??
      settings.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    const threadId = ThreadId.make(yield* newId);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(yield* newId),
        threadId,
        projectId: input.project.id,
        title: input.name,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
        ...(input.handoverFromThreadId ? { handoverFromThreadId: input.handoverFromThreadId } : {}),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new NamedAgentError({
              message: "detail" in cause && cause.detail ? String(cause.detail) : cause.message,
              cause,
            }),
        ),
      );
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(yield* newId),
        threadId,
        message: {
          messageId: MessageId.make(yield* newId),
          role: "user",
          text: buildIncarnationMessage({
            name: input.name,
            folder,
            agentMarkdown,
            briefingMarkdown,
            request: input.request,
          }),
          attachments: [],
        },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt,
      })
      .pipe(
        Effect.mapError(agentError(`Started ${threadId} but could not send its first message.`)),
      );
    return threadId;
  });

  const list: NamedAgentsShape["list"] = () =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot;
      const agents = yield* Effect.forEach(
        snapshot.projects.filter((project) => project.permanentAgent),
        (project) =>
          readOptional(path.join(project.workspaceRoot, "AGENT.md")).pipe(
            Effect.map((agentMarkdown) => ({
              name: project.permanentAgent!.name,
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
              scope: readAgentScope(agentMarkdown),
              liveThreadId: liveIncarnation(snapshot, project)?.id ?? null,
            })),
          ),
      );
      return { agents: agents.toSorted((left, right) => left.name.localeCompare(right.name)) };
    });

  const resolve: NamedAgentsShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot;
      const project = yield* requireAgent(snapshot, input.name);
      const live = liveIncarnation(snapshot, project);
      if (live) return { threadId: live.id, started: false };
      return yield* startIncarnation({ project, name: input.name, request: input.message }).pipe(
        Effect.map((threadId) => ({ threadId, started: true })),
        // Two callers can race to start a dormant agent; the decider admits one.
        Effect.catch((error) =>
          loadSnapshot.pipe(
            Effect.flatMap((latest) => {
              const winner = liveIncarnation(latest, project);
              return winner
                ? Effect.succeed({ threadId: winner.id, started: false })
                : Effect.fail(error);
            }),
          ),
        ),
      );
    });

  const handOver: NamedAgentsShape["handOver"] = (input) =>
    Effect.gen(function* () {
      const snapshot = yield* loadSnapshot;
      const project = yield* requireAgent(snapshot, input.name);
      const live = liveIncarnation(snapshot, project);
      const threadId = yield* startIncarnation({
        project,
        name: input.name,
        request: input.message,
        ...(live ? { handoverFromThreadId: live.id } : {}),
      });
      return { threadId, started: true };
    });

  return NamedAgents.of({ list, resolve, handOver });
});

export const NamedAgentsLive = Layer.effect(NamedAgents, make);
