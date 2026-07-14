import {
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  THREAD_MOVE_BUNDLE_VERSION,
  ThreadId,
  TurnId,
  type PortableThread,
  type ThreadMoveBundle,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { describe, expect, it as plainIt } from "vite-plus/test";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { layer as RepositoryIdentityResolverLive } from "../../project/RepositoryIdentityResolver.ts";
import { ProviderUnsupportedError } from "../../provider/Errors.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadTransfer } from "../Services/ThreadTransfer.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  describeErrorChain,
  encodeClaudeProjectDirName,
  isSafeRelativeFilePath,
  readClaudeSessionIdFromCursor,
  rewriteClaudeSessionCwd,
  ThreadTransferLive,
} from "./ThreadTransfer.ts";

const now = () => "2026-01-01T00:00:00.000Z";
const noDelayClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => Date.parse(now()),
  currentTimeMillis: Effect.succeed(Date.parse(now())),
  currentTimeNanosUnsafe: () => BigInt(Date.parse(now())) * 1_000_000n,
  currentTimeNanos: Effect.succeed(BigInt(Date.parse(now())) * 1_000_000n),
  sleep: () => Effect.void,
};

// Test repos always live on POSIX temp paths here, so plain "/" joins are fine.
const joinPath = (...parts: ReadonlyArray<string>) => parts.join("/");

const VcsProcessTestLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const TestLayer = Layer.mergeAll(NodeServices.layer, VcsProcessTestLayer);

const execGit = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "ThreadTransfer.test.git",
      command: "git",
      cwd,
      args: [...args],
      timeoutMs: 30_000,
    });
    return result.stdout.trim();
  });

const writeTextFile = (filePath: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(filePath, contents);
  });

const readTextFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(filePath);
  });

const makeClaudeSessionBundle = (input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly transcriptContent?: string;
}): ThreadMoveBundle => ({
  version: THREAD_MOVE_BUNDLE_VERSION,
  exportedAt: now(),
  sourceProjectId: ProjectId.make("project-claude-session-source"),
  sourceWorkspaceRoot: "/source/workspace",
  repositoryIdentity: null,
  thread: {
    id: input.threadId,
    title: "Claude session transfer",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-fable-5",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    goal: null,
    createdAt: now(),
    updatedAt: now(),
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  },
  git: null,
  providerSession: {
    providerName: "claudeAgent",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    adapterKey: "claudeAgent",
    runtimeMode: "full-access",
    resumeCursor: { resume: input.sessionId },
    sourceCwd: "/source/workspace",
    sessionFile: {
      fileName: `${input.sessionId}.jsonl`,
      content: input.transcriptContent ?? '{"cwd":"/source/workspace","type":"user"}\n',
    },
  },
  warnings: [],
});

const makeDirectory = (dirPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(dirPath, { recursive: true });
  });

const makeScopedTempDirectory = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix });
  });

interface TestProviderRoute {
  readonly instanceId: string;
  readonly driverKind: string;
}

const providerAdapterRegistryTestLayer = (routes: ReadonlyArray<TestProviderRoute>) =>
  Layer.mock(ProviderAdapterRegistry)({
    listInstances: () =>
      Effect.succeed(routes.map((route) => ProviderInstanceId.make(route.instanceId))),
    getInstanceInfo: (instanceId) => {
      const route = routes.find((candidate) => candidate.instanceId === instanceId);
      if (route === undefined) {
        return Effect.fail(
          new ProviderUnsupportedError({
            provider: String(instanceId),
          }),
        );
      }
      const driverKind = ProviderDriverKind.make(route.driverKind);
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
  });

const initRepo = (cwd: string) =>
  Effect.gen(function* () {
    yield* execGit(cwd, ["init", "-b", "main"]);
    yield* execGit(cwd, ["config", "user.email", "test@test.com"]);
    yield* execGit(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(joinPath(cwd, "README.md"), "# original\n");
    yield* execGit(cwd, ["add", "."]);
    yield* execGit(cwd, ["commit", "-m", "initial commit"]);
  });

// Minimal worktree-only GitWorkflowService backed by real git; the full
// service drags in GitManager/source-control layers the transfer never uses.
const gitWorkflowTestLayer = (worktreesRoot: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const gitRun = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
        vcsProcess.run({ operation, command: "git", cwd, args: [...args], timeoutMs: 30_000 }).pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation,
                command: "git",
                cwd,
                detail: cause.message,
              }),
          ),
        );
      return Layer.mock(GitWorkflowService)({
        createWorktree: (input) =>
          Effect.gen(function* () {
            const targetBranch = input.newRefName ?? input.refName;
            const worktreePath =
              input.path ?? joinPath(worktreesRoot, targetBranch.replace(/\//g, "-"));
            yield* gitRun(
              "test.createWorktree",
              input.cwd,
              input.newRefName
                ? ["worktree", "add", "-b", input.newRefName, worktreePath, input.refName]
                : ["worktree", "add", worktreePath, input.refName],
            );
            return { worktree: { path: worktreePath, refName: targetBranch } };
          }),
        removeWorktree: (input) =>
          gitRun("test.removeWorktree", input.cwd, [
            "worktree",
            "remove",
            "--force",
            input.path,
          ]).pipe(Effect.asVoid),
      });
    }),
  );

const makeTransferSystemLayer = (input: {
  prefix: string;
  worktreesRoot: string;
  dbPath?: string;
  providerRoutes?: ReadonlyArray<TestProviderRoute>;
}) => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: input.prefix });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProviderSessionRuntimeRepositoryLive,
  );
  const persistenceLayer =
    input.dbPath === undefined
      ? SqlitePersistenceMemory
      : makeSqlitePersistenceLive(input.dbPath).pipe(Layer.provide(NodeServices.layer));
  return ThreadTransferLive.pipe(
    Layer.provide(
      providerAdapterRegistryTestLayer(
        input.providerRoutes ?? [
          { instanceId: "claudeAgent", driverKind: "claudeAgent" },
          { instanceId: "codex", driverKind: "codex" },
        ],
      ),
    ),
    Layer.provide(VcsProcessTestLayer),
    Layer.provide(
      gitWorkflowTestLayer(input.worktreesRoot).pipe(Layer.provide(VcsProcessTestLayer)),
    ),
    Layer.provideMerge(orchestrationLayer),
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(persistenceLayer),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

// Each system gets its own MemoMap: the suite-level memo map would otherwise
// hand both "environments" the same memoized engine + in-memory database.
const buildTransferSystem = (input: {
  prefix: string;
  worktreesRoot: string;
  dbPath?: string;
  providerRoutes?: ReadonlyArray<TestProviderRoute>;
}) =>
  Effect.gen(function* () {
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const context = yield* Layer.buildWithMemoMap(makeTransferSystemLayer(input), memoMap, scope);
    return {
      engine: Context.get(context, OrchestrationEngineService),
      snapshotQuery: Context.get(context, ProjectionSnapshotQuery),
      transfer: Context.get(context, ThreadTransfer),
      providerRuntime: Context.get(context, ProviderSessionRuntimeRepository),
      dispose: Scope.close(scope, Exit.void),
    };
  });

const withClaudeConfigDir = <A, E, R>(configDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      process.env.CLAUDE_CONFIG_DIR = configDir;
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env.CLAUDE_CONFIG_DIR;
        } else {
          process.env.CLAUDE_CONFIG_DIR = previous;
        }
      }),
  );

describe("Claude session helpers", () => {
  plainIt("encodes a cwd the way Claude Code names project directories", () => {
    // Real observed mapping: /Users/brad/.t3/worktrees/Ice/t3code-f84685bb
    // → -Users-brad--t3-worktrees-Ice-t3code-f84685bb
    expect(encodeClaudeProjectDirName("/Users/brad/.t3/worktrees/Ice/t3code-f84685bb")).toBe(
      "-Users-brad--t3-worktrees-Ice-t3code-f84685bb",
    );
  });

  plainIt("reads the session id from resume cursors and rejects non-uuid values", () => {
    const sessionId = "0f290e3b-1111-4222-8333-444455556666";
    expect(readClaudeSessionIdFromCursor({ resume: sessionId })).toBe(sessionId);
    expect(readClaudeSessionIdFromCursor({ sessionId })).toBe(sessionId);
    expect(readClaudeSessionIdFromCursor({ resume: "not-a-uuid" })).toBeUndefined();
    expect(readClaudeSessionIdFromCursor(null)).toBeUndefined();
    expect(readClaudeSessionIdFromCursor("plain string")).toBeUndefined();
  });

  plainIt("rewrites only matching cwd fields and keeps unparseable lines verbatim", () => {
    const content = [
      JSON.stringify({ type: "user", cwd: "/old/cwd", text: "hi" }),
      JSON.stringify({ type: "meta", cwd: "/unrelated/cwd" }),
      "not json at all",
      "",
    ].join("\n");
    const rewritten = rewriteClaudeSessionCwd(content, "/old/cwd", "/new/cwd");
    const lines = rewritten.split("\n");
    expect(JSON.parse(lines[0]!)).toMatchObject({ cwd: "/new/cwd" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ cwd: "/unrelated/cwd" });
    expect(lines[2]).toBe("not json at all");
  });

  plainIt("keeps nested SQL detail when flattening error chains", () => {
    // REGRESSION: a failed import surfaced only the generic top-level
    // "Failed to execute statement"; the underlying sqlite detail must be
    // part of the message users copy from the failure toast.
    const flattened = describeErrorChain(
      {
        _tag: "SqlError",
        message: "Failed to execute statement",
        cause: { message: "SQLITE_TOOBIG: string or blob too big" },
      },
      "fallback",
    );
    expect(flattened).toContain("SqlError: Failed to execute statement");
    expect(flattened).toContain("SQLITE_TOOBIG");
    expect(describeErrorChain(undefined, "fallback")).toBe("fallback");
    expect(describeErrorChain("plain", "fallback")).toBe("plain");
  });

  plainIt("rejects unsafe untracked file paths", () => {
    expect(isSafeRelativeFilePath("src/notes.txt")).toBe(true);
    expect(isSafeRelativeFilePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativeFilePath("../escape.txt")).toBe(false);
    expect(isSafeRelativeFilePath("nested/../../escape.txt")).toBe(false);
    expect(isSafeRelativeFilePath("C:\\windows\\system32")).toBe(false);
  });
});

it.layer(TestLayer, { timeout: 120_000 })("ThreadTransfer", (it) => {
  describe("thread.import command", () => {
    it.effect("replays a portable thread into existing events and guards the goal reactor", () =>
      Effect.gen(function* () {
        const worktreesRoot = yield* makeScopedTempDirectory("t3-import-wt-");
        const system = yield* buildTransferSystem({
          prefix: "t3-thread-import-test-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-import");
        const threadId = ThreadId.make("11111111-2222-4333-8444-555566667777");
        yield* system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-project-create"),
          projectId,
          title: "Import Project",
          workspaceRoot: "/tmp/import-project",
          createdAt: now(),
        });

        const lastTurnId = TurnId.make("turn-2");
        const portable: PortableThread = {
          id: threadId,
          title: "Imported thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-fable-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "move-test",
          goal: {
            goal: "Finish the feature",
            status: "active",
            createdAt: now(),
            updatedAt: now(),
            achievedAt: null,
            lastEvaluatedAt: null,
            lastReason: null,
            // Stale value from the source environment; import must override it
            // with the final imported turn so GoalReactor does not auto-fire.
            lastTurnId: TurnId.make("turn-1"),
            continuationCount: 0,
          },
          createdAt: now(),
          updatedAt: now(),
          messages: [
            {
              id: MessageId.make("message-1"),
              role: "user",
              text: "hello",
              turnId: null,
              streaming: false,
              createdAt: now(),
              updatedAt: now(),
            },
            {
              id: MessageId.make("message-2"),
              role: "assistant",
              text: "world",
              turnId: TurnId.make("turn-1"),
              streaming: false,
              createdAt: now(),
              updatedAt: now(),
            },
          ],
          proposedPlans: [],
          activities: [
            {
              id: "activity-1" as PortableThread["activities"][number]["id"],
              tone: "info",
              kind: "tool.call",
              summary: "Ran a tool",
              payload: {},
              turnId: TurnId.make("turn-1"),
              // Source-environment sequence; import must drop it.
              sequence: 9_999,
              createdAt: now(),
            },
          ],
          checkpoints: [
            {
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: checkpointRefForThreadTurn(threadId, 1),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: now(),
            },
            {
              turnId: lastTurnId,
              checkpointTurnCount: 2,
              checkpointRef: checkpointRefForThreadTurn(threadId, 2),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: now(),
            },
          ],
        };

        yield* system.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-thread-import"),
          threadId,
          projectId,
          thread: portable,
          branch: "move-test",
          worktreePath: null,
          createdAt: now(),
        });

        const thread = yield* system.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(thread).toBeDefined();
        expect(thread!.title).toBe("Imported thread");
        expect(thread!.projectId).toBe(projectId);
        expect(thread!.branch).toBe("move-test");
        expect(thread!.messages.map((message) => message.text)).toEqual(["hello", "world"]);
        expect(thread!.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([
          1, 2,
        ]);
        expect(thread!.latestTurn?.turnId).toBe(lastTurnId);
        expect(thread!.latestTurn?.state).toBe("completed");
        expect(thread!.session).toBeNull();
        const activity = thread!.activities.find((entry) => entry.kind === "tool.call");
        expect(activity).toBeDefined();
        expect(activity!.sequence).toEqual(expect.any(Number));
        expect(activity!.sequence).not.toBe(9_999);
        // REGRESSION: an active imported goal must point at the final imported
        // turn, otherwise GoalReactor evaluates (and may auto-continue) the
        // thread immediately after the move lands.
        expect(thread!.goal?.lastTurnId).toBe(lastTurnId);

        const collidingThreadId = ThreadId.make("99991111-2222-4333-8444-555566667777");
        const nestedIdCollision = yield* Effect.exit(
          system.engine.dispatch({
            type: "thread.import",
            commandId: CommandId.make("cmd-thread-import-nested-id-collision"),
            threadId: collidingThreadId,
            projectId,
            thread: {
              ...portable,
              id: collidingThreadId,
              title: "Must not steal nested ids",
            },
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        expect(Exit.isFailure(nestedIdCollision)).toBe(true);
        const originalAfterCollision = yield* system.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(originalAfterCollision?.messages.map((message) => message.text)).toEqual([
          "hello",
          "world",
        ]);

        const duplicate = yield* Effect.exit(
          system.engine.dispatch({
            type: "thread.import",
            commandId: CommandId.make("cmd-thread-import-duplicate"),
            threadId,
            projectId,
            thread: portable,
            branch: null,
            worktreePath: null,
            createdAt: now(),
          }),
        );
        expect(Exit.isFailure(duplicate)).toBe(true);
      }).pipe(Effect.scoped),
    );
  });

  describe("malformed bundle rejection", () => {
    it.effect("rejects provider session path traversal before importing the thread", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-malformed-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        const claudeConfigDir = joinPath(root, "claude");
        for (const directory of [workspaceRoot, worktreesRoot, claudeConfigDir]) {
          yield* makeDirectory(directory);
        }

        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-malformed-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-malformed-target");
        const threadId = ThreadId.make("eeee1111-2222-4333-8444-555566667777");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-malformed-target-project"),
          projectId,
          title: "Malformed Bundle Target",
          workspaceRoot,
          createdAt: now(),
        });

        const portable: PortableThread = {
          id: threadId,
          title: "Malicious transcript path",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-fable-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          goal: null,
          createdAt: now(),
          updatedAt: now(),
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        };
        const bundle: ThreadMoveBundle = {
          version: THREAD_MOVE_BUNDLE_VERSION,
          exportedAt: now(),
          sourceProjectId: ProjectId.make("project-malformed-source"),
          sourceWorkspaceRoot: "/source/workspace",
          repositoryIdentity: null,
          thread: portable,
          git: null,
          providerSession: {
            providerName: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            adapterKey: "claudeAgent",
            runtimeMode: "full-access",
            resumeCursor: { resume: "eeee1111-2222-4333-8444-555566667777" },
            sourceCwd: "/source/workspace",
            sessionFile: {
              fileName: "../../escaped.jsonl",
              content: '{"type":"user","text":"unsafe"}\n',
            },
          },
          warnings: [],
        };

        const imported = yield* Effect.exit(
          withClaudeConfigDir(claudeConfigDir, target.transfer.importThread({ projectId, bundle })),
        );
        expect(Exit.isFailure(imported)).toBe(true);

        const thread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(thread).toBeUndefined();
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(joinPath(claudeConfigDir, "escaped.jsonl"))).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect("clears an imported Claude cursor when a legacy bundle has no transcript", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-legacy-cursor-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        for (const directory of [workspaceRoot, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-legacy-cursor-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-legacy-cursor-target");
        const threadId = ThreadId.make("abcd1111-2222-4333-8444-555566667777");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-legacy-cursor-project"),
          projectId,
          title: "Legacy Cursor Target",
          workspaceRoot,
          createdAt: now(),
        });
        const bundle: ThreadMoveBundle = {
          version: THREAD_MOVE_BUNDLE_VERSION,
          exportedAt: now(),
          sourceProjectId: ProjectId.make("project-legacy-cursor-source"),
          sourceWorkspaceRoot: "/source/workspace",
          repositoryIdentity: null,
          thread: {
            id: threadId,
            title: "Legacy cursor without transcript",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          git: null,
          providerSession: {
            providerName: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claudeAgent"),
            adapterKey: "claudeAgent",
            runtimeMode: "full-access",
            resumeCursor: { resume: "abcd1111-2222-4333-8444-555566667777" },
            sourceCwd: "/source/workspace",
            sessionFile: null,
          },
          warnings: [],
        };

        const imported = yield* target.transfer.importThread({ projectId, bundle });
        expect(imported.warnings).toContain(
          "The Claude resume cursor was discarded because the bundle has no matching session transcript.",
        );
        const runtime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(runtime?.resumeCursor).toBeNull();
      }).pipe(Effect.scoped),
    );

    it.effect("does not overwrite an existing Claude transcript during import", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-transcript-collision-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        const claudeConfigDir = joinPath(root, "claude");
        for (const directory of [workspaceRoot, worktreesRoot, claudeConfigDir]) {
          yield* makeDirectory(directory);
        }
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-transcript-collision-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-transcript-collision-target");
        const threadId = ThreadId.make("bcde1111-2222-4333-8444-555566667777");
        const sessionId = "bcde1111-2222-4333-8444-555566667777";
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-transcript-collision-project"),
          projectId,
          title: "Transcript Collision Target",
          workspaceRoot,
          createdAt: now(),
        });
        const targetSessionDir = joinPath(
          claudeConfigDir,
          "projects",
          encodeClaudeProjectDirName(workspaceRoot),
        );
        const targetSessionPath = joinPath(targetSessionDir, `${sessionId}.jsonl`);
        yield* makeDirectory(targetSessionDir);
        yield* writeTextFile(targetSessionPath, "existing transcript\n");
        const bundle = makeClaudeSessionBundle({ threadId, sessionId });

        const imported = yield* withClaudeConfigDir(
          claudeConfigDir,
          target.transfer.importThread({ projectId, bundle }),
        );
        expect(yield* readTextFile(targetSessionPath)).toBe("existing transcript\n");
        expect(
          imported.warnings.some((warning) =>
            warning.includes("Agent session context could not be transplanted"),
          ),
        ).toBe(true);
        const runtime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(runtime).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect("reuses an identical existing Claude transcript during a move back", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-transcript-reuse-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        const claudeConfigDir = joinPath(root, "claude");
        for (const directory of [workspaceRoot, worktreesRoot, claudeConfigDir]) {
          yield* makeDirectory(directory);
        }
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-transcript-reuse-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-transcript-reuse-target");
        const threadId = ThreadId.make("cdef2222-3333-4444-8555-666677778888");
        const sessionId = "cdef2222-3333-4444-8555-666677778888";
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-transcript-reuse-project"),
          projectId,
          title: "Transcript Reuse Target",
          workspaceRoot,
          createdAt: now(),
        });
        const targetSessionDir = joinPath(
          claudeConfigDir,
          "projects",
          encodeClaudeProjectDirName(workspaceRoot),
        );
        const targetSessionPath = joinPath(targetSessionDir, `${sessionId}.jsonl`);
        yield* makeDirectory(targetSessionDir);
        const sourceTranscript = '{"cwd":"/source/workspace","type":"user"}\n';
        const rewrittenTranscript = rewriteClaudeSessionCwd(
          sourceTranscript,
          "/source/workspace",
          workspaceRoot,
        );
        yield* writeTextFile(targetSessionPath, rewrittenTranscript);

        const imported = yield* withClaudeConfigDir(
          claudeConfigDir,
          target.transfer.importThread({
            projectId,
            bundle: makeClaudeSessionBundle({
              threadId,
              sessionId,
              transcriptContent: sourceTranscript,
            }),
          }),
        );

        expect(yield* readTextFile(targetSessionPath)).toBe(rewrittenTranscript);
        expect(
          imported.warnings.some((warning) =>
            warning.includes("Agent session context could not be transplanted"),
          ),
        ).toBe(false);
        const runtime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(runtime?.resumeCursor).toEqual({ resume: sessionId });
      }).pipe(Effect.scoped),
    );

    it.effect("rejects an invalid Git branch name before changing the target repository", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-invalid-branch-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        for (const directory of [workspaceRoot, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        yield* initRepo(workspaceRoot);
        yield* execGit(workspaceRoot, ["branch", "previous-checkout"]);
        yield* execGit(workspaceRoot, ["checkout", "previous-checkout"]);
        yield* execGit(workspaceRoot, ["checkout", "main"]);
        const branchTipSha = yield* execGit(workspaceRoot, ["rev-parse", "refs/heads/main"]);
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-invalid-branch-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-invalid-branch-target");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-invalid-branch-project"),
          projectId,
          title: "Invalid Branch Target",
          workspaceRoot,
          createdAt: now(),
        });
        yield* Effect.forEach(
          [
            {
              branch: "-unsafe",
              threadId: ThreadId.make("cdef1111-2222-4333-8444-555566667777"),
            },
            {
              branch: "@{-1}",
              threadId: ThreadId.make("defa1111-2222-4333-8444-555566667777"),
            },
          ],
          ({ branch, threadId }) =>
            Effect.gen(function* () {
              const bundle: ThreadMoveBundle = {
                version: THREAD_MOVE_BUNDLE_VERSION,
                exportedAt: now(),
                sourceProjectId: ProjectId.make("project-invalid-branch-source"),
                sourceWorkspaceRoot: "/source/workspace",
                repositoryIdentity: null,
                thread: {
                  id: threadId,
                  title: "Invalid branch",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("claudeAgent"),
                    model: "claude-fable-5",
                  },
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch,
                  goal: null,
                  createdAt: now(),
                  updatedAt: now(),
                  messages: [],
                  proposedPlans: [],
                  activities: [],
                  checkpoints: [],
                },
                git: {
                  branch,
                  branchTipSha,
                  bundleBase64: null,
                  checkpointRefs: [],
                  dirtyDiff: null,
                  untrackedFiles: [],
                },
                providerSession: null,
                warnings: [],
              };

              const imported = yield* Effect.exit(
                target.transfer.importThread({ projectId, bundle }),
              );
              expect(Exit.isFailure(imported)).toBe(true);
              if (Exit.isFailure(imported)) {
                expect(String(Cause.squash(imported.cause))).toContain(
                  `invalid branch name '${branch}'`,
                );
              }
              const thread = yield* target.snapshotQuery
                .getThreadDetailById(threadId)
                .pipe(Effect.map(Option.getOrUndefined));
              expect(thread).toBeUndefined();
            }),
          { concurrency: 1 },
        );
        expect(yield* execGit(workspaceRoot, ["branch", "--list"])).not.toContain("-unsafe");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects unexpected bundled refs without changing target refs", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-refs-");
        const sourceRepo = joinPath(root, "source");
        const targetRepo = joinPath(root, "target");
        const worktreesRoot = joinPath(root, "worktrees");
        for (const directory of [sourceRepo, targetRepo, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        yield* initRepo(sourceRepo);
        yield* execGit(sourceRepo, ["branch", "move-safe"]);
        yield* execGit(sourceRepo, ["checkout", "-b", "protected"]);
        yield* writeTextFile(joinPath(sourceRepo, "PROTECTED.md"), "malicious replacement\n");
        yield* execGit(sourceRepo, ["add", "."]);
        yield* execGit(sourceRepo, ["commit", "-m", "unexpected protected ref"]);

        const bundlePath = joinPath(root, "malicious.bundle");
        yield* execGit(sourceRepo, [
          "bundle",
          "create",
          bundlePath,
          "refs/heads/move-safe",
          "refs/heads/protected",
        ]);
        const fs = yield* FileSystem.FileSystem;
        const bundleBase64 = Encoding.encodeBase64(yield* fs.readFile(bundlePath));
        const branchTipSha = yield* execGit(sourceRepo, ["rev-parse", "refs/heads/move-safe"]);

        yield* initRepo(targetRepo);
        yield* execGit(targetRepo, ["branch", "protected"]);
        const protectedBefore = yield* execGit(targetRepo, ["rev-parse", "refs/heads/protected"]);
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-refs-target-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-refs-target");
        const threadId = ThreadId.make("ffff1111-2222-4333-8444-555566667777");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-refs-target-project"),
          projectId,
          title: "Unexpected Refs Target",
          workspaceRoot: targetRepo,
          createdAt: now(),
        });

        const bundle: ThreadMoveBundle = {
          version: THREAD_MOVE_BUNDLE_VERSION,
          exportedAt: now(),
          sourceProjectId: ProjectId.make("project-refs-source"),
          sourceWorkspaceRoot: sourceRepo,
          repositoryIdentity: null,
          thread: {
            id: threadId,
            title: "Unexpected bundled ref",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "move-safe",
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          git: {
            branch: "move-safe",
            branchTipSha,
            bundleBase64,
            checkpointRefs: [],
            dirtyDiff: null,
            untrackedFiles: [],
          },
          providerSession: null,
          warnings: [],
        };

        const imported = yield* Effect.exit(target.transfer.importThread({ projectId, bundle }));
        expect(Exit.isFailure(imported)).toBe(true);
        expect(yield* execGit(targetRepo, ["rev-parse", "refs/heads/protected"])).toBe(
          protectedBefore,
        );
        const thread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(thread).toBeUndefined();
      }).pipe(Effect.scoped),
    );

    it.effect("remaps a source provider instance to the target's only compatible instance", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-provider-remap-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        for (const directory of [workspaceRoot, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-provider-remap-target-",
          worktreesRoot,
          providerRoutes: [{ instanceId: "claude-target", driverKind: "claudeAgent" }],
        });
        const projectId = ProjectId.make("project-provider-remap-target");
        const threadId = ThreadId.make("88881111-2222-4333-8444-555566667777");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-provider-remap-project"),
          projectId,
          title: "Provider Remap Target",
          workspaceRoot,
          createdAt: now(),
        });
        const bundle: ThreadMoveBundle = {
          version: THREAD_MOVE_BUNDLE_VERSION,
          exportedAt: now(),
          sourceProjectId: ProjectId.make("project-provider-remap-source"),
          sourceWorkspaceRoot: "/source/workspace",
          repositoryIdentity: null,
          thread: {
            id: threadId,
            title: "Provider remap",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude-source"),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          git: null,
          providerSession: {
            providerName: "claudeAgent",
            providerInstanceId: ProviderInstanceId.make("claude-source"),
            adapterKey: "claudeAgent",
            runtimeMode: "full-access",
            resumeCursor: null,
            sourceCwd: "/source/workspace",
            sessionFile: null,
          },
          warnings: [],
        };

        const imported = yield* target.transfer.importThread({ projectId, bundle });
        const movedThread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(movedThread?.modelSelection.instanceId).toBe("claude-target");
        const runtime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(runtime?.providerInstanceId).toBe("claude-target");
        expect(runtime?.runtimePayload).toMatchObject({
          cwd: imported.worktreePath ?? workspaceRoot,
          modelSelection: { instanceId: "claude-target" },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("refuses to export an untracked symlink", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-symlink-");
        const sourceRepo = joinPath(root, "source");
        const worktreesRoot = joinPath(root, "worktrees");
        const outsideFile = joinPath(root, "outside-secret.txt");
        for (const directory of [sourceRepo, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        yield* initRepo(sourceRepo);
        yield* writeTextFile(outsideFile, "must not be copied\n");
        const fs = yield* FileSystem.FileSystem;
        yield* fs.symlink(outsideFile, joinPath(sourceRepo, "linked-secret.txt"));

        const sourceSystem = yield* buildTransferSystem({
          prefix: "t3-thread-move-symlink-source-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-symlink-source");
        const threadId = ThreadId.make("abcd1111-2222-4333-8444-555566667777");
        yield* sourceSystem.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-symlink-source-project"),
          projectId,
          title: "Symlink Source",
          workspaceRoot: sourceRepo,
          createdAt: now(),
        });
        yield* sourceSystem.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-symlink-source-thread"),
          threadId,
          projectId,
          thread: {
            id: threadId,
            title: "Untracked symlink",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          branch: "main",
          worktreePath: sourceRepo,
          createdAt: now(),
        });

        const exported = yield* Effect.exit(sourceSystem.transfer.exportThread({ threadId }));
        expect(Exit.isFailure(exported)).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("fails export when an active session never confirms shutdown", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-quiesce-");
        const sourceRepo = joinPath(root, "source");
        const worktreesRoot = joinPath(root, "worktrees");
        for (const directory of [sourceRepo, worktreesRoot]) {
          yield* makeDirectory(directory);
        }
        yield* initRepo(sourceRepo);
        const sourceSystem = yield* buildTransferSystem({
          prefix: "t3-thread-move-quiesce-source-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-quiesce-source");
        const threadId = ThreadId.make("12341111-2222-4333-8444-555566667777");
        const activeTurnId = TurnId.make("turn-quiesce-active");
        yield* sourceSystem.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-quiesce-source-project"),
          projectId,
          title: "Quiesce Source",
          workspaceRoot: sourceRepo,
          createdAt: now(),
        });
        yield* sourceSystem.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-quiesce-source-thread"),
          threadId,
          projectId,
          thread: {
            id: threadId,
            title: "Active thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-terra",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          branch: "main",
          worktreePath: sourceRepo,
          createdAt: now(),
        });
        yield* sourceSystem.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-quiesce-session-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId,
            lastError: null,
            updatedAt: now(),
          },
          createdAt: now(),
        });

        const exported = yield* sourceSystem.transfer
          .exportThread({ threadId })
          .pipe(Effect.provideService(Clock.Clock, noDelayClock), Effect.exit);
        expect(Exit.isFailure(exported)).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("clears a Claude resume cursor when its transcript is unavailable", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-missing-transcript-");
        const workspaceRoot = joinPath(root, "workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        const claudeConfigDir = joinPath(root, "claude-config");
        for (const directory of [workspaceRoot, worktreesRoot, claudeConfigDir]) {
          yield* makeDirectory(directory);
        }
        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-missing-transcript-source-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-missing-transcript-source");
        const threadId = ThreadId.make("77771111-2222-4333-8444-555566667777");
        const sessionId = "77771111-2222-4333-8444-555566667777";
        yield* source.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-missing-transcript-project"),
          projectId,
          title: "Missing Transcript Source",
          workspaceRoot,
          createdAt: now(),
        });
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-missing-transcript-thread"),
          threadId,
          projectId,
          thread: {
            id: threadId,
            title: "Missing native context",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });
        yield* source.providerRuntime.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: now(),
          resumeCursor: { resume: sessionId },
          runtimePayload: null,
        });

        const exported = yield* withClaudeConfigDir(
          claudeConfigDir,
          source.transfer.exportThread({ threadId }),
        );
        expect(exported.bundle.providerSession?.sessionFile).toBeNull();
        expect(exported.bundle.providerSession?.resumeCursor).toBeNull();
        expect(exported.bundle.warnings.some((warning) => warning.includes("was not found"))).toBe(
          true,
        );
      }).pipe(Effect.scoped),
    );

    it.effect("finds Claude transcripts using the physical workspace path", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-physical-cwd-");
        const physicalWorkspace = joinPath(root, "physical-workspace");
        const logicalWorkspace = joinPath(root, "logical-workspace");
        const worktreesRoot = joinPath(root, "worktrees");
        const claudeConfigDir = joinPath(root, "claude-config");
        for (const directory of [physicalWorkspace, worktreesRoot, claudeConfigDir]) {
          yield* makeDirectory(directory);
        }
        const fs = yield* FileSystem.FileSystem;
        yield* fs.symlink(physicalWorkspace, logicalWorkspace);

        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-physical-cwd-source-",
          worktreesRoot,
        });
        const projectId = ProjectId.make("project-physical-cwd-source");
        const threadId = ThreadId.make("88881111-2222-4333-8444-555566667777");
        const sessionId = "88881111-2222-4333-8444-555566667777";
        const sessionsDir = joinPath(
          claudeConfigDir,
          "projects",
          encodeClaudeProjectDirName(physicalWorkspace),
        );
        yield* makeDirectory(sessionsDir);
        yield* writeTextFile(
          joinPath(sessionsDir, `${sessionId}.jsonl`),
          `{"type":"user","cwd":"${physicalWorkspace}","text":"hello"}\n`,
        );

        yield* source.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-physical-cwd-project"),
          projectId,
          title: "Physical Cwd Source",
          workspaceRoot: logicalWorkspace,
          createdAt: now(),
        });
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-physical-cwd-thread"),
          threadId,
          projectId,
          thread: {
            id: threadId,
            title: "Physical provider cwd",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });
        yield* source.providerRuntime.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: now(),
          resumeCursor: { resume: sessionId },
          runtimePayload: null,
        });

        const exported = yield* withClaudeConfigDir(
          claudeConfigDir,
          source.transfer.exportThread({ threadId }),
        );
        expect(exported.bundle.providerSession?.sourceCwd).toBe(physicalWorkspace);
        expect(exported.bundle.providerSession?.sessionFile?.fileName).toBe(`${sessionId}.jsonl`);
        expect(exported.bundle.providerSession?.sessionFile?.content).toContain("hello");
        expect(exported.bundle.warnings.some((warning) => warning.includes("was not found"))).toBe(
          false,
        );
      }).pipe(Effect.scoped),
    );
  });

  describe("round trip", () => {
    it.effect("moves history, git state, and the Claude session between two environments", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-");
        const claudeConfigDir = joinPath(root, "claude-config");
        const sourceRepo = joinPath(root, "source-repo");
        const targetRepo = joinPath(root, "target-repo");
        const sourceWorktreesRoot = joinPath(root, "source-worktrees");
        const targetWorktreesRoot = joinPath(root, "target-worktrees");
        const targetDbPath = joinPath(root, "target.sqlite");
        for (const dir of [
          claudeConfigDir,
          sourceRepo,
          targetRepo,
          sourceWorktreesRoot,
          targetWorktreesRoot,
        ]) {
          yield* makeDirectory(dir);
        }

        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-source-",
          worktreesRoot: sourceWorktreesRoot,
        });
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-target-",
          worktreesRoot: targetWorktreesRoot,
          dbPath: targetDbPath,
        });

        const threadId = ThreadId.make("aaaa1111-2222-4333-8444-555566667777");
        const sessionId = "bbbb1111-2222-4333-8444-555566667777";
        const branch = "move-test";

        // --- Source machine: repo, thread branch + worktree, dirty state.
        yield* initRepo(sourceRepo);
        yield* execGit(sourceRepo, ["branch", branch]);
        const sourceWorktree = joinPath(sourceWorktreesRoot, "move-test");
        yield* execGit(sourceRepo, ["worktree", "add", sourceWorktree, branch]);
        yield* writeTextFile(joinPath(sourceWorktree, "README.md"), "# modified by thread\n");
        yield* writeTextFile(joinPath(sourceWorktree, "notes.txt"), "untracked notes\n");

        // Synthetic checkpoint commit + ref, the way CheckpointStore stores them.
        const treeSha = yield* execGit(sourceWorktree, ["rev-parse", "HEAD^{tree}"]);
        const checkpointSha = yield* execGit(sourceWorktree, [
          "commit-tree",
          treeSha,
          "-p",
          "HEAD",
          "-m",
          "checkpoint",
        ]);
        const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
        yield* execGit(sourceWorktree, ["update-ref", checkpointRef, checkpointSha]);

        // Claude session transcript on the source machine, keyed by the
        // thread's working directory.
        const sourceSessionsDir = joinPath(
          claudeConfigDir,
          "projects",
          encodeClaudeProjectDirName(sourceWorktree),
        );
        yield* makeDirectory(sourceSessionsDir);
        // Temp paths contain no characters that need JSON escaping, so the
        // JSONL lines are built literally.
        yield* writeTextFile(
          joinPath(sourceSessionsDir, `${sessionId}.jsonl`),
          [
            `{"type":"user","cwd":"${sourceWorktree}","text":"hello"}`,
            `{"type":"assistant","text":"world"}`,
          ].join("\n"),
        );

        const sourceProjectId = ProjectId.make("project-source");
        yield* source.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-source-project"),
          projectId: sourceProjectId,
          title: "Source Project",
          workspaceRoot: sourceRepo,
          createdAt: now(),
        });
        const portable: PortableThread = {
          id: threadId,
          title: "Thread on the move",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-fable-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch,
          goal: null,
          createdAt: now(),
          updatedAt: now(),
          messages: [
            {
              id: MessageId.make("message-1"),
              role: "user",
              text: "do the thing",
              turnId: null,
              streaming: false,
              createdAt: now(),
              updatedAt: now(),
            },
          ],
          proposedPlans: [],
          activities: [],
          checkpoints: [
            {
              turnId: TurnId.make("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef,
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: now(),
            },
          ],
        };
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-source-seed"),
          threadId,
          projectId: sourceProjectId,
          thread: portable,
          branch,
          worktreePath: sourceWorktree,
          createdAt: now(),
        });
        yield* source.providerRuntime.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: now(),
          resumeCursor: { threadId, resume: sessionId, turnCount: 1 },
          runtimePayload: null,
        });

        // --- Export from the source environment.
        const exported = yield* withClaudeConfigDir(
          claudeConfigDir,
          source.transfer.exportThread({ threadId }),
        );
        const bundle = exported.bundle;
        expect(bundle.thread.messages).toHaveLength(1);
        expect(bundle.git).not.toBeNull();
        expect(bundle.git!.branch).toBe(branch);
        expect(bundle.git!.bundleBase64).not.toBeNull();
        expect(bundle.git!.checkpointRefs).toContain(checkpointRef);
        expect(bundle.git!.dirtyDiff).toContain("modified by thread");
        expect(bundle.git!.untrackedFiles.map((file) => file.path)).toContain("notes.txt");
        expect(bundle.providerSession).not.toBeNull();
        expect(bundle.providerSession!.sessionFile).not.toBeNull();
        expect(bundle.providerSession!.sessionFile!.fileName).toBe(`${sessionId}.jsonl`);

        // --- Target machine: independent clone of the same logical repo.
        yield* initRepo(targetRepo);
        const targetProjectId = ProjectId.make("project-target");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-target-project"),
          projectId: targetProjectId,
          title: "Target Project",
          workspaceRoot: targetRepo,
          createdAt: now(),
        });

        const imported = yield* withClaudeConfigDir(
          claudeConfigDir,
          target.transfer.importThread({ projectId: targetProjectId, bundle }),
        );
        expect(imported.threadId).toBe(threadId);
        expect(imported.worktreePath).not.toBeNull();
        const targetWorktree = imported.worktreePath!;

        // History landed.
        const movedThread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(movedThread).toBeDefined();
        expect(movedThread!.projectId).toBe(targetProjectId);
        expect(movedThread!.messages.map((message) => message.text)).toEqual(["do the thing"]);
        expect(movedThread!.checkpoints).toHaveLength(1);
        expect(movedThread!.worktreePath).toBe(targetWorktree);
        expect(
          movedThread!.activities.some((activity) => activity.kind === "thread.imported"),
        ).toBe(true);

        // Git state landed: branch, checkpoint ref, dirty diff, untracked file.
        const targetBranchSha = yield* execGit(targetRepo, ["rev-parse", `refs/heads/${branch}`]);
        expect(targetBranchSha).toBe(bundle.git!.branchTipSha);
        const targetCheckpointSha = yield* execGit(targetRepo, ["rev-parse", checkpointRef]);
        expect(targetCheckpointSha).toBe(checkpointSha);
        const movedReadme = yield* readTextFile(joinPath(targetWorktree, "README.md"));
        expect(movedReadme).toBe("# modified by thread\n");
        const movedNotes = yield* readTextFile(joinPath(targetWorktree, "notes.txt"));
        expect(movedNotes).toBe("untracked notes\n");

        // Claude session transplanted under the new cwd with rewritten cwd.
        const targetSessionPath = joinPath(
          claudeConfigDir,
          "projects",
          encodeClaudeProjectDirName(targetWorktree),
          `${sessionId}.jsonl`,
        );
        const movedSession = yield* readTextFile(targetSessionPath);
        const firstLine = movedSession.split("\n")[0]!;
        expect(firstLine).toContain(`"cwd":"${targetWorktree}"`);
        expect(firstLine).not.toContain(sourceWorktree);

        const targetRuntime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(targetRuntime).toBeDefined();
        expect(targetRuntime!.providerName).toBe("claudeAgent");
        expect(targetRuntime!.status).toBe("stopped");
        expect(readClaudeSessionIdFromCursor(targetRuntime!.resumeCursor)).toBe(sessionId);
        expect(targetRuntime!.runtimePayload).toEqual({
          cwd: targetWorktree,
          modelSelection: portable.modelSelection,
        });

        yield* target.dispose;
        const restartedTarget = yield* buildTransferSystem({
          prefix: "t3-thread-move-target-restarted-",
          worktreesRoot: targetWorktreesRoot,
          dbPath: targetDbPath,
        });
        const restartedThread = yield* restartedTarget.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(restartedThread?.messages.map((message) => message.text)).toEqual(["do the thing"]);
        expect(restartedThread?.worktreePath).toBe(targetWorktree);
        expect(
          restartedThread?.activities.some((activity) => activity.kind === "thread.imported"),
        ).toBe(true);
        const restartedRuntime = yield* restartedTarget.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(restartedRuntime).toEqual(targetRuntime);
        expect(yield* readTextFile(targetSessionPath)).toBe(movedSession);

        // Importing the same bundle again must fail cleanly.
        const duplicate = yield* Effect.exit(
          restartedTarget.transfer.importThread({ projectId: targetProjectId, bundle }),
        );
        expect(Exit.isFailure(duplicate)).toBe(true);
        if (Exit.isFailure(duplicate)) {
          const error = Cause.squash(duplicate.cause);
          expect(String((error as { message?: string }).message ?? error)).toContain(
            "already exists",
          );
        }
      }).pipe(Effect.scoped),
    );

    it.effect("falls back to a new branch when the thread branch is the target's own main", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-main-");
        const sourceRepo = joinPath(root, "source-repo");
        const targetRepo = joinPath(root, "target-repo");
        const sourceWorktreesRoot = joinPath(root, "source-worktrees");
        const targetWorktreesRoot = joinPath(root, "target-worktrees");
        for (const dir of [sourceRepo, targetRepo, sourceWorktreesRoot, targetWorktreesRoot]) {
          yield* makeDirectory(dir);
        }

        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-main-source-",
          worktreesRoot: sourceWorktreesRoot,
        });
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-main-target-",
          worktreesRoot: targetWorktreesRoot,
        });

        const threadId = ThreadId.make("cccc1111-2222-4333-8444-555566667777");

        // REGRESSION: a thread working directly on `main` (no dedicated
        // worktree) must move even though the target repository has its own
        // checked-out `main` pointing at different history. The old behavior
        // failed the whole move with "Branch 'main' already exists in the
        // target repository and points elsewhere".
        yield* initRepo(sourceRepo);
        yield* writeTextFile(joinPath(sourceRepo, "README.md"), "# changed on main\n");

        const sourceProjectId = ProjectId.make("project-main-source");
        yield* source.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-main-source-project"),
          projectId: sourceProjectId,
          title: "Main Source Project",
          workspaceRoot: sourceRepo,
          createdAt: now(),
        });
        const portable: PortableThread = {
          id: threadId,
          title: "Thread on main",
          modelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-fable-5",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          goal: null,
          createdAt: now(),
          updatedAt: now(),
          messages: [
            {
              id: MessageId.make("message-main-1"),
              role: "user",
              text: "work on main",
              turnId: null,
              streaming: false,
              createdAt: now(),
              updatedAt: now(),
            },
          ],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        };
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-main-source-seed"),
          threadId,
          projectId: sourceProjectId,
          thread: portable,
          branch: "main",
          worktreePath: null,
          createdAt: now(),
        });

        const exported = yield* source.transfer.exportThread({ threadId });
        expect(exported.bundle.git).not.toBeNull();
        expect(exported.bundle.git!.branch).toBe("main");
        expect(exported.bundle.git!.dirtyDiff).toContain("changed on main");

        // Target repository: unrelated history, `main` checked out at root.
        yield* initRepo(targetRepo);
        yield* writeTextFile(joinPath(targetRepo, "OTHER.md"), "target only\n");
        yield* execGit(targetRepo, ["add", "."]);
        yield* execGit(targetRepo, ["commit", "-m", "target divergence"]);
        const targetMainShaBefore = yield* execGit(targetRepo, ["rev-parse", "refs/heads/main"]);

        const targetProjectId = ProjectId.make("project-main-target");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-main-target-project"),
          projectId: targetProjectId,
          title: "Main Target Project",
          workspaceRoot: targetRepo,
          createdAt: now(),
        });

        // Without consent the import refuses with a machine-readable reason
        // (the UI uses it to offer the new-worktree fallback).
        const refused = yield* Effect.exit(
          target.transfer.importThread({
            projectId: targetProjectId,
            bundle: exported.bundle,
          }),
        );
        expect(Exit.isFailure(refused)).toBe(true);
        if (Exit.isFailure(refused)) {
          const error = Cause.squash(refused.cause) as { reason?: string };
          expect(error.reason).toBe("branch-conflict");
        }

        const imported = yield* target.transfer.importThread({
          projectId: targetProjectId,
          bundle: exported.bundle,
          branchConflict: "new-worktree",
        });
        expect(imported.worktreePath).not.toBeNull();
        expect(
          imported.warnings.some((warning) => warning.includes("continues on new branch")),
        ).toBe(true);

        const movedThread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(movedThread).toBeDefined();
        expect(movedThread!.branch).toMatch(/^main-moved-cccc1111/);

        // The target's own main is untouched; the work landed on the
        // fallback branch's worktree.
        const targetMainShaAfter = yield* execGit(targetRepo, ["rev-parse", "refs/heads/main"]);
        expect(targetMainShaAfter).toBe(targetMainShaBefore);
        const movedReadme = yield* readTextFile(joinPath(imported.worktreePath!, "README.md"));
        expect(movedReadme).toBe("# changed on main\n");
      }).pipe(Effect.scoped),
    );

    it.effect("fetches the target's remote when the move bundle needs newer base commits", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-stale-");
        const originRepo = joinPath(root, "origin.git");
        const sourceRepo = joinPath(root, "source-repo");
        const targetRepo = joinPath(root, "target-repo");
        const sourceWorktreesRoot = joinPath(root, "source-worktrees");
        const targetWorktreesRoot = joinPath(root, "target-worktrees");
        for (const dir of [originRepo, sourceRepo, sourceWorktreesRoot, targetWorktreesRoot]) {
          yield* makeDirectory(dir);
        }

        // REGRESSION: thin bundles exclude history up to the source's
        // merge-base with the shared remote. A target clone that has not
        // fetched recently is missing those base commits; the import must
        // fetch the target's remote and retry instead of failing with
        // "Repository lacks these prerequisite commits".
        yield* execGit(root, ["init", "--bare", "-b", "main", originRepo]);
        yield* initRepo(sourceRepo);
        yield* execGit(sourceRepo, ["remote", "add", "origin", originRepo]);
        yield* execGit(sourceRepo, ["push", "--quiet", "origin", "main"]);
        yield* execGit(root, ["clone", "--quiet", originRepo, targetRepo]);

        // Advance shared history on the source and the remote only; the
        // target clone stays stale.
        yield* writeTextFile(joinPath(sourceRepo, "BASE.md"), "new base\n");
        yield* execGit(sourceRepo, ["add", "."]);
        yield* execGit(sourceRepo, ["commit", "-m", "advance main"]);
        yield* execGit(sourceRepo, ["push", "--quiet", "origin", "main"]);
        const advancedBaseSha = yield* execGit(sourceRepo, ["rev-parse", "refs/heads/main"]);
        const targetLacksBase = yield* Effect.exit(
          execGit(targetRepo, ["rev-parse", "--verify", `${advancedBaseSha}^{commit}`]),
        );
        expect(Exit.isFailure(targetLacksBase)).toBe(true);

        const branch = "stale-test";
        const sourceWorktree = joinPath(sourceWorktreesRoot, branch);
        yield* execGit(sourceRepo, ["branch", branch]);
        yield* execGit(sourceRepo, ["worktree", "add", sourceWorktree, branch]);
        yield* writeTextFile(joinPath(sourceWorktree, "WORK.md"), "thread work\n");
        yield* execGit(sourceWorktree, ["add", "."]);
        yield* execGit(sourceWorktree, ["commit", "-m", "thread commit"]);

        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-stale-source-",
          worktreesRoot: sourceWorktreesRoot,
        });
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-stale-target-",
          worktreesRoot: targetWorktreesRoot,
        });

        const threadId = ThreadId.make("dddd1111-2222-4333-8444-555566667777");
        const sourceProjectId = ProjectId.make("project-stale-source");
        yield* source.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-stale-source-project"),
          projectId: sourceProjectId,
          title: "Stale Source Project",
          workspaceRoot: sourceRepo,
          createdAt: now(),
        });
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-stale-source-seed"),
          threadId,
          projectId: sourceProjectId,
          thread: {
            id: threadId,
            title: "Thread ahead of a stale clone",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              model: "claude-fable-5",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch,
            goal: null,
            createdAt: now(),
            updatedAt: now(),
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
          },
          branch,
          worktreePath: sourceWorktree,
          createdAt: now(),
        });

        const exported = yield* source.transfer.exportThread({ threadId });
        expect(exported.bundle.git).not.toBeNull();
        // Thin bundle: the advanced base commit is excluded, so the stale
        // target cannot satisfy the prerequisites without fetching.
        expect(exported.bundle.git!.bundleBase64).not.toBeNull();

        const targetProjectId = ProjectId.make("project-stale-target");
        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-stale-target-project"),
          projectId: targetProjectId,
          title: "Stale Target Project",
          workspaceRoot: targetRepo,
          createdAt: now(),
        });

        const imported = yield* target.transfer.importThread({
          projectId: targetProjectId,
          bundle: exported.bundle,
        });
        expect(imported.worktreePath).not.toBeNull();

        const sourceTip = yield* execGit(sourceRepo, ["rev-parse", `refs/heads/${branch}`]);
        const targetTip = yield* execGit(targetRepo, ["rev-parse", `refs/heads/${branch}`]);
        expect(targetTip).toBe(sourceTip);
        const movedWork = yield* readTextFile(joinPath(imported.worktreePath!, "WORK.md"));
        expect(movedWork).toBe("thread work\n");
      }).pipe(Effect.scoped),
    );
  });
});
