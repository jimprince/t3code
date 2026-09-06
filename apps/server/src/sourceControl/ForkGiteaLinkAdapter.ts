import type { RepositoryIdentity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ForgejoCli from "./ForgejoCli.ts";
import type * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

/** Configured endpoints refine aliases before native Forgejo discovery supplies its fallback. */
export const configuredGiteaIdentity = Effect.fn(function* (
  registry: SourceControlProviderRegistry.SourceControlProviderRegistry["Service"],
  identity: RepositoryIdentity,
) {
  if (!identity.rootPath) return null;
  const handle = yield* registry.resolveHandle({
    cwd: identity.rootPath,
    context: {
      provider: { kind: "unknown", name: "Unknown", baseUrl: "" },
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  if (handle.context?.provider.kind !== "gitea") return null;
  const remote = ForgejoCli.parseForgejoRemote(identity.locator.remoteUrl);
  if (!remote) return null;
  const web = new URL(handle.context.provider.baseUrl);
  return {
    ...identity,
    provider: "gitea" as const,
    canonicalKey: `${web.host}/${remote.path}`.toLowerCase(),
    displayName: remote.path,
    webUrl: `${web.origin}/${remote.path}`,
  };
});
