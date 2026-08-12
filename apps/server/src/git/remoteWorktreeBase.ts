/** Keeps the legacy wire flag remote-neutral while selecting its remote deterministically. */
export function selectRemoteWorktreeBase(input: {
  readonly baseBranch: string;
  readonly hasGitea: boolean;
  readonly hasOrigin: boolean;
}): "gitea" | "origin" | null {
  if (input.baseBranch.startsWith("gitea/")) return input.hasGitea ? "gitea" : null;
  if (input.baseBranch.startsWith("origin/")) return input.hasOrigin ? "origin" : null;
  if (input.hasGitea) return "gitea";
  return input.hasOrigin ? "origin" : null;
}
