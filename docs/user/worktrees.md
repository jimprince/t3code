# New worktrees from a remote branch

When **Use remote base branch** is enabled, creating a worktree first fetches the
selected remote and resolves the branch there. A remote-qualified selection such
as `upstream/main` uses `upstream`, even when the project also has an `origin` or
`gitea` remote. Custom remote names are supported.

For a local branch, T3 Code uses its configured upstream remote and branch. A
branch tracking `origin/feature` starts from that GitHub branch even when a
`gitea` remote also exists; a branch tracking `gitea/feature` stays on Gitea.
Branches without a remote upstream prefer `gitea`, then `origin`. If neither
exists, select a remote-qualified branch or disable the setting.
A failed fetch stops creation so the new worktree does not silently start from
an outdated local branch.

The selected branch must exist on that remote. If the remote branch cannot be
resolved, the error names it. Select an existing remote branch or publish the
feature branch there first. T3 Code does not silently substitute a local branch
or another remote after a fetch or lookup fails.
