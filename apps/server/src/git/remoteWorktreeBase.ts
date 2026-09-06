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
