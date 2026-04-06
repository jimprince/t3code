import type { RepositoryIdentity } from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";
import { runProcess } from "../../processRunner.ts";
import { detectGitHostingProviderFromRemoteUrl, normalizeGitRemoteUrl } from "@t3tools/shared/git";

import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const hostingProvider = detectGitHostingProviderFromRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const [owner, repositoryName] = repositoryPath.split("/");

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(hostingProvider ? { provider: hostingProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

async function resolveRepositoryIdentity(cwd: string): Promise<{
  readonly cacheKey: string;
  readonly identity: RepositoryIdentity | null;
}> {
  let topLevel = cwd;

  try {
    const topLevelResult = await runProcess("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
    });
    if (topLevelResult.code !== 0) {
      return { cacheKey: cwd, identity: null };
    }

    const candidate = topLevelResult.stdout.trim();
    if (candidate.length > 0) {
      topLevel = candidate;
    }
  } catch {
    return { cacheKey: cwd, identity: null };
  }

  try {
    const remoteResult = await runProcess("git", ["-C", topLevel, "remote", "-v"], {
      allowNonZeroExit: true,
    });
    if (remoteResult.code !== 0) {
      return { cacheKey: topLevel, identity: null };
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.stdout));
    return {
      cacheKey: topLevel,
      identity: remote ? buildRepositoryIdentity(remote) : null,
    };
  } catch {
    return { cacheKey: topLevel, identity: null };
  }
}

export const makeRepositoryIdentityResolver = Effect.gen(function* () {
  const cacheRef = yield* Ref.make(new Map<string, RepositoryIdentity | null>());

  const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    const cache = yield* Ref.get(cacheRef);
    const cached = cache.get(cwd);
    if (cached !== undefined) {
      return cached;
    }

    const resolved = yield* Effect.promise(() => resolveRepositoryIdentity(cwd));
    yield* Ref.update(cacheRef, (current) => {
      const next = new Map(current);
      next.set(cwd, resolved.identity);
      next.set(resolved.cacheKey, resolved.identity);
      return next;
    });
    return resolved.identity;
  });

  return {
    resolve,
  } satisfies RepositoryIdentityResolverShape;
});

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver,
);
