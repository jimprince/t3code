import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Settings from "../serverSettings.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { makeNamedAgents } from "./NamedAgents.ts";
import { NamedAgentName } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeNestingService } from "./NestingService.ts";
import { writeMetadata } from "./MetadataStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { liveRoots, validateNaming } from "./NamedAgentPolicy.ts";

const database = SqlitePersistenceMemory;
const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "named-agent" },
  ProviderAdapterRegistry.layerFromAdapters([
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("No provider execution in ownership checks"),
    },
  ]),
  { databaseLayer: database, runEffectWorker: false },
);
const layer = ThreadManagement.layer.pipe(Layer.provide(runtime), Layer.provideMerge(database));
const projectId = ProjectId.make("agent-project");
const create = (id: string, handoverFromThreadId?: ThreadId) => ({
  type: "thread.create" as const,
  createdBy: "system" as const,
  creationSource: "server" as const,
  commandId: CommandId.make(`create-${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "model" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  ...(handoverFromThreadId === undefined ? {} : { handoverFromThreadId }),
});

const send = (id: ThreadId) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`input-${id}`),
  threadId: id,
  messageId: MessageId.make(`input-${id}`),
  createdBy: "system" as const,
  creationSource: "server" as const,
  text: "Work",
  attachments: [],
  dispatchMode: { type: "defer_start" as const },
});

it.effect(
  "admits empty claims, admits one concurrent root launch, guards restore/unnest and commits handover",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const management = yield* ThreadManagement.ThreadManagementService;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,permanent_agent_json) VALUES (${projectId},'agent','/tmp/agent','[]','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z','{"name":"agent"}')`;
      const one = ThreadId.make("one"),
        two = ThreadId.make("two");
      yield* management.dispatch(create(one));
      yield* management.dispatch(create(two));
      assert.deepEqual(yield* liveRoots(sql, projectId), []);
      const exits = yield* Effect.all(
        [Effect.exit(management.dispatch(send(one))), Effect.exit(management.dispatch(send(two)))],
        { concurrency: "unbounded" },
      );
      assert.equal(exits.filter((exit) => exit._tag === "Success").length, 1);
      const first = ThreadId.make((yield* liveRoots(sql, projectId))[0]!.thread_id);
      assert.isNotNull((yield* management.getThreadShell(first))?.autoSettleDisabledAt);
      assert.equal(
        (yield* Effect.exit(
          management.dispatch({
            type: "thread.auto-settle.set",
            threadId: first,
            commandId: CommandId.make("auto-on"),
            enabled: true,
          }),
        ))._tag,
        "Failure",
      );
      const run = (yield* management.getThreadRecords(first, ["runs"])).runs[0]!;
      yield* management.dispatch({
        type: "run.interrupt",
        threadId: first,
        runId: run.id,
        commandId: CommandId.make("stop-root"),
      });
      yield* management.dispatch(create("replacement", first));
      const replacement = ThreadId.make("replacement");
      assert.isNotNull((yield* management.getThreadShell(first))?.archivedAt);
      assert.deepEqual(
        (yield* liveRoots(sql, projectId)).map((row) => row.thread_id),
        [replacement],
      );
      assert.equal(
        (yield* Effect.exit(
          management.dispatch({
            type: "thread.unarchive",
            threadId: first,
            commandId: CommandId.make("restore"),
          }),
        ))._tag,
        "Failure",
      );
      yield* management.dispatch(create("child"));
      yield* writeMetadata(sql, { threadId: ThreadId.make("child"), parentThreadId: replacement });
      yield* management.dispatch(send(ThreadId.make("child")));
      const nesting = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      assert.equal(
        (yield* Effect.exit(
          nesting.update({
            commandId: CommandId.make("unnest-child"),
            threadId: ThreadId.make("child"),
            parentThreadId: null,
          }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* nesting.list()).find((row) => row.threadId === "child")?.parentThreadId,
        replacement,
      );
      assert.equal(
        (yield* Effect.exit(validateNaming(sql, ProjectId.make("other"), "agent")))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "M2 empty claim, one sidecar write and launch admits local/remote children beside a named root",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const management = yield* ThreadManagement.ThreadManagementService;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,permanent_agent_json) VALUES (${projectId},'agent','/tmp/agent','[]','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z','{"name":"agent"}')`;
      yield* management.dispatch(create("root"));
      yield* management.dispatch(send(ThreadId.make("root")));
      const child = create("local-child");
      yield* management.dispatch(child);
      yield* writeMetadata(sql, {
        threadId: child.threadId,
        parentThreadId: ThreadId.make("root"),
      });
      yield* management.dispatch(send(child.threadId));
      yield* management.dispatch(create("remote-child"));
      yield* writeMetadata(sql, {
        threadId: ThreadId.make("remote-child"),
        parentThreadId: null,
        remoteParent: { environmentId: "remote", threadId: ThreadId.make("owner") },
      });
      yield* management.dispatch(send(ThreadId.make("remote-child")));
      assert.deepEqual(
        (yield* liveRoots(sql, projectId)).map((row) => row.thread_id),
        ["root"],
      );
      assert.isNull((yield* management.getThreadShell(child.threadId))?.autoSettleDisabledAt);
      yield* writeMetadata(sql, {
        threadId: child.threadId,
        parentThreadId: null,
        remoteParent: { environmentId: "other", threadId: ThreadId.make("edited-owner") },
      });
      yield* management.dispatch(child);
      const nesting = yield* makeNestingService(
        sql,
        management.getThreadShell,
        management.dispatch,
      );
      assert.equal(
        (yield* nesting.list()).find((row) => row.threadId === child.threadId)?.remoteParent
          ?.threadId,
        "edited-owner",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses busy handover without archiving the owner or creating a replacement", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const management = yield* ThreadManagement.ThreadManagementService;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,permanent_agent_json) VALUES (${projectId},'agent','/tmp/agent','[]','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z','{"name":"agent"}')`;
    const root = ThreadId.make("busy-root");
    yield* management.dispatch(create(root));
    yield* management.dispatch(send(root));
    assert.equal((yield* Effect.exit(management.dispatch(create("next", root))))._tag, "Failure");
    assert.isNull((yield* management.getThreadShell(root))?.archivedAt);
    assert.isNull(yield* management.getThreadShell(ThreadId.make("next")));
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "lists charter scopes, starts with briefing and request, reuses a live root, and names unknown agents",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.makeTempDirectoryScoped({
          directory: process.env.T3_AUTOMATION_TEST_TMP,
          prefix: "named-charter-",
        });
        yield* fs.writeFileString(
          `${folder}/AGENT.md`,
          "---\nname: printer\nscope: The K1 printer and its print queue\n---\nOne bounded print action at a time.\n",
        );
        yield* fs.writeFileString(`${folder}/BRIEFING.md`, "Nozzle swapped to 0.6 mm.\n");
        const sql = yield* SqlClient.SqlClient;
        const threads = yield* ThreadManagement.ThreadManagementService;
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,permanent_agent_json) VALUES (${projectId},'printer',${folder},'[]','2026-10-06T00:00:00Z','2026-10-06T00:00:00Z','{"name":"printer"}')`;
        const agents = yield* makeNamedAgents;
        const listed = yield* agents.list();
        assert.equal(listed.agents[0]?.scope, "The K1 printer and its print queue");
        assert.isNull(listed.agents[0]?.liveThreadId);
        const resolved = yield* Effect.all(
          [
            agents.resolve({ name: NamedAgentName.make("printer"), message: "Print bracket v3." }),
            agents.resolve({ name: NamedAgentName.make("printer"), message: "Print bracket v3." }),
          ],
          { concurrency: "unbounded" },
        );
        const first = resolved.find((result) => result.started)!;
        assert.equal(resolved.filter((result) => result.started).length, 1);
        assert.equal(resolved[0]!.threadId, resolved[1]!.threadId);
        const records = yield* threads.getThreadRecords(first.threadId, ["messages"]);
        assert.include(records.messages[0]!.text, "One bounded print action at a time.");
        assert.include(records.messages[0]!.text, "Nozzle swapped to 0.6 mm.");
        assert.include(records.messages[0]!.text, "## Request\nPrint bracket v3.");
        assert.deepEqual(yield* agents.resolve({ name: NamedAgentName.make("printer") }), {
          threadId: first.threadId,
          started: false,
        });
        const error = yield* agents
          .resolve({ name: NamedAgentName.make("deploy") })
          .pipe(Effect.flip);
        assert.equal(error.message, "No named agent 'deploy' on this server.");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          ProjectStore.layer.pipe(Layer.provide(database)),
          Settings.layerTest(),
          NodeServices.layer,
        ),
      ),
    ),
);
