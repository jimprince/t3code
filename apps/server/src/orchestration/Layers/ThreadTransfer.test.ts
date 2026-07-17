import {
  CommandId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type PortableThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { layer as RepositoryIdentityResolverLive } from "../../project/RepositoryIdentityResolver.ts";
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

const makeTransferSystemLayer = (input: { prefix: string; worktreesRoot: string }) => {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: input.prefix });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ProviderSessionRuntimeRepositoryLive,
  );
  return ThreadTransferLive.pipe(
    Layer.provide(VcsProcessTestLayer),
    Layer.provide(
      gitWorkflowTestLayer(input.worktreesRoot).pipe(Layer.provide(VcsProcessTestLayer)),
    ),
    Layer.provideMerge(orchestrationLayer),
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

// Each system gets its own MemoMap: the suite-level memo map would otherwise
// hand both "environments" the same memoized engine + in-memory database.
const buildTransferSystem = (input: { prefix: string; worktreesRoot: string }) =>
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
            instanceId: ProviderInstanceId.make("claude"),
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
        expect(activity!.sequence).toBeUndefined();
        // REGRESSION: an active imported goal must point at the final imported
        // turn, otherwise GoalReactor evaluates (and may auto-continue) the
        // thread immediately after the move lands.
        expect(thread!.goal?.lastTurnId).toBe(lastTurnId);

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

  describe("round trip", () => {
    it.effect("clears a non-Claude resume cursor so transferred history remains pending", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-context-fallback-");
        const sourceWorkspace = joinPath(root, "source-workspace");
        const targetWorkspace = joinPath(root, "target-workspace");
        const sourceWorktreesRoot = joinPath(root, "source-worktrees");
        const targetWorktreesRoot = joinPath(root, "target-worktrees");
        for (const directory of [
          sourceWorkspace,
          targetWorkspace,
          sourceWorktreesRoot,
          targetWorktreesRoot,
        ]) {
          yield* makeDirectory(directory);
        }

        const source = yield* buildTransferSystem({
          prefix: "t3-thread-move-context-fallback-source-",
          worktreesRoot: sourceWorktreesRoot,
        });
        const target = yield* buildTransferSystem({
          prefix: "t3-thread-move-context-fallback-target-",
          worktreesRoot: targetWorktreesRoot,
        });
        const sourceProjectId = ProjectId.make("project-context-fallback-source");
        const targetProjectId = ProjectId.make("project-context-fallback-target");
        const threadId = ThreadId.make("99991111-2222-4333-8444-555566667777");
        const portable: PortableThread = {
          id: threadId,
          title: "Codex thread on the move",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-terra",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          goal: null,
          createdAt: now(),
          updatedAt: now(),
          messages: [
            {
              id: MessageId.make("context-fallback-message"),
              role: "user",
              text: "Preserve this history.",
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
          type: "project.create",
          commandId: CommandId.make("cmd-context-fallback-source-project"),
          projectId: sourceProjectId,
          title: "Context Fallback Source",
          workspaceRoot: sourceWorkspace,
          createdAt: now(),
        });
        yield* source.engine.dispatch({
          type: "thread.import",
          commandId: CommandId.make("cmd-context-fallback-source-thread"),
          threadId,
          projectId: sourceProjectId,
          thread: portable,
          branch: null,
          worktreePath: null,
          createdAt: now(),
        });
        yield* source.providerRuntime.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "stopped",
          lastSeenAt: now(),
          resumeCursor: { threadId: "machine-local-cursor" },
          runtimePayload: null,
        });

        const exported = yield* source.transfer.exportThread({ threadId });
        expect(exported.bundle.providerSession?.resumeCursor).toBeNull();
        expect(
          exported.bundle.warnings.some((warning) => warning.includes("bounded provider-only")),
        ).toBe(true);

        yield* target.engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("cmd-context-fallback-target-project"),
          projectId: targetProjectId,
          title: "Context Fallback Target",
          workspaceRoot: targetWorkspace,
          createdAt: now(),
        });
        yield* target.transfer.importThread({
          projectId: targetProjectId,
          bundle: exported.bundle,
        });

        const movedThread = yield* target.snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        expect(
          movedThread?.activities.find((activity) => activity.kind === "thread.imported")?.payload,
        ).toMatchObject({
          providerContextHandoff: {
            required: true,
            historyMessageCount: 1,
          },
        });
        const targetRuntime = yield* target.providerRuntime
          .getByThreadId({ threadId })
          .pipe(Effect.map(Option.getOrUndefined));
        expect(targetRuntime?.resumeCursor).toBeNull();
        expect(targetRuntime?.runtimePayload).toEqual({
          cwd: targetWorkspace,
          modelSelection: portable.modelSelection,
        });
      }).pipe(Effect.scoped),
    );

    it.effect("moves history, git state, and the Claude session between two environments", () =>
      Effect.gen(function* () {
        const root = yield* makeScopedTempDirectory("t3-thread-move-");
        const claudeConfigDir = joinPath(root, "claude-config");
        const sourceRepo = joinPath(root, "source-repo");
        const targetRepo = joinPath(root, "target-repo");
        const sourceWorktreesRoot = joinPath(root, "source-worktrees");
        const targetWorktreesRoot = joinPath(root, "target-worktrees");
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
            instanceId: ProviderInstanceId.make("claude"),
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
          providerName: "claude",
          providerInstanceId: ProviderInstanceId.make("claude"),
          adapterKey: "claude",
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
        const importMarker = movedThread!.activities.find(
          (activity) => activity.kind === "thread.imported",
        );
        expect(importMarker?.payload).toMatchObject({
          providerContextHandoff: {
            version: 1,
            required: true,
            historyMessageCount: 1,
          },
        });

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
        expect(targetRuntime!.providerName).toBe("claude");
        expect(targetRuntime!.status).toBe("stopped");
        expect(readClaudeSessionIdFromCursor(targetRuntime!.resumeCursor)).toBe(sessionId);
        expect(targetRuntime!.runtimePayload).toEqual({
          cwd: targetWorktree,
          modelSelection: portable.modelSelection,
          threadTransferContextHandoff: {
            version: 1,
            consumedExportedAt: bundle.exportedAt,
          },
        });

        // Importing the same bundle again must fail cleanly.
        const duplicate = yield* Effect.exit(
          target.transfer.importThread({ projectId: targetProjectId, bundle }),
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
            instanceId: ProviderInstanceId.make("claude"),
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
        expect(
          movedThread!.activities.find((activity) => activity.kind === "thread.imported")?.payload,
        ).toMatchObject({
          providerContextHandoff: {
            version: 1,
            required: true,
            historyMessageCount: 1,
          },
        });

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
              instanceId: ProviderInstanceId.make("claude"),
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
