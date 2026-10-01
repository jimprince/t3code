import * as GiteaSourceControlProvider from "./GiteaSourceControlProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlProviderInfo, type GiteaInstanceConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  SourceControlProviderError,
  type SourceControlProviderDiscoveryItem,
} from "@t3tools/contracts";
import type { SourceControlProviderKind } from "@t3tools/contracts";
import { detectSourceControlProviderFromRemoteUrl } from "@t3tools/shared/sourceControl";

import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";
import * as BitbucketSourceControlProvider from "./BitbucketSourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
  type SourceControlProviderDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { ExecutableCacheGeneration } from "../processRunner.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";

const PROVIDER_DETECTION_CACHE_CAPACITY = 2_048;
const PROVIDER_DETECTION_CACHE_TTL = Duration.seconds(5);

type Refinement = Effect.Effect<SourceControlProvider.SourceControlProviderContext | null>;
const RefinementInput = Schema.fromJsonString(
  Schema.Struct({
    cwd: Schema.String,
    context: Schema.NullOr(
      Schema.Struct({
        provider: SourceControlProviderInfo,
        remoteName: Schema.String,
        remoteUrl: Schema.String,
        requestedHost: Schema.optionalKey(Schema.String),
      }),
    ),
    generation: Schema.String,
  }),
);
const encodeGeneration = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeRefinementInput = Schema.encodeSync(RefinementInput);
const decodeRefinementInput = Schema.decodeSync(RefinementInput);
/** A sweep retains each refinement until every link in that sweep has finished. */
export const ProviderRefinementScope = Context.Reference<Map<string, Refinement> | undefined>(
  "t3/ProviderRefinementScope",
  { defaultValue: () => undefined },
);

export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery: SourceControlProviderDiscoverySpec;
}

export interface SourceControlProviderHandle {
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly context: SourceControlProvider.SourceControlProviderContext | null;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  {
    readonly resolveLink: SourceControlProvider.ResolveSourceControlLink;
    readonly get: (
      kind: SourceControlProviderKind,
    ) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly resolveHandle: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<SourceControlProviderHandle, SourceControlProviderError>;
    readonly resolve: (input: {
      readonly cwd: string;
    }) => Effect.Effect<
      SourceControlProvider.SourceControlProvider["Service"],
      SourceControlProviderError
    >;
    readonly discover: Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>;
  }
>()("t3/sourceControl/SourceControlProviderRegistry") {}

function unsupportedProvider(
  kind: SourceControlProviderKind,
): SourceControlProvider.SourceControlProvider["Service"] {
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "listChangeRequests",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    getChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.headSelector),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getRepositoryCloneUrls: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getRepositoryCloneUrls",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    createRepository: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "createRepository",
        cwd: input.cwd,
        repository: SourceControlProvider.transportSafeSourceControlErrorValue(input.repository),
        detail: `No ${kind} source control provider is registered.`,
      }),
    getDefaultBranch: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "getDefaultBranch",
        cwd: input.cwd,
        detail: `No ${kind} source control provider is registered.`,
      }),
    checkoutChangeRequest: (input) =>
      new SourceControlProviderError({
        provider: kind,
        operation: "checkoutChangeRequest",
        cwd: input.cwd,
        reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
        detail: `No ${kind} source control provider is registered.`,
      }),
  });
}

function selectProviderContext(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly url: string;
  }>,
  instances: ReadonlyArray<GiteaInstanceConfig>,
): SourceControlProvider.SourceControlProviderContext | null {
  const candidates: Array<SourceControlProvider.SourceControlProviderContext> = [];
  for (const remote of remotes) {
    const provider = detectSourceControlProviderFromRemoteUrl(remote.url, instances);
    if (provider) {
      candidates.push({
        provider,
        remoteName: remote.name,
        remoteUrl: remote.url,
      });
    }
  }

  return (
    candidates.find((candidate) => candidate.remoteName === "origin") ??
    candidates.find((candidate) => candidate.provider.kind !== "unknown") ??
    candidates[0] ??
    null
  );
}

function bindProviderContext(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  context: SourceControlProvider.SourceControlProviderContext | null,
): SourceControlProvider.SourceControlProvider["Service"] {
  if (context === null) {
    return provider;
  }

  return SourceControlProvider.SourceControlProvider.of({
    kind: provider.kind,
    ...(provider.resolveLink ? { resolveLink: provider.resolveLink } : {}),
    listChangeRequests: (input) =>
      provider.listChangeRequests({
        ...input,
        context: input.context ?? context,
      }),
    getChangeRequest: (input) =>
      provider.getChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    createChangeRequest: (input) =>
      provider.createChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
    getRepositoryCloneUrls: (input) =>
      provider.getRepositoryCloneUrls({
        ...input,
        context: input.context ?? context,
      }),
    createRepository: (input) => provider.createRepository(input),
    getDefaultBranch: (input) =>
      provider.getDefaultBranch({
        ...input,
        context: input.context ?? context,
      }),
    checkoutChangeRequest: (input) =>
      provider.checkoutChangeRequest({
        ...input,
        context: input.context ?? context,
      }),
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const makeWithProviders = Effect.fn("makeSourceControlProviderRegistryWithProviders")(
  function* (registrations: ReadonlyArray<SourceControlProviderRegistration>) {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const getProviderSettings = settings.getSettings.pipe(
      Effect.mapError(
        () =>
          new SourceControlProviderError({
            provider: "gitea",
            operation: "settings",
            cwd: config.cwd,
            detail: "Could not read Gitea configuration.",
          }),
      ),
    );
    const getInstances = getProviderSettings.pipe(Effect.map((value) => value.giteaInstances));
    const process = yield* VcsProcess.VcsProcess;
    const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
    const providers = new Map<
      SourceControlProviderKind,
      SourceControlProvider.SourceControlProvider["Service"]
    >(registrations.map((registration) => [registration.kind, registration.provider]));
    const discoverySpecs = registrations.map((registration) => registration.discovery);

    const get: SourceControlProviderRegistry["Service"]["get"] = (kind) =>
      Effect.succeed(providers.get(kind) ?? unsupportedProvider(kind));

    const detectProviderContext = Effect.fn("SourceControlProviderRegistry.detectProviderContext")(
      function* (cwd: string) {
        const handle = yield* vcsRegistry.resolve({ cwd }).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const remotes = yield* handle.driver.listRemotes(cwd).pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: "unknown",
                operation: "detectProvider",
                cwd,
                detail: "Failed to detect source control provider.",
                cause: error,
              }),
          ),
        );
        const context = selectProviderContext(remotes.remotes, yield* getInstances);

        return yield* refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd,
          context,
        });
      },
    );

    const providerContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null,
      SourceControlProviderError
    >(detectProviderContext, {
      capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? PROVIDER_DETECTION_CACHE_TTL : Duration.zero),
    });

    const explicitContextCache = yield* Cache.makeWith<
      string,
      SourceControlProvider.SourceControlProviderContext | null
    >(
      (key) => {
        const input = decodeRefinementInput(key);
        return refineUnknownRemoteProvider({
          specs: discoverySpecs,
          process,
          cwd: input.cwd,
          context: input.context,
        }).pipe(Effect.provideService(ExecutableCacheGeneration, input.generation));
      },
      {
        capacity: PROVIDER_DETECTION_CACHE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit)
            ? exit.value?.provider.kind === "unknown"
              ? Duration.minutes(10)
              : Duration.seconds(5)
            : Duration.zero,
      },
    );

    const configuredContext = (
      context: SourceControlProvider.SourceControlProviderContext | null,
      instances: ReadonlyArray<GiteaInstanceConfig>,
    ) => {
      if (context === null) return null;
      const detected = detectSourceControlProviderFromRemoteUrl(context.remoteUrl, instances);
      return detected && (detected.kind === "gitea" || context.provider.kind === "gitea")
        ? { ...context, provider: detected }
        : context;
    };

    const resolveHandle: SourceControlProviderRegistry["Service"]["resolveHandle"] = Effect.fn(
      "SourceControlProviderRegistry.resolveHandle",
    )(function* (input) {
      const providerSettings = yield* getProviderSettings;
      const instances = providerSettings.giteaInstances;
      const environment = yield* HostProcessEnvironment;
      const generation = encodeGeneration([
        providerSettings,
        environment.PATH,
        environment.PATHEXT,
      ]);
      const explicitContext = configuredContext(input.context ?? null, instances);
      const refineExplicit = Effect.gen(function* () {
        const key = encodeRefinementInput({ cwd: input.cwd, context: explicitContext, generation });
        const scope = yield* ProviderRefinementScope;
        if (scope === undefined) return yield* Cache.get(explicitContextCache, key);
        let refinement = scope.get(key);
        if (refinement === undefined) {
          refinement = yield* Effect.cached(Cache.get(explicitContextCache, key));
          scope.set(key, refinement);
        }
        return yield* refinement;
      });
      const resolved =
        input.context === undefined
          ? yield* Cache.get(providerContextCache, input.cwd)
          : yield* refineExplicit;
      const context = configuredContext(resolved, instances);
      const kind = context?.provider.kind ?? "unknown";
      const provider = providers.get(kind) ?? unsupportedProvider(kind);
      return { provider: bindProviderContext(provider, context), context };
    });

    return SourceControlProviderRegistry.of({
      resolveLink: (input) => {
        if (input.url.protocol !== "https:" || input.url.username || input.url.password) {
          return undefined;
        }
        const kind = detectSourceControlProviderFromRemoteUrl(input.url.href)?.kind;
        return kind ? providers.get(kind)?.resolveLink?.(input) : undefined;
      },
      get,
      resolveHandle,
      resolve: (input) => resolveHandle(input).pipe(Effect.map((handle) => handle.provider)),
      discover: Effect.forEach(
        discoverySpecs,
        (spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        { concurrency: "unbounded" },
      ),
    });
  },
);

export const make = Effect.gen(function* () {
  const gitea = yield* GiteaSourceControlProvider.make;
  const github = yield* GitHubSourceControlProvider.make;
  const gitlab = yield* GitLabSourceControlProvider.make;
  const forgejo = yield* ForgejoSourceControlProvider.make;
  const forgejoDiscovery = yield* ForgejoSourceControlProvider.makeDiscovery;
  const bitbucket = yield* BitbucketSourceControlProvider.make;
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery;
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make;
  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
      discovery: GitHubSourceControlProvider.discovery,
    },
    {
      kind: "gitlab",
      provider: gitlab,
      discovery: GitLabSourceControlProvider.discovery,
    },
    {
      kind: "azure-devops",
      provider: azureDevOps,
      discovery: AzureDevOpsSourceControlProvider.discovery,
    },
    {
      kind: "bitbucket",
      provider: bitbucket,
      discovery: bitbucketDiscovery,
    },
    { kind: "forgejo", provider: forgejo, discovery: forgejoDiscovery },
    { kind: "gitea", ...gitea },
  ]);
});

export const layer = Layer.effect(SourceControlProviderRegistry, make);
