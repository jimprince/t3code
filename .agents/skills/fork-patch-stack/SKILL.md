---
name: fork-patch-stack
description: Maintain this fork as a concern-driven StGit patch stack. Use for upstream syncs and rebases, conflict resolution, adding a fork feature, modifying an existing feature, splitting, combining, renaming, retiring, or reordering patches, and publishing main with StGit metadata.
---

# Fork Patch Stack

Maintain `stgit/adopt` as the editable stack whose rendered tip is published to
`main`. Read the [maintenance runbook](../../../docs/operations/fork-maintenance.md)
and [ordered inventory](../../../docs/operations/fork-inventory.toml) before
changing the stack.

## Preflight

Require StGit 2.6 or newer and put system Git before the destructive-command
wrapper because `stg rebase` calls `git reset --hard` internally:

```bash
command -v stg
stg --version
export PATH="/usr/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
export HUSKY=0 VITE_GIT_HOOKS=0
```

On macOS, install StGit with Homebrew. On Linux, use an upstream prebuilt
package or a current source build; distribution packages may be obsolete.

`stg refresh` commits, so it runs the repo's `pre-commit` hook (`vp staged`).
Mid-stack the worktree is a partial tree, so that hook fails on unrelated files
and aborts the refresh with `index not clean`. Disable hooks for the whole
stack session with the two variables above, and run the real gates
(`pnpm typecheck`, `pnpm test`, `pnpm fmt:check`) at the stack tip instead,
where the tree is complete.

The canonical namespace is:

- Working branch: `stgit/adopt`
- Published branch: `main`
- Stack ref: `refs/stacks/stgit/adopt`
- Patch refs: `refs/patches/stgit/adopt/*`

For a fresh clone:

```bash
git fetch origin main
git switch --create stgit/adopt origin/main
git fetch origin \
  '+refs/stacks/stgit/adopt:refs/stacks/stgit/adopt' \
  '+refs/patches/stgit/adopt/*:refs/patches/stgit/adopt/*'
stg series --all --description
```

Stop if the series is unexpectedly empty. Fetch or repair metadata; never run
`stg init` merely because metadata was not fetched.

## Choose the owning concern

Read every inventory purpose, dependency, role, retirement condition, and
recorded decision relevant to the files being changed.

- Refresh an existing patch when the work serves its existing purpose.
- Create a new patch when the work has an independent purpose or could be
  dropped without dropping another feature. Patch count is not capped.
- Treat file overlap as normal. It is not a reason to combine concerns.
- Keep implementation, tests, applicable documentation, and the inventory
  stanza in the same patch.
- Never append a plain repair commit beside the stack.
- Keep generated release stamps in the tagged child only; never refresh them
  into a patch.

## Existing-concern workflow

```bash
test -z "$(git status --porcelain)"
original_top="$(stg top)"
stg goto <owning-patch>

# Edit, test, and update applicable docs/inventory.
git add <explicit-paths>
stg refresh --index

stg goto "$original_top"
scripts/ci/check-stgit-stack
```

Never use `git add -A`. Inspect the staged diff before every refresh.

## New-concern workflow

```bash
test -z "$(git status --porcelain)"
test -z "$(stg series --unapplied)" || stg push --all
stg new <patch-name> --message "<conventional subject>"

# Add implementation, tests, applicable docs, and the inventory stanza.
git add <explicit-paths>
stg refresh --index

scripts/ci/check-stgit-stack
```

Add exactly one ordered schema-v2 inventory entry in the new patch. Name and
subject must match StGit and the commit subject exactly.

### Isolated agent and reviewed-candidate workflow

When an agent should implement a new concern away from the maintenance
checkout, prepare its exact remote stack and empty owning patch with:

```bash
scripts/ci/prepare-stgit-agent-worktree \
  --output <disposable-directory> \
  --remote <origin-url> \
  --expected-main <claim-time-main-sha> \
  --patch-name <patch-name> \
  --patch-subject "<conventional subject>"
```

For an already reviewed single candidate commit, create a lease-bound manifest,
inspect it, then use the deployment helper:

```bash
scripts/ci/create-stgit-candidate-manifest \
  --candidate <commit> \
  --name <patch-name> \
  --subject "<conventional subject>" \
  --class <product|divergence|upstream-bound> \
  --purpose "<coherent purpose>" \
  --retire-when "<condition>" \
  --depends-on-json '["<earlier-patch>"]' \
  --verification-json '[["vp","test","run","<focused-test>"]]' \
  --output <candidate.json>

scripts/ci/deploy-stgit-concern --manifest <candidate.json> --check
scripts/ci/deploy-stgit-concern --manifest <candidate.json> --push
```

The manifest contains exact main and metadata leases, the candidate object,
the new patch identity, its allowed paths, and shell-free verification argv.
Deployment clones the claimed stack, rejects undeclared paths, applies the
candidate without creating a plain commit, writes the inventory stanza, stages
explicit paths, refreshes exactly one patch, proves every existing patch object
unchanged, and delegates publication to the atomic helper. Check mode is the
default and never publishes. A lease loss fails safely; create a new manifest
after reviewing the new remote state instead of refreshing leases implicitly.

## Rebase workflow

Run the fork baseline and compare failures with pure upstream before trusting
them. “Baseline” means no worse than upstream, not necessarily green.

```bash
git fetch upstream --tags
saved_top="$(stg top)"
stg rebase --merged <upstream-ref>
```

For each conflict:

1. Read the failing patch’s inventory entry and recorded decisions.
2. Inspect the upstream delta and search for relocated behavior.
3. Choose `retire`, `narrow`, `relocate`, or `adapt`, in that order.
4. Resolve and stage explicit files.
5. Run focused tests and `stg refresh` inside the failing patch.
6. Continue with `stg goto "$saved_top"`.

Never run `stg new` during a rebase. A rebase repair belongs in the failing
patch. Preserve patch names and count unless intentionally retiring, splitting,
or adding a concern outside the rebase-repair workflow.

Step 5 is best-effort mid-stack: patches are not individually standalone, so a
failing patch's own tests may not even import cleanly at its stack position.
Treat the stack tip as the real gate — after the last patch applies, run
`pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and
`pnpm fmt:check` there, then carry each fix back into its owning patch with
`stg goto <patch>` and `stg refresh`.

Generated files must be regenerated at the tip, not at their owning patch.
Regenerating `pnpm-lock.yaml` while only the first patches are applied silently
omits workspaces that later patches add (for example `apps/t3-thread`), and the
lockfile then fails `--frozen-lockfile` in CI. Regenerate at the tip, save the
file, then `stg goto fork-build-workspace-tooling`, copy it in, and refresh.

## Structural stack changes

For a split, combine, rename, retirement, or reorder:

1. Record the starting patch names, object IDs, stack base, and rendered tree.
2. Keep an explicit staging ledger outside the repository.
3. Stage by path and hunk; never sweep the worktree.
4. Move each patch’s inventory stanza with its implementation, tests, and docs.
5. Require the intended final tree and run `scripts/ci/check-stgit-stack`.
6. In a disposable clone, drop independently removable feature patches and
   verify their complete feature surface disappears together.

## Publish the stack

Use the repository helper as the only supported manual landing route:

```bash
scripts/ci/publish-stgit-stack --check
scripts/ci/publish-stgit-stack --push
```

Check mode is non-mutating. Push mode backs up remote `main`, then atomically
publishes `main`, the stack ref, every patch named by `stack.json.applied`, and
leased deletions for obsolete patch refs. Stop on any lease failure.

## Recovery

- Run `stg undo --hard` to abort the last bad stack operation.
- Run `stg push --all` when the stack was merely left popped.
- Run `stg log` to inspect operation history.
- Run `stg uncommit --number 1` to absorb an accidental plain commit.
- Stop and investigate whenever stack metadata does not describe `HEAD`.

The official [StGit tutorial](https://stacked-git.github.io/guides/tutorial/)
and [rebase manual](https://stacked-git.github.io/man/stg-rebase/) define command
behavior; the repository runbook defines this fork’s policy.
