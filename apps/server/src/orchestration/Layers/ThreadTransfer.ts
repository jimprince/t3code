/**
 * ThreadTransferLive - Cross-environment thread move implementation.
 *
 * Export: quiesce the provider session, package the thread's portable history,
 * its git state (branch + checkpoint refs as a thin `git bundle`, uncommitted
 * tracked diff, untracked files), and the provider session transcript (Claude
 * Code session JSONL) into one versioned `ThreadMoveBundle`.
 *
 * Import: restore the git state into the target project's repository, create
 * the thread worktree, transplant the provider session transcript under the
 * new working directory, persist the provider resume cursor, and replay the
 * portable thread into the orchestration event log via the `thread.import`
 * command.
 *
 * @module ThreadTransferLive
 */
import * as NodeOS from "node:os";

import {
  CommandId,
  EventId,
  OrchestrationExportThreadError,
  OrchestrationImportThreadError,
  THREAD_MOVE_BUNDLE_VERSION,
  type OrchestrationCheckpointSummary,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type PortableThread,
  type ThreadId,
  type ThreadMoveBundle,
  type ThreadMoveBranchConflictResolution,
  type ThreadMoveGitState,
  type ThreadMoveProviderSession,
  type ThreadMoveUntrackedFile,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { checkpointRefForThreadTurn, CHECKPOINT_REFS_PREFIX } from "../../checkpointing/Utils.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/ProviderSessionRuntime.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadTransfer, type ThreadTransferShape } from "../Services/ThreadTransfer.ts";
import {
  makeThreadTransferImportedActivityPayload,
  markThreadTransferContextHandoffConsumed,
} from "../threadTransferContextHandoff.ts";

const QUIESCE_POLL_INTERVAL_MS = 250;
const QUIESCE_POLL_ATTEMPTS = 60;
const GIT_BUNDLE_TIMEOUT_MS = 120_000;
const GIT_REMOTE_FETCH_TIMEOUT_MS = 180_000;
const MAX_DIRTY_DIFF_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_PROVIDER_SESSION_FILE_BYTES = 64 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CLAUDE_PROVIDER_NAME = "claude";
const PROVIDER_CONTEXT_FALLBACK =
  "the first target turn receives a bounded provider-only handoff of the visible message history instead";

/**
 * Claude Code stores session transcripts under
 * `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`, where the encoded
 * cwd replaces every non-alphanumeric character with `-` (verified against
 * real `~/.claude/projects` entries, e.g. `/Users/x/.t3/wt` →
 * `-Users-x--t3-wt`).
 */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Mirror of the Claude adapter's tolerant resume-cursor read: the session id
 * lives in `resume` (preferred) or legacy `sessionId` and must be a UUID. */
export function readClaudeSessionIdFromCursor(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as { resume?: unknown; sessionId?: unknown };
  const candidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  return candidate !== undefined && UUID_RE.test(candidate) ? candidate : undefined;
}

/**
 * Rewrite machine-bound `cwd` fields inside a Claude session JSONL transcript
 * so resumed tool calls resolve against the new worktree. Lines that fail to
 * parse are kept verbatim.
 */
export function rewriteClaudeSessionCwd(
  content: string,
  sourceCwd: string | null,
  targetCwd: string,
): string {
  if (sourceCwd === null || sourceCwd === targetCwd) {
    return content;
  }
  return content
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) {
        return line;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          "cwd" in parsed &&
          (parsed as { cwd?: unknown }).cwd === sourceCwd
        ) {
          (parsed as { cwd: string }).cwd = targetCwd;
          return JSON.stringify(parsed);
        }
        return line;
      } catch {
        return line;
      }
    })
    .join("\n");
}

export function isSafeRelativeFilePath(filePath: string): boolean {
  if (filePath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\")) {
    return false;
  }
  const segments = filePath.split(/[\\/]/);
  return segments.every((segment) => segment !== "..");
}

/**
 * Flatten an error and its cause chain into one diagnostic string. Generic
 * top-level messages ("Failed to execute statement") are useless without the
 * underlying detail, so collect `_tag`/`operation`/`message`/`detail` from up
 * to six nested causes and join them.
 */
export function describeErrorChain(cause: unknown, fallback: string): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current === "string") {
      if (current.trim().length > 0) {
        parts.push(current.trim());
      }
      break;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      break;
    }
    seen.add(current);
    const record = current as {
      _tag?: unknown;
      operation?: unknown;
      message?: unknown;
      detail?: unknown;
      cause?: unknown;
    };
    const segments: string[] = [];
    if (typeof record._tag === "string" && record._tag.trim().length > 0) {
      segments.push(record._tag.trim());
    } else if (current instanceof Error && current.name !== "Error") {
      segments.push(current.name);
    }
    if (typeof record.operation === "string" && record.operation.trim().length > 0) {
      segments.push(record.operation.trim());
    }
    if (typeof record.message === "string" && record.message.trim().length > 0) {
      segments.push(record.message.trim());
    }
    if (typeof record.detail === "string" && record.detail.trim().length > 0) {
      segments.push(record.detail.trim());
    }
    if (segments.length > 0) {
      const part = segments.join(": ");
      if (parts.at(-1) !== part) {
        parts.push(part);
      }
    }
    current = record.cause;
  }
  if (parts.length === 0) {
    return fallback;
  }
  return parts.join(" — caused by: ");
}

function toMessage(cause: unknown, fallback: string): string {
  return describeErrorChain(cause, fallback);
}

const isExportThreadError = Schema.is(OrchestrationExportThreadError);
const isImportThreadError = Schema.is(OrchestrationImportThreadError);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const providerSessionRuntime = yield* ProviderSessionRuntimeRepository;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsProcess = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const claudeProjectsDirForCwd = (cwd: string): string => {
    const configuredDir = process.env.CLAUDE_CONFIG_DIR;
    const configDir =
      configuredDir !== undefined && configuredDir.trim().length > 0
        ? configuredDir
        : path.join(NodeOS.homedir(), ".claude");
    return path.join(configDir, "projects", encodeClaudeProjectDirName(cwd));
  };

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const git = (input: {
    readonly operation: string;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
  }) =>
    vcsProcess.run({
      operation: input.operation,
      command: "git",
      args: input.args,
      cwd: input.cwd,
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
    });

  const isGitRepository = (cwd: string) =>
    git({
      operation: "ThreadTransfer.isGitRepository",
      cwd,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"),
      Effect.orElseSucceed(() => false),
    );

  /** Fetch the repository's primary remote so a stale target clone picks up
   * the base commits a thin move bundle was built against. Best effort:
   * returns the remote name on success, null when there is no remote or the
   * fetch fails (offline targets keep the explicit error path). */
  const fetchPrimaryRemote = (workspaceRoot: string) =>
    Effect.gen(function* () {
      const remotes = yield* git({
        operation: "ThreadTransfer.import.listRemotes",
        cwd: workspaceRoot,
        args: ["remote"],
        allowNonZeroExit: true,
      });
      const remoteNames = remotes.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const remoteName = remoteNames.includes("origin") ? "origin" : remoteNames[0];
      if (remoteName === undefined) {
        return null;
      }
      const fetched = yield* git({
        operation: "ThreadTransfer.import.remoteFetch",
        cwd: workspaceRoot,
        args: ["fetch", "--quiet", remoteName],
        allowNonZeroExit: true,
        timeoutMs: GIT_REMOTE_FETCH_TIMEOUT_MS,
      });
      return fetched.exitCode === 0 ? remoteName : null;
    }).pipe(Effect.orElseSucceed(() => null));

  const awaitSessionQuiesced = (threadId: ThreadId) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < QUIESCE_POLL_ATTEMPTS; attempt++) {
        const shell = yield* snapshotQuery.getThreadShellByIdIncludingArchived(threadId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
        const status = shell?.session?.status;
        if (
          status === undefined ||
          status === "stopped" ||
          status === "idle" ||
          status === "error"
        ) {
          return true;
        }
        yield* Effect.sleep(Duration.millis(QUIESCE_POLL_INTERVAL_MS));
      }
      return false;
    });

  /** Interrupt any active turn and stop the provider session so the provider
   * transcript on disk is final before we copy it. */
  const quiesceThread = (thread: OrchestrationThread, warnings: string[]) =>
    Effect.gen(function* () {
      const status = thread.session?.status;
      const sessionActive =
        status === "starting" ||
        status === "running" ||
        status === "ready" ||
        status === "interrupted";
      if (!sessionActive) {
        return;
      }
      const createdAt = yield* nowIso;
      if (thread.session?.activeTurnId != null) {
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: yield* serverCommandId("thread-move-interrupt"),
            threadId: thread.id,
            turnId: thread.session.activeTurnId,
            createdAt,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* engine
        .dispatch({
          type: "thread.session.stop",
          commandId: yield* serverCommandId("thread-move-session-stop"),
          threadId: thread.id,
          createdAt,
        })
        .pipe(Effect.ignoreCause({ log: true }));

      const quiesced = yield* awaitSessionQuiesced(thread.id);
      if (!quiesced) {
        warnings.push(
          "The provider session did not confirm shutdown before export; the moved agent context may be missing the very latest turn.",
        );
      }
    });

  const collectUntrackedFiles = (cwd: string, warnings: string[]) =>
    Effect.gen(function* () {
      const listed = yield* git({
        operation: "ThreadTransfer.export.listUntracked",
        cwd,
        args: ["ls-files", "--others", "--exclude-standard", "-z"],
        maxOutputBytes: 8 * 1024 * 1024,
      });
      const paths = listed.stdout.split("\0").filter((entry) => entry.length > 0);
      const untrackedFiles: ThreadMoveUntrackedFile[] = [];
      let totalBytes = 0;
      for (const relativePath of paths) {
        const absolutePath = path.join(cwd, relativePath);
        const stat = yield* fs.stat(absolutePath).pipe(
          Effect.map(Option.some),
          Effect.orElseSucceed(() => Option.none()),
        );
        if (Option.isNone(stat) || stat.value.type !== "File") {
          continue;
        }
        const size = Number(stat.value.size);
        if (size > MAX_UNTRACKED_FILE_BYTES) {
          warnings.push(
            `Untracked file '${relativePath}' exceeds the move size limit and was not transferred.`,
          );
          continue;
        }
        if (totalBytes + size > MAX_UNTRACKED_TOTAL_BYTES) {
          warnings.push(
            `Untracked files beyond '${relativePath}' exceed the total move size limit and were not transferred.`,
          );
          break;
        }
        const bytes = yield* fs.readFile(absolutePath);
        totalBytes += size;
        untrackedFiles.push({
          path: relativePath,
          contentBase64: Encoding.encodeBase64(bytes),
        });
      }
      return untrackedFiles;
    });

  /** Resolve a merge-base with the remote default branch so the bundle stays
   * thin (objects the target clone already has are excluded). */
  const resolveBundleBasis = (cwd: string, branch: string) =>
    Effect.gen(function* () {
      const symbolic = yield* git({
        operation: "ThreadTransfer.export.remoteHead",
        cwd,
        args: ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
        allowNonZeroExit: true,
      });
      let basisRef = symbolic.exitCode === 0 ? symbolic.stdout.trim() : null;
      if (basisRef === null) {
        for (const candidate of ["refs/remotes/origin/main", "refs/remotes/origin/master"]) {
          const verified = yield* git({
            operation: "ThreadTransfer.export.verifyBasisCandidate",
            cwd,
            args: ["rev-parse", "--verify", "--quiet", candidate],
            allowNonZeroExit: true,
          });
          if (verified.exitCode === 0) {
            basisRef = candidate;
            break;
          }
        }
      }
      if (basisRef === null) {
        return null;
      }
      const mergeBase = yield* git({
        operation: "ThreadTransfer.export.mergeBase",
        cwd,
        args: ["merge-base", branch, basisRef],
        allowNonZeroExit: true,
      });
      return mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : null;
    });

  const exportGitState = (input: {
    readonly thread: OrchestrationThread;
    readonly cwd: string;
    readonly warnings: string[];
  }) =>
    Effect.gen(function* () {
      const { thread, cwd, warnings } = input;
      const branch = thread.branch;
      if (branch === null) {
        warnings.push("Thread has no branch; git state was not transferred.");
        return { git: null, checkpoints: [] as OrchestrationCheckpointSummary[] };
      }
      if (!(yield* isGitRepository(cwd))) {
        warnings.push("Thread workspace is not a git repository; git state was not transferred.");
        return { git: null, checkpoints: [] as OrchestrationCheckpointSummary[] };
      }

      const branchTip = yield* git({
        operation: "ThreadTransfer.export.branchTip",
        cwd,
        args: ["rev-parse", "--verify", `refs/heads/${branch}`],
        allowNonZeroExit: true,
      });
      if (branchTip.exitCode !== 0) {
        warnings.push(
          `Branch '${branch}' was not found in the repository; git state was not transferred.`,
        );
        return { git: null, checkpoints: [] as OrchestrationCheckpointSummary[] };
      }
      const branchTipSha = branchTip.stdout.trim();

      // Checkpoint refs that actually exist in the repository.
      const refPrefix = `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(thread.id)}`;
      const refsListed = yield* git({
        operation: "ThreadTransfer.export.listCheckpointRefs",
        cwd,
        args: ["for-each-ref", "--format=%(refname)", refPrefix],
      });
      const existingRefs = new Set(
        refsListed.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      );

      const transferableCheckpoints = thread.checkpoints.filter(
        (checkpoint) => checkpoint.status === "ready" && existingRefs.has(checkpoint.checkpointRef),
      );
      const droppedCheckpoints = thread.checkpoints.length - transferableCheckpoints.length;
      if (droppedCheckpoints > 0) {
        warnings.push(
          `${droppedCheckpoints} checkpoint(s) had no usable git ref and were not transferred.`,
        );
      }
      const checkpointRefs = transferableCheckpoints.map((checkpoint) => checkpoint.checkpointRef);
      // Carry the pre-turn baseline ref too when present so revert-to-start
      // keeps working on the target machine.
      const baselineRef = checkpointRefForThreadTurn(thread.id, 0);
      if (existingRefs.has(baselineRef) && !checkpointRefs.includes(baselineRef)) {
        checkpointRefs.push(baselineRef);
      }

      const mergeBase = yield* resolveBundleBasis(cwd, branch);

      // Bundle the branch plus checkpoint refs, excluding history the target
      // clone is expected to have. Falls back to a full bundle when no remote
      // basis exists.
      const bundlePath = path.join(
        yield* fs.makeTempDirectory({ prefix: "t3-thread-move-" }),
        "thread.bundle",
      );
      const bundleRefs = [`refs/heads/${branch}`, ...checkpointRefs];
      const bundleArgs = [
        "bundle",
        "create",
        bundlePath,
        ...(mergeBase !== null && mergeBase !== branchTipSha ? [`^${mergeBase}`] : []),
        ...bundleRefs,
      ];
      const bundleResult = yield* git({
        operation: "ThreadTransfer.export.bundleCreate",
        cwd,
        args: bundleArgs,
        allowNonZeroExit: true,
        timeoutMs: GIT_BUNDLE_TIMEOUT_MS,
      });
      let bundleBase64: string | null = null;
      if (bundleResult.exitCode === 0) {
        const bundleBytes = yield* fs.readFile(bundlePath);
        bundleBase64 = Encoding.encodeBase64(bundleBytes);
      } else if (/empty bundle/i.test(bundleResult.stderr)) {
        // Branch tip equals the basis and there are no checkpoint refs — the
        // target can recreate the branch from `branchTipSha` directly.
        bundleBase64 = null;
      } else {
        return yield* new OrchestrationExportThreadError({
          message: `Failed to create the git bundle for branch '${branch}': ${bundleResult.stderr.trim()}`,
        });
      }
      yield* fs.remove(bundlePath, { force: true }).pipe(Effect.orElseSucceed(() => undefined));

      // Uncommitted tracked changes (staged + unstaged vs HEAD), applied on
      // the target with `git apply --binary`.
      const diffResult = yield* git({
        operation: "ThreadTransfer.export.dirtyDiff",
        cwd,
        args: ["diff", "HEAD", "--binary"],
        maxOutputBytes: MAX_DIRTY_DIFF_BYTES,
      });
      let dirtyDiff: string | null = diffResult.stdout.length > 0 ? diffResult.stdout : null;
      if (diffResult.stdoutTruncated) {
        warnings.push("Uncommitted changes exceeded the move size limit and were not transferred.");
        dirtyDiff = null;
      }

      const untrackedFiles = yield* collectUntrackedFiles(cwd, warnings);

      const gitState: ThreadMoveGitState = {
        branch,
        branchTipSha,
        bundleBase64,
        checkpointRefs,
        dirtyDiff,
        untrackedFiles,
      };
      return { git: gitState, checkpoints: transferableCheckpoints };
    });

  const exportProviderSession = (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly warnings: string[];
  }) =>
    Effect.gen(function* () {
      const runtime = yield* providerSessionRuntime
        .getByThreadId({ threadId: input.threadId })
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
      if (runtime === undefined) {
        return null;
      }

      const base: ThreadMoveProviderSession = {
        providerName: runtime.providerName,
        providerInstanceId: runtime.providerInstanceId,
        adapterKey: runtime.adapterKey,
        runtimeMode: runtime.runtimeMode,
        resumeCursor: runtime.resumeCursor,
        sourceCwd: input.cwd,
        sessionFile: null,
      };

      if (runtime.providerName !== CLAUDE_PROVIDER_NAME) {
        input.warnings.push(
          `Native agent session context for provider '${runtime.providerName}' is not transferred; ${PROVIDER_CONTEXT_FALLBACK}.`,
        );
        return { ...base, resumeCursor: null };
      }

      const sessionId = readClaudeSessionIdFromCursor(runtime.resumeCursor);
      if (sessionId === undefined) {
        input.warnings.push(
          `No resumable Claude session id was found; ${PROVIDER_CONTEXT_FALLBACK}.`,
        );
        return { ...base, resumeCursor: null };
      }

      const sessionFilePath = path.join(claudeProjectsDirForCwd(input.cwd), `${sessionId}.jsonl`);
      const stat = yield* fs.stat(sessionFilePath).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(stat)) {
        input.warnings.push(
          `Claude session transcript '${sessionId}.jsonl' was not found on the source machine; ${PROVIDER_CONTEXT_FALLBACK}.`,
        );
        return { ...base, resumeCursor: null };
      }
      if (Number(stat.value.size) > MAX_PROVIDER_SESSION_FILE_BYTES) {
        input.warnings.push(
          "The Claude session transcript exceeds the move size limit and was not transferred.",
        );
        return { ...base, resumeCursor: null };
      }

      const content = yield* fs.readFileString(sessionFilePath);
      return {
        ...base,
        sessionFile: {
          fileName: `${sessionId}.jsonl`,
          content,
        },
      } satisfies ThreadMoveProviderSession;
    });

  const exportThread: ThreadTransferShape["exportThread"] = (input) =>
    Effect.gen(function* () {
      const warnings: string[] = [];

      const initialThread = yield* snapshotQuery
        .getThreadDetailById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (initialThread === undefined) {
        return yield* new OrchestrationExportThreadError({
          message: `Thread '${input.threadId}' was not found.`,
        });
      }

      const project = yield* snapshotQuery
        .getProjectShellById(initialThread.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (project === undefined) {
        return yield* new OrchestrationExportThreadError({
          message: `Project '${initialThread.projectId}' for thread '${input.threadId}' was not found.`,
        });
      }
      if (project.kind === "chat") {
        return yield* new OrchestrationExportThreadError({
          message: "General chats are local to this environment and cannot be moved.",
        });
      }

      yield* quiesceThread(initialThread, warnings);

      // Re-read after quiescing so the exported history includes the
      // interrupt/stop outcome.
      const thread =
        (yield* snapshotQuery
          .getThreadDetailById(input.threadId)
          .pipe(Effect.map(Option.getOrUndefined))) ?? initialThread;

      const cwd = thread.worktreePath ?? project.workspaceRoot;
      const gitExport = yield* exportGitState({ thread, cwd, warnings });
      const providerSession = yield* exportProviderSession({
        threadId: thread.id,
        cwd,
        warnings,
      });

      const portable: PortableThread = {
        id: thread.id,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        branch: thread.branch,
        goal: thread.goal ?? null,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        messages: thread.messages.filter((message) => !message.streaming),
        proposedPlans: thread.proposedPlans,
        // Strip source-environment event sequences; they are meaningless on
        // the target and would corrupt activity ordering there.
        activities: thread.activities.map(({ sequence: _sequence, ...activity }) => activity),
        checkpoints: gitExport.checkpoints,
      };

      const bundle: ThreadMoveBundle = {
        version: THREAD_MOVE_BUNDLE_VERSION,
        exportedAt: yield* nowIso,
        sourceProjectId: thread.projectId,
        sourceWorkspaceRoot: project.workspaceRoot,
        repositoryIdentity: project.repositoryIdentity ?? null,
        thread: portable,
        git: gitExport.git,
        providerSession,
        warnings,
      };

      return { bundle };
    }).pipe(
      Effect.mapError((cause) =>
        isExportThreadError(cause)
          ? cause
          : new OrchestrationExportThreadError({
              message: toMessage(cause, "Failed to export the thread."),
              cause,
            }),
      ),
      Effect.withSpan("ThreadTransfer.exportThread"),
    );

  const restoreGitState = (input: {
    readonly gitState: ThreadMoveGitState;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
    readonly branchConflict: ThreadMoveBranchConflictResolution;
    readonly warnings: string[];
  }) =>
    Effect.gen(function* () {
      const { gitState, workspaceRoot, warnings } = input;

      if (!(yield* isGitRepository(workspaceRoot))) {
        warnings.push(
          "Target project is not a git repository; branch, checkpoints, and uncommitted changes were not restored.",
        );
        return { branch: null, worktreePath: null, checkpointsRestored: false };
      }

      const existingBranch = yield* git({
        operation: "ThreadTransfer.import.branchLookup",
        cwd: workspaceRoot,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${gitState.branch}`],
        allowNonZeroExit: true,
      });
      const existingBranchSha = existingBranch.exitCode === 0 ? existingBranch.stdout.trim() : null;

      // A branch that is already checked out (e.g. the project root sitting
      // on `main`) cannot host another worktree even at the same commit.
      const worktreeList = yield* git({
        operation: "ThreadTransfer.import.worktreeList",
        cwd: workspaceRoot,
        args: ["worktree", "list", "--porcelain"],
        allowNonZeroExit: true,
      });
      const checkedOutBranches = new Set(
        worktreeList.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.startsWith("branch "))
          .map((line) => line.slice("branch ".length)),
      );

      // Shared or diverged branches (a thread working directly on `main`,
      // or a rare name collision) must not be overwritten or hijacked on
      // the target. With the caller's consent the thread's work lands on a
      // fallback branch at the exported tip; otherwise fail with a
      // machine-readable reason so the client can ask the user and retry.
      const branchUnavailable =
        existingBranchSha !== null &&
        (existingBranchSha !== gitState.branchTipSha ||
          checkedOutBranches.has(`refs/heads/${gitState.branch}`));
      if (branchUnavailable && input.branchConflict !== "new-worktree") {
        return yield* new OrchestrationImportThreadError({
          message: `Branch '${gitState.branch}' already exists on the target machine (${
            existingBranchSha !== gitState.branchTipSha
              ? "it points at different history"
              : "it is checked out"
          }). Retry with the new-worktree option to continue the thread on a fallback branch.`,
          reason: "branch-conflict",
        });
      }
      let targetBranch = gitState.branch;
      if (branchUnavailable) {
        const suffix =
          input.threadId
            .replace(/[^a-zA-Z0-9]/g, "")
            .slice(0, 8)
            .toLowerCase() || "thread";
        let candidate = `${gitState.branch}-moved-${suffix}`;
        for (let attempt = 2; ; attempt += 1) {
          const candidateExists = yield* git({
            operation: "ThreadTransfer.import.fallbackBranchLookup",
            cwd: workspaceRoot,
            args: ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`],
            allowNonZeroExit: true,
          });
          if (candidateExists.exitCode !== 0) {
            break;
          }
          candidate = `${gitState.branch}-moved-${suffix}-${attempt}`;
        }
        targetBranch = candidate;
        warnings.push(
          `Branch '${gitState.branch}' on the target machine is already in use (${
            existingBranchSha !== gitState.branchTipSha
              ? "it points at different history"
              : "it is checked out"
          }), so the moved thread continues on new branch '${targetBranch}' at the exported state.`,
        );
      }

      if (gitState.bundleBase64 !== null) {
        const bundleBytes = Result.getOrThrow(Encoding.decodeBase64(gitState.bundleBase64));
        const bundleDir = yield* fs.makeTempDirectory({ prefix: "t3-thread-move-" });
        const bundlePath = path.join(bundleDir, "thread.bundle");
        yield* fs.writeFile(bundlePath, bundleBytes);

        const verifyBundle = git({
          operation: "ThreadTransfer.import.bundleVerify",
          cwd: workspaceRoot,
          args: ["bundle", "verify", bundlePath],
          allowNonZeroExit: true,
          timeoutMs: GIT_BUNDLE_TIMEOUT_MS,
        });
        let verifyResult = yield* verifyBundle;
        if (verifyResult.exitCode !== 0) {
          // Thin bundles assume the target already has the source's shared
          // base commits. A stale clone is the common cause, and both
          // projects share the same repository, so fetch the target's
          // primary remote once and retry before failing.
          const fetchedRemote = yield* fetchPrimaryRemote(workspaceRoot);
          if (fetchedRemote !== null) {
            verifyResult = yield* verifyBundle;
          }
          if (verifyResult.exitCode !== 0) {
            return yield* new OrchestrationImportThreadError({
              message: `The target repository is missing commits this thread is based on${
                fetchedRemote !== null
                  ? ` (even after fetching '${fetchedRemote}'; push the thread's base commits to the shared remote, or pull on the target project, then retry)`
                  : " (the target project has no reachable git remote to fetch them from; run a git fetch/pull there first)"
              }: ${verifyResult.stderr.trim()}`,
            });
          }
        }

        // Fetch exactly the refs the bundle advertises.
        const heads = yield* git({
          operation: "ThreadTransfer.import.bundleListHeads",
          cwd: workspaceRoot,
          args: ["bundle", "list-heads", bundlePath],
          timeoutMs: GIT_BUNDLE_TIMEOUT_MS,
        });
        const bundledRefs = heads.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map((line) => line.split(/\s+/)[1])
          .filter((ref): ref is string => ref !== undefined && ref !== "HEAD");
        if (bundledRefs.length > 0) {
          const refspecs = bundledRefs.map((ref) => {
            if (ref !== `refs/heads/${gitState.branch}`) {
              return `+${ref}:${ref}`;
            }
            if (targetBranch !== gitState.branch) {
              // Land the bundle's branch on the fresh fallback name.
              return `+${ref}:refs/heads/${targetBranch}`;
            }
            // Same tip already present: non-forced no-op fetch.
            return existingBranchSha !== null ? `${ref}:${ref}` : `+${ref}:${ref}`;
          });
          yield* git({
            operation: "ThreadTransfer.import.bundleFetch",
            cwd: workspaceRoot,
            args: ["fetch", "--quiet", "--no-tags", bundlePath, ...refspecs],
            timeoutMs: GIT_BUNDLE_TIMEOUT_MS,
          });
        }
        yield* fs
          .remove(bundleDir, { recursive: true, force: true })
          .pipe(Effect.orElseSucceed(() => undefined));
      }

      // Ensure the branch exists even when the bundle carried no branch ref
      // (e.g. the thread branch had no unique commits).
      const branchAfterFetch = yield* git({
        operation: "ThreadTransfer.import.branchVerify",
        cwd: workspaceRoot,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${targetBranch}`],
        allowNonZeroExit: true,
      });
      if (branchAfterFetch.exitCode !== 0) {
        const verifyTipSha = git({
          operation: "ThreadTransfer.import.branchTipShaVerify",
          cwd: workspaceRoot,
          args: ["rev-parse", "--verify", "--quiet", `${gitState.branchTipSha}^{commit}`],
          allowNonZeroExit: true,
        });
        let shaExists = yield* verifyTipSha;
        if (shaExists.exitCode !== 0) {
          if ((yield* fetchPrimaryRemote(workspaceRoot)) !== null) {
            shaExists = yield* verifyTipSha;
          }
        }
        if (shaExists.exitCode !== 0) {
          return yield* new OrchestrationImportThreadError({
            message: `The target repository is missing commit ${gitState.branchTipSha} for branch '${gitState.branch}' (fetching the target's remote did not provide it; push or pull the shared remote first).`,
          });
        }
        yield* git({
          operation: "ThreadTransfer.import.branchCreate",
          cwd: workspaceRoot,
          args: ["branch", targetBranch, gitState.branchTipSha],
        });
      }

      const worktree = yield* gitWorkflow.createWorktree({
        cwd: workspaceRoot,
        refName: targetBranch,
        path: null,
      });
      const worktreePath = worktree.worktree.path;

      const cleanupWorktree = gitWorkflow
        .removeWorktree({ cwd: workspaceRoot, path: worktreePath, force: true })
        .pipe(Effect.ignoreCause({ log: true }));

      const restoreWorkingTree = Effect.gen(function* () {
        if (gitState.dirtyDiff !== null) {
          yield* git({
            operation: "ThreadTransfer.import.applyDirtyDiff",
            cwd: worktreePath,
            args: ["apply", "--binary", "--whitespace=nowarn"],
            stdin: gitState.dirtyDiff,
          });
        }
        for (const untracked of gitState.untrackedFiles) {
          if (!isSafeRelativeFilePath(untracked.path)) {
            warnings.push(`Skipped untracked file with unsafe path '${untracked.path}'.`);
            continue;
          }
          const absolutePath = path.join(worktreePath, untracked.path);
          yield* fs.makeDirectory(path.dirname(absolutePath), { recursive: true });
          yield* fs.writeFile(
            absolutePath,
            Result.getOrThrow(Encoding.decodeBase64(untracked.contentBase64)),
          );
        }
      });

      yield* restoreWorkingTree.pipe(
        Effect.catch((cause) =>
          cleanupWorktree.pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new OrchestrationImportThreadError({
                  message: toMessage(
                    cause,
                    "Failed to restore uncommitted changes in the new worktree.",
                  ),
                  cause,
                }),
              ),
            ),
          ),
        ),
      );

      return { branch: targetBranch, worktreePath, checkpointsRestored: true };
    });

  const transplantProviderSession = (input: {
    readonly providerSession: ThreadMoveProviderSession;
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly modelSelection: PortableThread["modelSelection"];
    readonly exportedAt: string;
    readonly warnings: string[];
  }) =>
    Effect.gen(function* () {
      const { providerSession } = input;
      const nativeSessionContextTransferred =
        providerSession.providerName === CLAUDE_PROVIDER_NAME &&
        providerSession.sessionFile !== null &&
        providerSession.resumeCursor !== null;

      if (
        providerSession.sessionFile !== null &&
        providerSession.providerName === CLAUDE_PROVIDER_NAME
      ) {
        const sessionsDir = claudeProjectsDirForCwd(input.cwd);
        const targetPath = path.join(sessionsDir, providerSession.sessionFile.fileName);
        const rewritten = rewriteClaudeSessionCwd(
          providerSession.sessionFile.content,
          providerSession.sourceCwd,
          input.cwd,
        );
        yield* fs.makeDirectory(sessionsDir, { recursive: true });
        yield* fs.writeFileString(targetPath, rewritten);
      }

      const lastSeenAt = yield* nowIso;
      yield* providerSessionRuntime.upsert({
        threadId: input.threadId,
        providerName: providerSession.providerName,
        providerInstanceId: providerSession.providerInstanceId,
        adapterKey: providerSession.adapterKey,
        runtimeMode: providerSession.runtimeMode,
        status: "stopped",
        lastSeenAt,
        resumeCursor: nativeSessionContextTransferred ? providerSession.resumeCursor : null,
        runtimePayload: nativeSessionContextTransferred
          ? markThreadTransferContextHandoffConsumed(
              {
                cwd: input.cwd,
                modelSelection: input.modelSelection,
              },
              input.exportedAt,
            )
          : {
              cwd: input.cwd,
              modelSelection: input.modelSelection,
            },
      });
    }).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          input.warnings.push(
            `Agent session context could not be transplanted (${toMessage(cause, "unknown error")}); ${PROVIDER_CONTEXT_FALLBACK}.`,
          );
        }),
      ),
    );

  const importThread: ThreadTransferShape["importThread"] = (input) =>
    Effect.gen(function* () {
      const warnings: string[] = [...input.bundle.warnings];
      const portable = input.bundle.thread;

      const project = yield* snapshotQuery
        .getProjectShellById(input.projectId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (project === undefined) {
        return yield* new OrchestrationImportThreadError({
          message: `Target project '${input.projectId}' was not found.`,
        });
      }
      if (project.kind === "chat") {
        return yield* new OrchestrationImportThreadError({
          message: "Threads cannot be imported into the environment's General chat.",
        });
      }

      const existing = yield* snapshotQuery.getThreadShellByIdIncludingArchived(portable.id).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (existing !== undefined) {
        return yield* new OrchestrationImportThreadError({
          message: `Thread '${portable.id}' already exists on this environment.`,
        });
      }

      let branch: string | null = null;
      let worktreePath: string | null = null;
      let checkpoints = portable.checkpoints;
      if (input.bundle.git !== null) {
        const restored = yield* restoreGitState({
          gitState: input.bundle.git,
          threadId: portable.id,
          workspaceRoot: project.workspaceRoot,
          branchConflict: input.branchConflict ?? "fail",
          warnings,
        });
        branch = restored.branch;
        worktreePath = restored.worktreePath;
        if (!restored.checkpointsRestored) {
          checkpoints = [];
        }
      } else if (checkpoints.length > 0) {
        checkpoints = [];
        warnings.push(
          "Checkpoints were not transferred because the source had no usable git state.",
        );
      }

      const createdAt = yield* nowIso;
      const importMarker: OrchestrationThreadActivity = {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "thread.imported",
        summary: "Thread moved from another machine",
        payload: makeThreadTransferImportedActivityPayload({
          sourceWorkspaceRoot: input.bundle.sourceWorkspaceRoot,
          exportedAt: input.bundle.exportedAt,
          historyMessageCount: portable.messages.length,
        }),
        turnId: null,
        createdAt,
      };
      const dispatchImport = engine
        .dispatch({
          type: "thread.import",
          commandId: yield* serverCommandId("thread-move-import"),
          threadId: portable.id,
          projectId: input.projectId,
          thread: {
            ...portable,
            activities: [...portable.activities, importMarker],
            checkpoints,
          },
          branch,
          worktreePath,
          createdAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationImportThreadError({
                message: toMessage(cause, "Failed to record the imported thread."),
                cause,
              }),
          ),
        );

      yield* dispatchImport.pipe(
        Effect.catch((error) =>
          worktreePath === null
            ? Effect.fail(error)
            : gitWorkflow
                .removeWorktree({ cwd: project.workspaceRoot, path: worktreePath, force: true })
                .pipe(
                  Effect.ignoreCause({ log: true }),
                  Effect.flatMap(() => Effect.fail(error)),
                ),
        ),
      );

      if (input.bundle.providerSession !== null) {
        yield* transplantProviderSession({
          providerSession: input.bundle.providerSession,
          threadId: portable.id,
          cwd: worktreePath ?? project.workspaceRoot,
          modelSelection: portable.modelSelection,
          exportedAt: input.bundle.exportedAt,
          warnings,
        });
      }

      return {
        threadId: portable.id,
        worktreePath,
        warnings,
      };
    }).pipe(
      Effect.mapError((cause) =>
        isImportThreadError(cause)
          ? cause
          : new OrchestrationImportThreadError({
              message: toMessage(cause, "Failed to import the thread."),
              cause,
            }),
      ),
      Effect.withSpan("ThreadTransfer.importThread"),
    );

  return {
    exportThread,
    importThread,
  } satisfies ThreadTransferShape;
});

export const ThreadTransferLive = Layer.effect(ThreadTransfer, make);
