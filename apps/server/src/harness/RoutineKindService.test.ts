import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { classifyRoutines } from "../../../t3-thread/src/routineClassification.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  HarnessRoutineKindSetInput,
  HarnessRoutine,
  EnvironmentId,
  ProjectId,
  ThreadId,
  ScheduledTaskUpsertInput,
  type Automation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import { expect } from "vite-plus/test";
import * as AutomationStore from "../automations/AutomationStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import { ServerEnvironment, ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { writeMetadata } from "../forkThreads/MetadataStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { toolkitRegistration } from "../mcp/McpHttpServer.ts";
import { McpInvocationContext } from "../mcp/McpInvocationContext.ts";
import { HarnessToolkit } from "../mcp/toolkits/harness/tools.ts";
import { HarnessHandlersLive } from "../mcp/toolkits/harness/handlers.ts";
import { HarnessPinService } from "./HarnessPinService.ts";
import * as HarnessRead from "./HarnessReadService.ts";
import * as RoutineKinds from "./RoutineKindService.ts";

const ENV = EnvironmentId.make("kind-environment");
const PROJECT = ProjectId.make("kind-project");
const NOW = "2026-10-13T07:00:00.000Z";
const key = (id: string) => `${ENV}:automations:${id}`;
const services = Layer.mergeAll(
  AutomationStore.layer,
  ProjectStore.layer,
  Settings.layerTest(),
  Layer.succeed(ServerEnvironmentIdentity, { getEnvironmentId: Effect.succeed(ENV) }),
);
const withDb = <A, E, R>(fx: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    fx.pipe(
      Effect.provide(
        Layer.mergeAll(services.pipe(Layer.provideMerge(Sqlite.layerMemory)), NodeServices.layer),
      ),
    ),
  );
const definition = (id: string, owner: string): Automation => ({
  id,
  projectId: PROJECT,
  name: id,
  enabled: false,
  ownerThreadId: ThreadId.make(owner),
  triggers: [],
  actions: [{ type: "agent", prompt: "Check", target: { kind: "new-thread" } }],
  nextRunAt: null,
  createdAt: NOW,
  updatedAt: NOW,
});
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* AutomationStore.AutomationStore;
  for (const purpose of ["harness", "project"] as const) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${purpose}, ${PROJECT}, ${purpose}, 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
    yield* writeMetadata(sql, { threadId: ThreadId.make(purpose), parentThreadId: null, purpose });
  }
  for (const purpose of ["harness", "project", "unknown"])
    yield* store.saveAutomation({
      ...definition(purpose, purpose),
      ...(purpose === "unknown"
        ? {
            actions: [
              {
                type: "agent",
                prompt: "Check",
                target: { kind: "existing-thread", threadId: ThreadId.make("project") },
              },
            ],
          }
        : {}),
    });
});
it.effect(
  "persists explicit kind, derives owner defaults, rejects invalid/foreign keys and invalidates a cache hit",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* AutomationStore.AutomationStore;
        const read = yield* HarnessRead.make;
        const kinds = yield* RoutineKinds.make;
        const first = yield* read.snapshot({});
        expect((yield* read.snapshot({})).routines).toBe(first.routines);
        // Older clients retain the original purpose enum; kind owns classification.
        expect(first.routines.find((r) => r.key === key("project"))?.purpose).toBe("unclassified");
        const {
          routineKind: _kind,
          routineKindSource: _source,
          ownerThreadId: _owner,
          ...legacyRow
        } = first.routines[0]!;
        const decodedLegacy = yield* Schema.decodeUnknownEffect(HarnessRoutine)(legacyRow);
        expect(decodedLegacy).toMatchObject({
          routineKind: "check",
          routineKindSource: "default",
          ownerThreadId: null,
        });

        for (const purpose of ["harness", "project", "unknown"])
          expect(first.routines.find((r) => r.key === key(purpose))).toMatchObject({
            routineKind: purpose === "project" ? "project" : "check",
            routineKindSource: "default",
          });
        const before = (yield* store.getAutomation("harness")).pipe(Option.getOrThrow);
        const input = { routineKey: key("harness"), kind: "agent-wake" as const };
        expect(yield* kinds.set(input)).toEqual({ ...input, source: "explicit" });
        yield* kinds.set(input); // idempotent, no schedule/history rewrite
        const saved = (yield* store.getAutomation("harness")).pipe(Option.getOrThrow);
        expect(saved).toEqual({ ...before, routineKind: "agent-wake" });
        // An already-read scheduler record cannot roll classification back.
        yield* store.saveAutomation({ ...before, name: "Scheduler refresh" });
        expect((yield* store.getAutomation("harness")).pipe(Option.getOrThrow).routineKind).toBe(
          "agent-wake",
        );

        const changed = yield* read.snapshot({});
        expect(changed.routines).not.toBe(first.routines);
        expect(changed.routines.find((r) => r.key === key("harness"))).toMatchObject({
          routineKind: "agent-wake",
          routineKindSource: "explicit",
          ownerThreadId: "harness",
          agentKey: `${ENV}:thread:harness`,
        });
        yield* kinds.set({ ...input, kind: "invalid" as "check" }).pipe(Effect.flip);
        yield* kinds.set({ ...input, routineKey: `foreign:automations:harness` }).pipe(Effect.flip);
        yield* kinds.set({ ...input, routineKey: key("missing") }).pipe(Effect.flip);
        expect((yield* store.getAutomation("harness")).pipe(Option.getOrThrow)).toEqual({
          ...saved,
          name: "Scheduler refresh",
        });
        yield* kinds.set({ ...input, kind: null });
        expect(
          (yield* read.snapshot({})).routines.find((r) => r.key === key("harness")),
        ).toMatchObject({ routineKind: "check", routineKindSource: "default" });
      }),
    ),
);

it.effect(
  "scheduled create/edit and the setter persist classification without changing timing",
  () =>
    withDb(
      Effect.gen(function* () {
        const dependencies = Layer.mergeAll(
          NodeCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ScheduledTasks.ScheduledTaskService;
          const kinds = yield* RoutineKinds.make;
          const input = yield* Schema.decodeUnknownEffect(ScheduledTaskUpsertInput)({
            id: "task:with:colons",
            title: "Review",
            prompt: "Review Harness",
            enabled: false,
            schedule: { type: "interval", everyMs: 3600000 },
            projectId: PROJECT,
            threadId: "harness",
            workspaceStrategy: { type: "root" },
            modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            routineKind: "check",
          });
          yield* seed;
          const created = (yield* service.upsert(input)).task;
          expect(created.routineKind).toBe("check");
          const edited = (yield* service.upsert({ ...input, routineKind: "project" })).task;
          expect(edited.routineKind).toBe("project");
          expect(edited.nextRunAt).toBe(created.nextRunAt);
          const routineKey = `${ENV}:scheduled-task:${created.id}`;
          yield* kinds.set({ routineKey, kind: "agent-wake" });
          const saved = (yield* service.list()).tasks.find((t) => t.id === created.id);
          expect(saved).toEqual({ ...edited, routineKind: "agent-wake" });
          const read = yield* HarnessRead.make;
          expect(
            (yield* read.snapshot({})).routines.find((r) => r.key === routineKey),
          ).toMatchObject({
            routineKind: "agent-wake",
            routineKindSource: "explicit",
            ownerThreadId: "harness",
          });
          yield* kinds.set({ routineKey, kind: null });
          expect(
            (yield* service.list()).tasks.find((t) => t.id === created.id)?.routineKind,
          ).toBeUndefined();
          const { routineKind: _kind, ...legacyEdit } = input;
          expect((yield* service.upsert(legacyEdit)).task.routineKind).toBeUndefined();
        }).pipe(Effect.provide(ScheduledTasks.layer.pipe(Layer.provide(dependencies))));
      }),
    ),
);

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "kind-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kind-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
it.effect(
  "MCP production registration writes classification and refuses read-only clients without mutation",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* seed;
        const store = yield* AutomationStore.AutomationStore;
        yield* Effect.gen(function* () {
          const server = yield* McpServer.McpServer;
          const call = (access: "read-only" | "full-access", kind: string, environmentId = ENV) =>
            server
              .callTool({
                name: "harness_routine_kind_set",
                arguments: { routineKey: key("harness"), kind },
              })
              .pipe(
                Effect.provideService(McpInvocationContext, {
                  environmentId,
                  requestNamespace: "kind-test",
                  issuedAt: 0,
                  capabilities: new Set(["orchestration" as const]),
                  thread: undefined,
                  client: { sessionId: "kind-test", label: "Kind test", access },
                }),
                Effect.provideService(McpSchema.McpServerClient, client),
              );
          const denied = yield* call("read-only", "project");
          expect(denied.isError).toBe(true);
          expect(JSON.stringify(denied.content)).toContain("capability_denied");
          expect(
            (yield* store.getAutomation("harness")).pipe(Option.getOrThrow),
          ).not.toHaveProperty("routineKind");
          const allowed = yield* call("full-access", "agent-wake");
          expect(allowed.isError).not.toBe(true);
          expect(allowed.structuredContent).toMatchObject({
            kind: "agent-wake",
            source: "explicit",
          });
          const invalid = yield* call("full-access", "invalid").pipe(Effect.flip);
          expect(invalid._tag).toBe("InvalidParams");
          expect((yield* store.getAutomation("harness")).pipe(Option.getOrThrow).routineKind).toBe(
            "agent-wake",
          );
          expect(
            (yield* call("full-access", "project", EnvironmentId.make("foreign"))).isError,
          ).toBe(true);
          expect((yield* store.getAutomation("harness")).pipe(Option.getOrThrow).routineKind).toBe(
            "agent-wake",
          );
        }).pipe(
          Effect.provide(
            toolkitRegistration(HarnessToolkit, HarnessHandlersLive).pipe(
              Layer.provideMerge(McpServer.McpServer.layer),
              Layer.provide(
                Layer.mergeAll(
                  HarnessRead.layer,
                  RoutineKinds.layer,
                  Layer.mock(HarnessPinService)({}),
                  Layer.mock(ServerEnvironment)({}),
                ),
              ),
              Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
            ),
          ),
        );
      }),
    ),
);

it.effect(
  "bulk dry-run and repeated apply use the real SQLite service, read back and retain an exact undo list",
  () =>
    withDb(
      Effect.gen(function* () {
        yield* seed;
        const read = yield* HarnessRead.make;
        const kinds = yield* RoutineKinds.make;
        const store = yield* AutomationStore.AutomationStore;
        const runtime = yield* Effect.context<never>();
        // The Promise-based CLI runs against these real SQLite services and the test clock.
        /* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- Required interop at the production CLI boundary. */
        const api = {
          snapshot: () => Effect.runPromiseWith(runtime)(read.snapshot({})),
          set: (input: HarnessRoutineKindSetInput) =>
            Effect.runPromiseWith(runtime)(kinds.set(input)),
        };
        /* oxlint-enable t3code/no-manual-effect-runtime-in-tests */
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "routine-kind-test-" });
        const undoFile = path.join(directory, "undo.json");
        const plan = [
          { routineKey: key("harness"), name: "Staff check every 30 min", kind: "check" as const },
          {
            routineKey: key("project"),
            name: "Capture project page photos",
            kind: "project" as const,
          },
          {
            routineKey: key("unknown"),
            name: "Deployment change-only progress A",
            kind: "agent-wake" as const,
          },
        ];
        const table = yield* Effect.promise(() =>
          classifyRoutines(plan, api, { apply: false, undoFile }),
        );
        expect(table.map((row) => row.proposed)).toEqual(["check", "project", "agent-wake"]);
        expect(yield* fs.exists(undoFile)).toBe(false);
        expect(
          (yield* store.getAutomation("unknown")).pipe(Option.getOrThrow).routineKind,
        ).toBeUndefined();
        expect(
          (yield* Effect.promise(() =>
            classifyRoutines(plan, api, { apply: true, undoFile }),
          )).every((row) => row.changed),
        ).toBe(true);
        const undo = yield* fs.readFileString(undoFile);
        expect(
          (yield* Effect.promise(() =>
            classifyRoutines(plan, api, { apply: true, undoFile }),
          )).every((row) => !row.changed),
        ).toBe(true);
        expect(yield* fs.readFileString(undoFile)).toBe(undo);
        for (const input of yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Array(HarnessRoutineKindSetInput)),
        )(undo))
          yield* kinds.set(input);
        expect(
          (yield* read.snapshot({})).routines.find((r) => r.key === key("unknown")),
        ).toMatchObject({ routineKind: "check", routineKindSource: "default" });
      }),
    ),
);

it.effect(
  "the read-only 2026-10-13 corpus derives defaults through the production snapshot without name guessing",
  () =>
    withDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* AutomationStore.AutomationStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const corpus = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Array(
              Schema.Struct({
                name: Schema.String,
                ownerThreadId: Schema.String,
                ownerPurpose: Schema.NullOr(Schema.Literals(["harness", "project"])),
              }),
            ),
          ),
        )(
          yield* fs.readFileString(
            yield* path.fromFileUrl(
              new URL("./fixtures/routines-2026-10-13.json", import.meta.url),
            ),
          ),
        );
        const inserted = new Set<string>();
        for (const [index, row] of corpus.entries()) {
          const owner = `corpus:${row.ownerThreadId}`;
          if (row.ownerPurpose !== null && !inserted.has(owner)) {
            yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${owner}, ${PROJECT}, ${row.name}, 'codex', 'full-access', 'default', ${NOW}, ${NOW}, '{}')`;
            yield* writeMetadata(sql, {
              threadId: ThreadId.make(owner),
              parentThreadId: null,
              purpose: row.ownerPurpose,
            });
            inserted.add(owner);
          }
          yield* store.saveAutomation({ ...definition(`corpus-${index}`, owner), name: row.name });
        }
        const read = yield* HarnessRead.make;
        const snapshot = yield* read.snapshot({});
        for (const [index, row] of corpus.entries())
          expect(snapshot.routines.find((r) => r.key === key(`corpus-${index}`))).toMatchObject({
            name: row.name,
            routineKind: row.ownerPurpose === "project" ? "project" : "check",
            routineKindSource: "default",
          });
      }),
    ),
);
