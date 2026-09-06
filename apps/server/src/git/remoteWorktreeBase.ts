import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { parseRemoteRefWithRemoteNames } from "./remoteRefs.ts";

/** Uses the same remote-prefix rules as tracking-ref resolution. */
export function selectRemoteWorktreeBase(input: {
  readonly baseBranch: string;
  readonly remoteNames: readonly string[];
}): string | null {
  const explicit = parseRemoteRefWithRemoteNames(
    input.baseBranch,
    input.remoteNames.toSorted((left, right) => right.length - left.length),
  );
  if (explicit) return explicit.remoteName;
  if (input.remoteNames.includes("gitea")) return "gitea";
  return input.remoteNames.includes("origin") ? "origin" : null;
}

/** Resolve the selected branch's tracking configuration before applying remote defaults. */
export const resolveRemoteWorktreeBase = Effect.fn("resolveRemoteWorktreeBase")(function* (
  git: Pick<GitVcsDriver.GitVcsDriver["Service"], "listRemoteNames" | "readConfigValue">,
  input: { readonly cwd: string; readonly baseBranch: string },
) {
  const remoteNames = yield* git.listRemoteNames(input.cwd);
  const explicit = parseRemoteRefWithRemoteNames(
    input.baseBranch,
    remoteNames.toSorted((left, right) => right.length - left.length),
  );
  if (explicit) return { remoteName: explicit.remoteName, refName: input.baseBranch };

  const trackingRemote = yield* git.readConfigValue(input.cwd, `branch.${input.baseBranch}.remote`);
  if (trackingRemote && trackingRemote !== ".") {
    const mergeRef = yield* git.readConfigValue(input.cwd, `branch.${input.baseBranch}.merge`);
    if (mergeRef?.startsWith("refs/heads/")) {
      if (!remoteNames.includes(trackingRemote)) return null;
      return {
        remoteName: trackingRemote,
        refName: `${trackingRemote}/${mergeRef.slice("refs/heads/".length)}`,
      };
    }
  }

  const remoteName = selectRemoteWorktreeBase({ baseBranch: input.baseBranch, remoteNames });
  return remoteName ? { remoteName, refName: input.baseBranch } : null;
});
