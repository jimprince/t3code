// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import { it } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { makeInternalGitResolver } from "./InternalGitExecutable.ts";

describe("internal Git executable", () => {
  let root: string;
  let wrapper: string;
  let native: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = NodeFS.realpathSync(NodeFS.mkdtempSync("/tmp/t3-internal-git-"));
    wrapper = NodePath.join(root, ".shared", "bin", "git");
    native = NodePath.join(root, "native", "git");
    for (const path of [wrapper, native])
      NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(wrapper, "#!/bin/sh\nprintf 'agent-guard'\n", { mode: 0o755 });
    NodeFS.writeFileSync(native, "#!/bin/sh\nprintf 'native-git'\n", { mode: 0o755 });
    env = { HOME: root, PATH: `${NodePath.dirname(wrapper)}:${NodePath.dirname(native)}` };
  });

  afterEach(() => NodeFS.rmSync(root, { recursive: true, force: true }));

  const input = () => ({
    operation: "test.internal-git",
    command: "git",
    args: ["--version"],
    cwd: root,
  });

  it.effect("VcsProcess bypasses wrappers while the shared runner preserves agent PATH", () =>
    Effect.gen(function* () {
      const results = yield* Effect.gen(function* () {
        const vcs = yield* VcsProcess.VcsProcess;
        const runner = yield* ProcessRunner.ProcessRunner;
        const internal = yield* vcs.run(input());
        const agent = yield* runner.run(input());
        return { internal, agent };
      }).pipe(
        Effect.provide(
          Layer.merge(VcsProcess.layer, ProcessRunner.layer).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, env),
      );
      expect(results.internal.stdout).toBe("native-git");
      expect(results.agent.stdout).toBe("agent-guard");
      expect(env.PATH).toBe(`${NodePath.dirname(wrapper)}:${NodePath.dirname(native)}`);
    }),
  );

  it.effect("VcsProcess reuses resolution across repositories and concurrent requests", () =>
    Effect.gen(function* () {
      const resolve = vi.fn((candidate: string) => (candidate === native ? native : undefined));
      const run = vi.fn((_input: ProcessRunner.ProcessRunInput) =>
        Effect.succeed({
          code: ChildProcessSpawner.ExitCode(0),
          stdout: "git version native",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } satisfies ProcessRunner.ProcessRunOutput),
      );
      yield* VcsProcess.make.pipe(
        Effect.flatMap((service) =>
          Effect.all(
            [
              service.run(input()),
              service.run({ ...input(), cwd: NodePath.join(root, "other-repository") }),
              service.run({ ...input(), command: "gh" }),
            ],
            { concurrency: 3 },
          ),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(SpawnExecutableResolution, resolve),
      );
      expect(resolve.mock.calls).toEqual([[native, "linux", env]]);
      expect(run.mock.calls.map(([request]) => request.command)).toEqual([native, native, "gh"]);
    }),
  );

  it("prefers system Git on macOS without checking the wrapper", () => {
    const resolve = vi.fn((candidate: string) =>
      candidate === "/usr/bin/git" ? candidate : undefined,
    );
    expect(makeInternalGitResolver(resolve)("darwin", env, root)).toBe("/usr/bin/git");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("skips symlink aliases and falls back to Git later on PATH", () => {
    const alias = NodePath.join(root, "alias", "git");
    NodeFS.mkdirSync(NodePath.dirname(alias));
    NodeFS.symlinkSync(wrapper, alias);
    env.PATH = `${NodePath.dirname(alias)}:${env.PATH}`;
    const resolve = (candidate: string) => (NodeFS.existsSync(candidate) ? candidate : undefined);
    expect(makeInternalGitResolver(resolve)("linux", env, root)).toBe(native);
  });

  it("falls back to Homebrew Git when system Git is unavailable", () => {
    const resolve = vi.fn((candidate: string) => (candidate === native ? candidate : undefined));
    expect(makeInternalGitResolver(resolve)("darwin", env, root)).toBe(native);
    expect(resolve.mock.calls.map(([path]) => path)).toEqual(["/usr/bin/git", native]);
  });

  it.effect("never spawns a wrapper when it is the only Git available", () =>
    Effect.gen(function* () {
      const run = vi.fn();
      env.PATH = NodePath.dirname(wrapper);
      const errors = yield* VcsProcess.make.pipe(
        Effect.flatMap((service) =>
          Effect.all([
            service.run(input()).pipe(Effect.flip),
            service.run(input()).pipe(Effect.flip),
          ]),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run })),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, env),
      );
      expect(errors.map((error) => error._tag)).toEqual([
        "VcsProcessSpawnError",
        "VcsProcessSpawnError",
      ]);
      expect(run).not.toHaveBeenCalled();
    }),
  );

  it("keys cached resolution by PATH and by cwd for relative PATH entries", () => {
    const resolve = vi.fn((candidate: string) => candidate);
    const git = makeInternalGitResolver(resolve);
    expect(git("linux", { ...env, PATH: "native" }, root)).toBe(native);
    expect(git("linux", { ...env, PATH: "native" }, `${root}/other`)).toBe(
      `${root}/other/native/git`,
    );
    expect(git("linux", { ...env, PATH: `${root}/new` }, root)).toBe(`${root}/new/git`);
  });

  it("preserves Windows resolution in the shared runner", () => {
    const resolve = vi.fn();
    expect(makeInternalGitResolver(resolve)("win32", { Path: "C:\\Git\\bin" }, root)).toBe("git");
    expect(resolve).not.toHaveBeenCalled();
  });
});
