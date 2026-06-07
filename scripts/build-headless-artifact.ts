#!/usr/bin/env node

import { fromYaml } from "@t3tools/shared/schemaYaml";
import rootPackageJson from "../package.json" with { type: "json" };
import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { validateBundledClientAssets } from "./lib/client-assets.ts";
import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const HeadlessPlatform = Schema.Literals(["linux"]);
const HeadlessArch = Schema.Literals(["x64"]);
const encodeJsonString = Schema.encodeEffect(Schema.UnknownFromJsonString);
const HeadlessWorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type HeadlessWorkspaceConfig = typeof HeadlessWorkspaceConfig.Type;
const decodeHeadlessWorkspaceConfig = Schema.decodeEffect(fromYaml(HeadlessWorkspaceConfig));

interface BuildCliInput {
  readonly platform: Option.Option<typeof HeadlessPlatform.Type>;
  readonly arch: Option.Option<typeof HeadlessArch.Type>;
  readonly buildVersion: Option.Option<string>;
  readonly outputDir: Option.Option<string>;
  readonly skipBuild: Option.Option<boolean>;
  readonly keepStage: Option.Option<boolean>;
  readonly verbose: Option.Option<boolean>;
}

interface ResolvedBuildOptions {
  readonly platform: typeof HeadlessPlatform.Type;
  readonly arch: typeof HeadlessArch.Type;
  readonly version: string;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly keepStage: boolean;
  readonly verbose: boolean;
}

interface HeadlessPackageJson {
  readonly name: string;
  readonly version: string;
  readonly private: true;
  readonly description: string;
  readonly type: string;
  readonly engines: Record<string, string>;
  readonly packageManager: string;
  readonly dependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
}

class HeadlessBuildError extends Data.TaggedError("HeadlessBuildError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const RepoRoot = Effect.service(Path.Path).pipe(
  Effect.flatMap((path) => path.fromFileUrl(new URL("..", import.meta.url))),
);

export const readHeadlessWorkspaceConfig = Effect.fn("readHeadlessWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));
  return yield* decodeHeadlessWorkspaceConfig(workspaceYaml);
});

const commandOutputOptions = (verbose: boolean) =>
  ({
    stdout: verbose ? "inherit" : "ignore",
    stderr: "inherit",
  }) as const;

const runCommand = Effect.fn("runCommand")(function* (command: ChildProcess.Command) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* commandSpawner.spawn(command);
  const exitCode = yield* child.exitCode;

  if (exitCode !== 0) {
    return yield* new HeadlessBuildError({
      message: `Command exited with non-zero exit code (${exitCode})`,
    });
  }
});

const resolveOption = <A>(value: Option.Option<A>, defaultValue: A): A =>
  Option.getOrElse(value, () => defaultValue);

export function resolveHeadlessArtifactBaseName(
  version: string,
  platform: typeof HeadlessPlatform.Type,
  arch: typeof HeadlessArch.Type,
): string {
  return `t3-headless-${version}-${platform}-${arch}`;
}

export function resolveHeadlessArtifactName(
  version: string,
  platform: typeof HeadlessPlatform.Type,
  arch: typeof HeadlessArch.Type,
): string {
  return `${resolveHeadlessArtifactBaseName(version, platform, arch)}.tar.gz`;
}

export function resolveHeadlessRuntimeDependencies(
  workspaceConfig: HeadlessWorkspaceConfig,
): Record<string, string> {
  return resolveCatalogDependencies(
    serverPackageJson.dependencies,
    workspaceConfig.catalog ?? {},
    "apps/server",
  );
}

export function createHeadlessPackageJson(
  version: string,
  workspaceConfig: HeadlessWorkspaceConfig,
): HeadlessPackageJson {
  return {
    name: "t3-code-headless",
    version,
    private: true,
    description: "T3 Code headless server runtime",
    type: "module",
    engines: serverPackageJson.engines,
    packageManager: rootPackageJson.packageManager,
    dependencies: resolveHeadlessRuntimeDependencies(workspaceConfig),
    overrides: resolveCatalogDependencies(
      workspaceConfig.overrides ?? {},
      workspaceConfig.catalog ?? {},
      "apps/server",
    ),
  };
}

const resolveBuildOptions = Effect.fn("resolveBuildOptions")(function* (input: BuildCliInput) {
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;

  return {
    platform: resolveOption(input.platform, "linux"),
    arch: resolveOption(input.arch, "x64"),
    version: resolveOption(input.buildVersion, serverPackageJson.version),
    outputDir: path.resolve(repoRoot, resolveOption(input.outputDir, "release")),
    skipBuild: resolveOption(input.skipBuild, false),
    keepStage: resolveOption(input.keepStage, false),
    verbose: resolveOption(input.verbose, false),
  } satisfies ResolvedBuildOptions;
});

const writeEntrypoint = Effect.fn("writeEntrypoint")(function* (binDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entrypointPath = path.join(binDir, "t3");
  yield* fs.writeFileString(
    entrypointPath,
    [
      "#!/usr/bin/env sh",
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'exec node "$SCRIPT_DIR/../apps/server/dist/bin.mjs" "$@"',
      "",
    ].join("\n"),
  );
  yield* fs.chmod(entrypointPath, 0o755);
});

const buildHeadlessArtifact = Effect.fn("buildHeadlessArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const workspaceConfig = yield* readHeadlessWorkspaceConfig();
  const serverDist = path.join(repoRoot, "apps/server/dist");
  const bundledClientEntry = path.join(serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[headless-artifact] Building web and server artifacts...");
    yield* runCommand(
      ChildProcess.make({
        cwd: repoRoot,
        ...commandOutputOptions(options.verbose),
        shell: process.platform === "win32",
      })`vp run --filter @t3tools/web --filter t3 build`,
    );
  }

  for (const assetPath of [path.join(serverDist, "bin.mjs"), bundledClientEntry]) {
    if (!(yield* fs.exists(assetPath))) {
      return yield* new HeadlessBuildError({
        message: `Missing headless build asset: ${assetPath}. Run the build first.`,
      });
    }
  }

  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;
  const stageRoot = yield* mkdir({
    prefix: `t3code-headless-${options.platform}-${options.arch}-stage-`,
  });
  const artifactBaseName = resolveHeadlessArtifactBaseName(
    options.version,
    options.platform,
    options.arch,
  );
  const artifactName = resolveHeadlessArtifactName(options.version, options.platform, options.arch);
  const artifactRoot = path.join(stageRoot, artifactBaseName);
  const stageServerDir = path.join(artifactRoot, "apps/server");
  const stageBinDir = path.join(artifactRoot, "bin");

  yield* Effect.log("[headless-artifact] Staging server runtime...");
  yield* fs.makeDirectory(stageServerDir, { recursive: true });
  yield* fs.makeDirectory(stageBinDir, { recursive: true });
  yield* fs.copy(serverDist, path.join(stageServerDir, "dist"));
  yield* writeEntrypoint(stageBinDir);
  const packageJson = yield* Effect.try({
    try: () => createHeadlessPackageJson(options.version, workspaceConfig),
    catch: (cause) =>
      new HeadlessBuildError({
        message: "Could not resolve headless runtime package.json.",
        cause,
      }),
  });
  yield* fs.writeFileString(
    path.join(artifactRoot, "package.json"),
    `${yield* encodeJsonString(packageJson)}\n`,
  );

  yield* Effect.log("[headless-artifact] Installing staged production dependencies...");
  yield* runCommand(
    ChildProcess.make({
      cwd: artifactRoot,
      ...commandOutputOptions(options.verbose),
      shell: process.platform === "win32",
    })`vp install --prod --no-optional`,
  );

  for (const requiredPath of [
    path.join(artifactRoot, "bin/t3"),
    path.join(artifactRoot, "apps/server/dist/bin.mjs"),
    path.join(artifactRoot, "apps/server/dist/client/index.html"),
    path.join(artifactRoot, "node_modules/effect"),
    path.join(artifactRoot, "node_modules/node-pty"),
  ]) {
    if (!(yield* fs.exists(requiredPath))) {
      return yield* new HeadlessBuildError({
        message: `Missing staged runtime path: ${requiredPath}`,
      });
    }
  }

  yield* fs.makeDirectory(options.outputDir, { recursive: true });
  const artifactPath = path.join(options.outputDir, artifactName);
  yield* Effect.log(`[headless-artifact] Creating ${artifactPath}...`);
  yield* runCommand(
    ChildProcess.make("tar", ["-czf", artifactPath, "-C", stageRoot, artifactBaseName], {
      ...commandOutputOptions(options.verbose),
    }),
  );

  yield* Effect.log(`[headless-artifact] Done. Artifact: ${artifactPath}`);
});

const buildHeadlessArtifactCli = Command.make("build-headless-artifact", {
  platform: Flag.choice("platform", HeadlessPlatform.literals).pipe(
    Flag.withDescription("Build platform. Currently only linux is supported."),
    Flag.optional,
  ),
  arch: Flag.choice("arch", HeadlessArch.literals).pipe(
    Flag.withDescription("Build arch. Currently only x64 is supported."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription("Skip build and use existing apps/server/dist assets."),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files."),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a linux-x64 headless server artifact for T3 Code."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildHeadlessArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildHeadlessArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
