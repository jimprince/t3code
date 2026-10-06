import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as Workflow from "../git/GitWorkflowService.ts";
import * as Core from "../vcs/GitVcsDriver.ts";
import * as Process from "../vcs/VcsProcess.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as Config from "../config.ts";
import * as Workspace from "./TransferWorkspace.ts";
import { gitBoundary } from "./ForkService.testkit.ts";
const processLayer = Process.layer.pipe(Layer.provideMerge(NodeServices.layer));
const core = Core.layer.pipe(
  Layer.provideMerge(
    Layer.merge(
      processLayer,
      Config.layerTest(process.cwd(), { prefix: "t3-transfer-workspaces-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
const workflow = Layer.effect(
  Workflow.GitWorkflowService,
  Effect.gen(function* () {
    const git = yield* Core.GitVcsDriver;
    return gitBoundary({
      listRefs: git.listRefs,
      listLocalBranchNames: git.listLocalBranchNames,
      createWorktree: git.createWorktree,
      removeWorktree: git.removeWorktree,
      deleteLocalBranch: git.deleteLocalBranch,
    });
  }),
).pipe(Layer.provideMerge(core));
const live = Workspace.layer.pipe(
  Layer.provideMerge(Layer.merge(workflow, SqlitePersistenceMemory)),
);
it.effect(
  "transfers real git history, dirty files and untracked bytes; retries owned workspaces and preserves unrelated branches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* Process.VcsProcess;
      const workspace = yield* Workspace.TransferWorkspace;
      const sql = yield* SqlClient.SqlClient;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-transfer-git-" });
      const source = path.join(temporary, "source");
      const target = path.join(temporary, "target");
      yield* fs.makeDirectory(source);
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        runner.run({ operation: "transfer-git-test", command: "git", cwd, args });
      yield* git(source, ["init", "-b", "main"]);
      yield* fs.writeFileString(path.join(source, "tracked.txt"), "original\n");
      yield* git(source, ["add", "tracked.txt"]);
      yield* git(source, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture",
      ]);
      yield* git(temporary, ["clone", source, target]);
      yield* fs.writeFileString(path.join(source, "tracked.txt"), "transferred dirty change\n");
      yield* fs.writeFileString(path.join(source, "untracked.txt"), "portable bytes\n");
      const state = (yield* workspace.export(source, "main")).git;
      const missing = yield* workspace.export(source, "missing-branch");
      assert.equal(missing.git, null);
      assert.isTrue(missing.warnings[0]?.includes("was not found"));
      assert.isNotNull(state);
      const input = {
        cwd: target,
        git: state,
        key: "fixture-receipt",
        threadId: "source-thread",
        branchConflict: "fail" as const,
      };
      const conflict = yield* Effect.result(workspace.import(input));
      assert.equal(conflict._tag, "Failure");
      const moved = yield* workspace.import({ ...input, branchConflict: "new-worktree" });
      assert.equal(moved.branch, "main-moved-sourceth");
      assert.isNotNull(moved.worktreePath);
      assert.equal(
        yield* fs.readFileString(path.join(moved.worktreePath!, "tracked.txt")),
        "transferred dirty change\n",
      );
      assert.equal(
        yield* fs.readFileString(path.join(moved.worktreePath!, "untracked.txt")),
        "portable bytes\n",
      );
      const replay = yield* workspace.import(input);
      assert.equal(replay.worktreePath, moved.worktreePath);
      // Simulate a crash before the ready marker, with the filesystem already materialized.
      yield* sql`UPDATE fork_transfer_workspaces SET ready = 0 WHERE receipt = ${input.key}`;
      const recovered = yield* workspace.import(input);
      assert.equal(recovered.worktreePath, moved.worktreePath);
      assert.equal((yield* git(target, ["branch", "--show-current"])).stdout.trim(), "main");
      assert.equal(yield* fs.readFileString(path.join(target, "tracked.txt")), "original\n");
      const rejected = yield* Effect.result(
        workspace.import({
          ...input,
          key: "unsafe-receipt",
          branchConflict: "new-worktree",
          git: { ...state!, untrackedFiles: [{ path: "../escape.txt", contentBase64: "eA==" }] },
        }),
      );
      assert.equal(rejected._tag, "Failure");
      assert.isFalse(yield* fs.exists(path.join(temporary, "escape.txt")));
      assert.isTrue(
        (yield* git(target, ["branch", "--list", moved.branch!])).stdout.includes(moved.branch!),
      );
      yield* moved.cleanup;
      assert.isFalse(yield* fs.exists(moved.worktreePath!));
      assert.equal((yield* git(target, ["branch", "--show-current"])).stdout.trim(), "main");
    }).pipe(Effect.provide(live)),
);
