import {
  CommandId,
  DEFAULT_MODEL,
  MessageId,
  NamedAgentError,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type ResolveNamedAgentInput,
  type HandOverNamedAgentInput,
  type NamedAgentThreadResult,
  type ListNamedAgentsResult,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { liveRoots } from "./NamedAgentPolicy.ts";
import { buildIncarnationMessage, readAgentScope } from "./namedAgentBriefing.ts";

const agentError = (cause: unknown) =>
  Schema.is(NamedAgentError)(cause)
    ? cause
    : new NamedAgentError({ message: String(cause), cause });

/** Named-agent transport methods reuse native create/send receipts and queue behavior. */
export const makeNamedAgents = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4;
  const readOptional = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed(() => null as string | null));
  const requireAgent = Effect.fn("NamedAgents.requireAgent")(function* (name: string) {
    const project = (yield* projects.listShells()).find(
      (project) => project.permanentAgent?.name === name,
    );
    if (!project)
      return yield* new NamedAgentError({ message: `No named agent '${name}' on this server.` });
    return project;
  });
  const live = (project: OrchestrationProjectShell) =>
    liveRoots(sql, project.id).pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id))),
    );
  const start = Effect.fn("NamedAgents.start")(function* (
    project: OrchestrationProjectShell,
    message?: string,
    handoverFromThreadId?: ThreadId,
  ) {
    const folder = project.workspaceRoot;
    const [agentMarkdown, briefingMarkdown] = yield* Effect.all([
      readOptional(path.join(folder, "AGENT.md")),
      readOptional(path.join(folder, "BRIEFING.md")),
    ]);
    const settings = yield* settingsService.getSettings;
    const modelSelection = resolveProjectSettings(settings, project.id, project).settings
      .defaultModelSelection ??
      settings.defaultModelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_MODEL,
      };
    const threadId = ThreadId.make(yield* newId);
    yield* threads.dispatch({
      type: "thread.create",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(yield* newId),
      threadId,
      projectId: project.id,
      title: project.permanentAgent!.name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(handoverFromThreadId === undefined ? {} : { handoverFromThreadId }),
    });
    yield* threads.dispatch({
      type: "message.dispatch",
      createdBy: "system",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
      commandId: CommandId.make(yield* newId),
      threadId,
      messageId: MessageId.make(yield* newId),
      text: buildIncarnationMessage({
        name: project.permanentAgent!.name,
        folder,
        agentMarkdown,
        briefingMarkdown,
        request: message,
      }),
      attachments: [],
      modelSelection,
    });
    return threadId;
  });
  const list = (): Effect.Effect<ListNamedAgentsResult, NamedAgentError> =>
    Effect.gen(function* () {
      const agents = yield* Effect.forEach(
        (yield* projects.listShells()).filter((p) => p.permanentAgent),
        (project) =>
          Effect.gen(function* () {
            return {
              name: project.permanentAgent!.name,
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
              scope: readAgentScope(
                yield* readOptional(path.join(project.workspaceRoot, "AGENT.md")),
              ),
              liveThreadId: yield* live(project),
            };
          }),
      );
      return { agents: agents.toSorted((a, b) => a.name.localeCompare(b.name)) };
    }).pipe(Effect.mapError(agentError));
  const resolve = (
    input: ResolveNamedAgentInput,
  ): Effect.Effect<NamedAgentThreadResult, NamedAgentError> =>
    Effect.gen(function* () {
      const project = yield* requireAgent(input.name);
      const current = yield* live(project);
      if (current !== null) return { threadId: current, started: false };
      return yield* start(project, input.message).pipe(
        Effect.map((threadId) => ({ threadId, started: true })),
        Effect.catch((error) =>
          live(project).pipe(
            Effect.flatMap((winner) =>
              winner === null
                ? Effect.fail(error)
                : Effect.succeed({ threadId: winner, started: false }),
            ),
          ),
        ),
      );
    }).pipe(Effect.mapError(agentError));
  const handOver = (
    input: HandOverNamedAgentInput,
  ): Effect.Effect<NamedAgentThreadResult, NamedAgentError> =>
    Effect.gen(function* () {
      const project = yield* requireAgent(input.name);
      const current = yield* live(project);
      return {
        threadId: yield* start(project, input.message, current ?? undefined),
        started: true,
      };
    }).pipe(Effect.mapError(agentError));
  return { list, resolve, handOver };
});
