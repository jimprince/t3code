import type { ThreadMoveGitState } from "@t3tools/contracts";
import { ThreadTransferError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";

const isTransferError = Schema.is(ThreadTransferError);
const MAX_BYTES = 64 * 1024 * 1024;
function isSafeTransferPath(file: string): boolean {
  return (
    file.length > 0 &&
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !file.includes("\0") &&
    !/^[a-z]:/i.test(file) &&
    file.split("/").every((part) => part !== ".." && part !== ".git" && part !== "")
  );
}
export interface TransferWorkspaceResult {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly cleanup: Effect.Effect<void>;
}
export class TransferWorkspace extends Context.Service<
  TransferWorkspace,
  {
    readonly export: (
      cwd: string,
      branch: string | null,
      checkpointRefs?: ReadonlyArray<string>,
    ) => Effect.Effect<
      { git: ThreadMoveGitState | null; warnings: ReadonlyArray<string> },
      ThreadTransferError
    >;
    readonly import: (input: {
      cwd: string;
      git: ThreadMoveGitState | null;
      key: string;
      threadId: string;
      branchConflict: "fail" | "new-worktree";
    }) => Effect.Effect<TransferWorkspaceResult, ThreadTransferError>;
  }
>()("t3/forkThreads/TransferWorkspace") {}
const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const workflow = yield* GitWorkflow.GitWorkflowService;
  const fs = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;
  const path = yield* Path.Path;
  const git = (cwd: string, args: ReadonlyArray<string>, stdin?: string) =>
    process.run({
      operation: "ThreadTransfer.workspace",
      command: "git",
      cwd,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: 180_000,
      maxOutputBytes: MAX_BYTES,
    });
  const mapError = (operation: string) => (cause: unknown) =>
    new ThreadTransferError({ operation, cause });
  const exportWorkspace = Effect.fn("TransferWorkspace.export")(function* (
    cwd: string,
    branch: string | null,
    checkpointRefs: ReadonlyArray<string> = [],
  ) {
    const warnings: Array<string> = [];
    if (branch === null)
      return { git: null, warnings: ["Thread has no branch; git state was not transferred."] };
    const repository = yield* git(cwd, ["rev-parse", "--is-inside-work-tree"]).pipe(Effect.option);
    if (Option.isNone(repository))
      return {
        git: null,
        warnings: ["Thread workspace is not a git repository; git state was not transferred."],
      };
    const branchTip = yield* git(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`]).pipe(
      Effect.option,
    );
    if (Option.isNone(branchTip))
      return {
        git: null,
        warnings: [
          `Branch '${branch}' was not found in the repository; git state was not transferred.`,
        ],
      };
    const tip = branchTip.value.stdout.trim();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-transfer-" });
        const bundlePath = path.join(temporary, "workspace.bundle");
        const availableRefs = (yield* git(cwd, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/t3/",
        ])).stdout.split("\n");
        const retainedRefs = checkpointRefs.filter((ref) => availableRefs.includes(ref));
        let basis: string | null = null;
        const symbolic = yield* git(cwd, [
          "symbolic-ref",
          "--quiet",
          "refs/remotes/origin/HEAD",
        ]).pipe(Effect.option);
        for (const candidate of [
          Option.isSome(symbolic) ? symbolic.value.stdout.trim() : "",
          "refs/remotes/origin/main",
          "refs/remotes/origin/master",
        ].filter(Boolean)) {
          const mergeBase = yield* git(cwd, ["merge-base", branch, candidate]).pipe(Effect.option);
          if (Option.isSome(mergeBase)) {
            basis = mergeBase.value.stdout.trim();
            break;
          }
        }
        yield* git(cwd, [
          "bundle",
          "create",
          bundlePath,
          ...(basis !== null && basis !== tip ? [`^${basis}`] : []),
          branch,
          ...retainedRefs,
        ]);
        const bundleStat = yield* fs.stat(bundlePath);
        if (Number(bundleStat.size) > MAX_BYTES)
          return yield* new ThreadTransferError({
            operation: "export-workspace",
            cause: "Git bundle exceeds move limit.",
          });
        const bundleBase64 = Encoding.encodeBase64(yield* fs.readFile(bundlePath));
        const dirtyDiff = (yield* git(cwd, ["diff", "HEAD", "--binary"])).stdout;
        const listed = (yield* git(cwd, [
          "ls-files",
          "--others",
          "--exclude-standard",
          "-z",
        ])).stdout
          .split("\0")
          .filter(Boolean);
        const untrackedFiles: Array<{ path: string; contentBase64: string }> = [];
        let bytes = 0;
        for (const file of listed) {
          if (!isSafeTransferPath(file))
            return yield* new ThreadTransferError({
              operation: "export-workspace",
              cause: "Unsafe untracked path.",
            });
          const source = yield* fs.realPath(path.join(cwd, file));
          const root = yield* fs.realPath(cwd);
          if (!source.startsWith(`${root}${path.sep}`))
            return yield* new ThreadTransferError({
              operation: "export-workspace",
              cause: "Untracked symlink escapes workspace.",
            });
          const info = yield* fs.stat(source);
          if (info.type !== "File") continue;
          if (Number(info.size) > 16 * 1024 * 1024) {
            warnings.push(
              `Untracked file '${file}' exceeds the move size limit and was not transferred.`,
            );
            continue;
          }
          if (bytes + Number(info.size) > MAX_BYTES) {
            warnings.push(
              `Untracked files beyond '${file}' exceed the total move size limit and were not transferred.`,
            );
            break;
          }
          const content = yield* fs.readFile(path.join(cwd, file));
          bytes += content.length;
          untrackedFiles.push({ path: file, contentBase64: Encoding.encodeBase64(content) });
        }
        return {
          git: {
            branch,
            branchTipSha: tip,
            bundleBase64,
            checkpointRefs: retainedRefs,
            dirtyDiff: dirtyDiff || null,
            untrackedFiles,
          },
          warnings,
        };
      }),
    );
  });
  const importWorkspace = Effect.fn("TransferWorkspace.import")(function* (input: {
    cwd: string;
    git: ThreadMoveGitState | null;
    key: string;
    threadId: string;
    branchConflict: "fail" | "new-worktree";
  }) {
    yield* sql`CREATE TABLE IF NOT EXISTS fork_transfer_workspaces (receipt TEXT PRIMARY KEY, cwd TEXT NOT NULL, branch TEXT NOT NULL, new_branch INTEGER NOT NULL, ready INTEGER NOT NULL)`;
    const claims = yield* sql<{
      cwd: string;
      branch: string;
      new_branch: number;
      ready: number;
    }>`SELECT * FROM fork_transfer_workspaces WHERE receipt = ${input.key}`;
    const claim = claims[0];
    if (claim && claim.cwd !== input.cwd)
      return yield* new ThreadTransferError({
        operation: "import-workspace",
        cause: "Workspace receipt belongs to another repository.",
      });
    const state = input.git;
    if (state === null) return { branch: null, worktreePath: null, cleanup: Effect.void };
    if (!/^[a-f0-9]{40,64}$/.test(state.branchTipSha))
      return yield* new ThreadTransferError({
        operation: "import-workspace",
        cause: "Invalid workspace commit.",
      });
    const refs = yield* workflow.listRefs({
      cwd: input.cwd,
      query: state.branch,
      refKind: "local",
      refresh: true,
      limit: 100,
    });
    const existing = refs.refs.find((ref) => ref.name === state.branch);
    const tip = existing
      ? (yield* git(input.cwd, [
          "rev-parse",
          "--verify",
          `refs/heads/${state.branch}`,
        ])).stdout.trim()
      : null;
    const conflict =
      existing !== undefined && (existing.worktreePath !== null || tip !== state.branchTipSha);
    if (!claim && conflict && input.branchConflict === "fail")
      return yield* new ThreadTransferError({
        operation: "import-workspace",
        reason: "branch-conflict",
        cause: "Destination branch already exists with different history or is checked out.",
      });
    let branch = claim?.branch ?? state.branch;
    const names = yield* workflow.listLocalBranchNames(input.cwd);
    if (!claim && conflict) {
      const suffix =
        input.threadId
          .replace(/[^a-zA-Z0-9]/g, "")
          .slice(0, 8)
          .toLowerCase() || "thread";
      branch = `${state.branch}-moved-${suffix}`;
      for (let attempt = 2; names.includes(branch); attempt += 1)
        branch = `${state.branch}-moved-${suffix}-${attempt}`;
    }
    const newBranch = claim ? claim.new_branch === 1 : !names.includes(branch);
    yield* sql`INSERT OR IGNORE INTO fork_transfer_workspaces VALUES (${input.key}, ${input.cwd}, ${branch}, ${newBranch ? 1 : 0}, 0)`;
    if (state.bundleBase64 !== null) {
      const decoded = Encoding.decodeBase64(state.bundleBase64);
      if (Result.isFailure(decoded) || decoded.success.length > MAX_BYTES)
        return yield* new ThreadTransferError({
          operation: "import-workspace",
          cause: "Invalid git bundle bytes.",
        });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-import-" });
          const file = path.join(temporary, "workspace.bundle");
          yield* fs.writeFile(file, decoded.success);
          yield* git(input.cwd, ["bundle", "verify", file]).pipe(
            Effect.catch(() =>
              Effect.gen(function* () {
                const remotes = (yield* git(input.cwd, ["remote"])).stdout
                  .split("\n")
                  .filter(Boolean);
                const remote = remotes.includes("origin") ? "origin" : remotes[0];
                if (remote) yield* git(input.cwd, ["fetch", "--quiet", remote]);
                yield* git(input.cwd, ["bundle", "verify", file]);
              }),
            ),
          );
          yield* git(input.cwd, ["bundle", "unbundle", file]);
        }),
      );
    }
    const owned = claim
      ? (yield* workflow.listRefs({
          cwd: input.cwd,
          query: branch,
          refKind: "local",
          refresh: true,
          limit: 100,
        })).refs.find((ref) => ref.name === branch)
      : undefined;
    const tree = owned?.worktreePath
      ? { path: owned.worktreePath }
      : (yield* workflow.createWorktree({
          cwd: input.cwd,
          refName: state.branchTipSha,
          ...(!names.includes(branch) ? { newRefName: branch } : { refName: branch }),
          baseRefName: state.branch,
          path: null,
        })).worktree;
    const cleanup = workflow.removeWorktree({ cwd: input.cwd, path: tree.path, force: true }).pipe(
      Effect.andThen(
        newBranch
          ? workflow.deleteLocalBranch({ cwd: input.cwd, refName: branch, force: true })
          : Effect.void,
      ),
      Effect.andThen(sql`DELETE FROM fork_transfer_workspaces WHERE receipt = ${input.key}`),
      Effect.catch(() => Effect.void),
    );
    if (claim?.ready === 1 && owned?.worktreePath)
      return { branch, worktreePath: tree.path, cleanup };
    yield* Effect.gen(function* () {
      if (state.dirtyDiff) {
        const currentDiff = (yield* git(tree.path, ["diff", "HEAD", "--binary"])).stdout;
        if (currentDiff !== state.dirtyDiff) {
          if (currentDiff !== "")
            return yield* new ThreadTransferError({
              operation: "import-workspace",
              cause: "Incomplete workspace contains unrelated changes.",
            });
          yield* git(tree.path, ["apply", "--check", "--binary", "-"], state.dirtyDiff);
          yield* git(tree.path, ["apply", "--binary", "-"], state.dirtyDiff);
        }
      }
      let total = 0;
      for (const file of state.untrackedFiles) {
        if (!isSafeTransferPath(file.path))
          return yield* new ThreadTransferError({
            operation: "import-workspace",
            cause: "Unsafe untracked path.",
          });
        const decoded = Encoding.decodeBase64(file.contentBase64);
        if (
          Result.isFailure(decoded) ||
          decoded.success.length > 16 * 1024 * 1024 ||
          total + decoded.success.length > MAX_BYTES
        )
          return yield* new ThreadTransferError({
            operation: "import-workspace",
            cause: "Invalid untracked bytes.",
          });
        total += decoded.success.length;
        const destination = path.join(tree.path, file.path);
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        const parent = yield* fs.realPath(path.dirname(destination));
        const root = yield* fs.realPath(tree.path);
        if (parent !== root && !parent.startsWith(`${root}${path.sep}`))
          return yield* new ThreadTransferError({
            operation: "import-workspace",
            cause: "Untracked symlink escapes workspace.",
          });
        // Exclusive creation rejects tracked-path collisions instead of overwriting the checkout.
        if (claim && (yield* fs.exists(destination))) {
          const present = yield* fs.readFile(destination);
          if (Encoding.encodeBase64(present) !== Encoding.encodeBase64(decoded.success))
            return yield* new ThreadTransferError({
              operation: "import-workspace",
              cause: "Incomplete workspace file differs from transfer.",
            });
        } else yield* fs.writeFile(destination, decoded.success, { flag: "wx" });
      }
    }).pipe(Effect.onError(() => cleanup));
    yield* sql`UPDATE fork_transfer_workspaces SET ready = 1 WHERE receipt = ${input.key}`;
    return { branch, worktreePath: tree.path, cleanup };
  });
  return TransferWorkspace.of({
    export: (cwd, branch, refs) =>
      exportWorkspace(cwd, branch, refs).pipe(Effect.mapError(mapError("export-workspace"))),
    import: (input) =>
      importWorkspace(input).pipe(
        Effect.mapError((cause) =>
          isTransferError(cause) ? cause : mapError("import-workspace")(cause),
        ),
      ),
  });
});
export const layer = Layer.effect(TransferWorkspace, make);
