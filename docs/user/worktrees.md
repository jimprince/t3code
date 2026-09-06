# New worktrees from a remote branch

When **Use remote base branch** is enabled, creating a worktree first fetches the
selected remote and resolves the branch there. A remote-qualified selection such
as `upstream/main` uses `upstream`, even when the project also has an `origin` or
`gitea` remote. Custom remote names are supported.

For a branch without a remote prefix, T3 Code prefers `gitea`, then `origin`.
If neither exists, select a remote-qualified branch or disable the setting.
A failed fetch stops creation so the new worktree does not silently start from
an outdated local branch.
