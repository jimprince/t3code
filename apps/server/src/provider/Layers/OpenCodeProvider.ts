import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import type { ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { OpenCodeProvider } from "../Services/OpenCodeProvider";
import { OpenCodeServerPool } from "../Services/OpenCodeServerPool.ts";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "opencode" as const;
const AUTH_MESSAGE = "OpenCode runtime auth is managed inside OpenCode providers.";
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [];

function formatMissingMessage(binaryPath: string): string {
  return binaryPath === "opencode"
    ? "OpenCode CLI (`opencode`) is not installed or not on PATH."
    : `OpenCode CLI (\`${binaryPath}\`) is not installed or not executable.`;
}

function providerModelsFromCatalog(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  catalogModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const combined = [...builtInModels, ...catalogModels];
  const seen = new Set(combined.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, PROVIDER);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: null,
    });
  }

  return [...combined, ...customEntries];
}

const runOpenCodeCommand = (binaryPath: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = ChildProcess.make(binaryPath, [...args], {
      shell: process.platform === "win32",
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode };
  }).pipe(Effect.scoped);

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* () {
  const settings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((allSettings) => allSettings.providers.opencode),
  );
  const checkedAt = new Date().toISOString();

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: BUILT_IN_MODELS,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runOpenCodeCommand(settings.binaryPath, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: BUILT_IN_MODELS,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? formatMissingMessage(settings.binaryPath)
          : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: BUILT_IN_MODELS,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "OpenCode CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    const detail = detailFromResult(version);
    return buildServerProvider({
      provider: PROVIDER,
      enabled: true,
      checkedAt,
      models: BUILT_IN_MODELS,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `OpenCode CLI is installed but failed to run. ${detail}`
          : "OpenCode CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models: BUILT_IN_MODELS,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: { status: "unknown" },
      message: AUTH_MESSAGE,
    },
  });
});

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const pool = yield* OpenCodeServerPool;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = Effect.gen(function* () {
      const status = yield* checkOpenCodeProviderStatus().pipe(
        Effect.provideService(ServerSettingsService, serverSettings),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const opencodeSettings = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
      );

      if (!status.enabled || !status.installed) {
        return status;
      }

      const catalog = yield* pool
        .loadProviderCatalog({
          cwd: process.cwd(),
          binaryPath: opencodeSettings.binaryPath,
        })
        .pipe(Effect.result);

      if (Result.isFailure(catalog)) {
        return {
          ...status,
          status: "error",
          message:
            catalog.failure instanceof Error
              ? `OpenCode provider discovery failed. ${catalog.failure.message}`
              : "OpenCode provider discovery failed.",
          models: providerModelsFromCatalog(BUILT_IN_MODELS, [], opencodeSettings.customModels),
        } satisfies ServerProvider;
      }

      return {
        ...status,
        models: providerModelsFromCatalog(
          BUILT_IN_MODELS,
          catalog.success.models,
          opencodeSettings.customModels,
        ),
      } satisfies ServerProvider;
    });

    return yield* makeManagedServerProvider({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.opencode),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
