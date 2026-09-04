# Fork Maintenance — StGit Runbook

This checkout is a maintained transformation over current upstream. The
ordered StGit series on `stgit/adopt` is the transformation; `main` is its
published rendering. Start with the repository-local
[`fork-patch-stack` skill](../../.agents/skills/fork-patch-stack/SKILL.md) and
the ordered [patch inventory](./fork-inventory.toml).

The canonical namespace is:

- local maintenance branch: `stgit/adopt`
- published code branch: `main`
- stack metadata: `refs/stacks/stgit/adopt`
- patch metadata: `refs/patches/stgit/adopt/*`

`stack.json.applied`, not a raw patch-ref glob, defines the canonical series.
Stack metadata is first-class state and must be published atomically with the
rendered code.

## Mental model

A fork patch has one coherent purpose and one retirement condition. Patch
count is not a health metric or a cap: an independent feature normally gets a
new patch. Conflict surface matters more. Additive files usually cost less to
carry than edits inside fast-moving upstream integration points. They can still
have add/add conflicts or silently break when upstream interfaces change.
Folding a resolution into its patch preserves that adaptation, but does not
prevent future conflicts. A curated Git rebase can follow the same discipline;
StGit makes patch identities and operations explicit.

Classify each concern in the inventory:

- `product`: durable fork behavior that is valuable even if upstream never
  adopts it.
- `divergence`: a deliberate operational or UX difference from upstream.
- `upstream-bound`: temporary behavior expected to retire when upstream ships
  an equivalent.

Every patch contains its implementation, tests, applicable documentation, and
its own inventory stanza. Shared-file overlap is normal; ownership follows
purpose, not path exclusivity. Dropping a feature patch must remove its whole
feature surface together.

Generated release stamps are not fork patches. A release tag points at a
stamped child while `main` remains at the unstamped stack tip.

## Tool and metadata preflight

Require StGit 2.6 or newer:

```bash
command -v stg
stg --version
export PATH="/usr/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
```

StGit's rebase implementation invokes `git reset --hard`, so system Git must
precede any destructive-command wrapper. On macOS install StGit through
Homebrew. On Linux use an upstream prebuilt package or a current source build;
do not assume an older distribution package is adequate.

For a fresh clone:

```bash
git fetch origin main
git switch --create stgit/adopt origin/main
git fetch origin \
  '+refs/stacks/stgit/adopt:refs/stacks/stgit/adopt' \
  '+refs/patches/stgit/adopt/*:refs/patches/stgit/adopt/*'
stg series --all --description
```

If the series is unexpectedly empty, stop and repair or fetch metadata. Never
run `stg init` merely because metadata was not fetched. Stop whenever stack
metadata does not describe `HEAD`.

## Baseline before a rebase

Baseline means “no worse than pure upstream,” not necessarily green. Run the
fork checks before rebasing. For every failure, reproduce the focused check at
the target upstream ref with no fork patches applied. A failure reproduced
there is upstream's baseline; a fork-only failure must be fixed before the
suite can be trusted as a rebase oracle.

Do not hide a runner's exit code behind an unguarded output pipe. Preserve the
status when capturing long output.

## Rebase and conflict repair

```bash
git fetch upstream --tags
saved_top="$(stg top)"
stg rebase --merged <upstream-ref>
```

A rebase repair never creates a new patch. Preserve patch names and count
unless a separate, intentional stack redesign is in progress.

At every failing patch:

1. Read its inventory entry, dependencies, retirement condition, and recorded
   decisions.
2. Inspect the upstream delta and search for behavior that moved rather than
   disappeared.
3. Choose `retire`, `narrow`, `relocate`, or `adapt`, in that order.
4. Resolve and stage explicit paths. Never use `git add -A`.
5. Run focused checks and `stg refresh` while that patch is current.
6. Continue the replay with `stg goto "$saved_top"`.

Relocation is distinct from accepting either conflict side: upstream may have
moved the integration point while the fork behavior remains necessary. Port
the smallest behavior into the new location instead of restoring a stale
file wholesale.

Review retirement on successful replays too: upstream can supersede a capability
without changing the same files. Conflicts are useful evidence because they
identify code both upstream and the fork are actively changing. Never resolve the text first and
ask whether the patch is still needed afterward.

## Bounded resolution loop

Use at most three measured rounds for a failing patch:

1. Make the smallest semantic repair and run the focused test.
2. If it still fails, compare with pure upstream and inspect the next adjacent
   contract or integration point.
3. If it still fails, reduce surface or reconsider the patch's purpose before
   broadening the edit.

After three rounds, stop and record the evidence. Do not accumulate speculative
changes across unrelated patches.

## Adding or changing fork functionality

First find the owning inventory concern. Existing-purpose work refreshes that
patch:

```bash
test -z "$(git status --porcelain)"
original_top="$(stg top)"
stg goto <owning-patch>
# edit and test
git add <explicit-paths>
stg refresh --index
stg goto "$original_top"
scripts/ci/check-stgit-stack
```

A genuinely independent purpose, or behavior that can reasonably be dropped
without dropping another feature, creates a new concern:

```bash
test -z "$(git status --porcelain)"
test -z "$(stg series --unapplied)" || stg push --all
stg new <patch-name> --message "<conventional subject>"
# add implementation, tests, applicable docs, and one inventory stanza
git add <explicit-paths>
stg refresh --index
scripts/ci/check-stgit-stack
```

File overlap is not a reason to combine concerns. Never append a plain repair
commit beside the stack.

### Isolated implementation and candidate deployment

Use `scripts/ci/prepare-stgit-agent-worktree` when an implementation agent
needs a disposable checkout. It clones current remote `main`, fetches the
canonical metadata namespace, validates stack context before mutation, checks
an optional claim-time main lease, and can create the requested empty new patch.
The agent still owns implementation, tests, applicable feature documentation,
and the inventory stanza in that patch.

When review produced a single ordinary candidate commit outside the stack, do
not hand-port it into the maintenance checkout. Generate a
`t3code.stgit-candidate/v1` manifest with
`scripts/ci/create-stgit-candidate-manifest`, review its exact base leases,
patch purpose, allowed paths, and verification argv, then run:

```bash
scripts/ci/deploy-stgit-concern --manifest <candidate.json> --check
scripts/ci/deploy-stgit-concern --manifest <candidate.json> --push
```

The helper creates a fresh isolated stack checkout; requires the candidate to
be one non-merge commit; rejects duplicate patch names, missing dependencies,
scope drift, inventory drift, and verification failures; applies the commit
with no commit; stages only declared paths plus the inventory; and refreshes
the new patch. It then requires the ordered name, subject, and object ID of
every pre-existing patch to remain identical. Publication receives the
claim-time main, stack, and full patch-ref set, so any intervening metadata
change loses safely before the atomic push. The isolated checkout is retained
for audit and recovery.

This path is for a genuinely new concern. Existing-purpose work still refreshes
its owning patch directly. Rebase repair still never creates a patch.

## Reducing maintenance cost

Use this surface-reduction ladder whenever a patch repeatedly conflicts:

1. retire behavior now covered upstream;
2. narrow the patch to the remaining fork-only behavior;
3. relocate fork code into additive modules and keep only a narrow registration
   point upstream;
4. adapt the smallest remaining in-place change;
5. propose the reusable behavior upstream.

Use this patch-retirement ladder:

1. conflict evidence showing equivalent upstream behavior;
2. inventory retirement conditions that can be checked mechanically;
3. focused behavior comparison against pure upstream;
4. removal in a disposable clone followed by focused and stack checks.

Do not retire a patch solely because upstream changed the same file. Prove the
purpose is covered.

## Validated stack context

Repository automation must obtain stack policy from the checked-out tree, not
parse the inventory through a separately versioned implementation:

```bash
scripts/ci/check-stgit-stack --format=json
```

The command emits `t3code.stgit-stack-context` contract version 1 only after
the ordinary stack and inventory checks pass. It includes the exact head and
base, ordered patch names, subjects and object IDs, singleton role owners, and
the repository-local instruction paths. Invalid state produces no partial
JSON. The contract version is independent of the TOML schema version; the
checker is the compatibility adapter when the inventory schema evolves.

## Publication

The only supported manual landing route for a changed stack is:

```bash
# In a fresh, fully fetched checkout, BEFORE editing or replay:
scripts/ci/prepare-stgit-publication
# After completing and verifying the changed stack:
scripts/ci/publish-stgit-stack --check
scripts/ci/publish-stgit-stack --push
```

Check mode is non-mutating. Push mode requires `stgit/adopt`, a clean tree, all
patches applied, and `stack.json.head == HEAD`. It requires the preparation-time main, stack and complete patch-ref leases,
compares them with remote state, and atomically publishes:

- `HEAD` to `refs/heads/main`;
- `refs/stacks/stgit/adopt`;
- `refs/stack-history/stgit/adopt/<timestamp>`: an immutable snapshot of the
  stack metadata commit created by every publication (same timestamp as the
  backup branch). `refs/stacks` is force-updated and its log does not survive
  re-inits in disposable clones, so this is the durable record for rollbacks
  and benchmark replays; delete only deliberately.
- `refs/stack-history/stgit/adopt/<timestamp>-previous`: the old metadata
  paired with the previous-main backup, even if the prior writer did not
  create a history snapshot;
- every patch ref named by `stack.json.applied`;
- leased deletions for remote patch refs absent from the applied list.

Any changed lease fails the whole transaction. Release automation adds the
tagged child to the same leased atomic transaction. Automated repair supplies
the claim-time main lease in `STGIT_EXPECTED_REMOTE_MAIN`, the prepared tag in
`STGIT_RELEASE_TAG` and `STGIT_RELEASE_TAG_SHA`, and
`STGIT_BACKUP_NAMESPACE=bot`. Manual publication uses the `manual` backup
namespace. The helper never refreshes a rejected lease or retries against
newly observed state, and it verifies every resulting remote object ID when a
push reports an ambiguous transport failure.

Candidate deployment supplies `STGIT_EXPECTED_REMOTE_STACK` and
`STGIT_EXPECTED_PATCH_REFS_JSON`. These bind publication to the complete
metadata state observed when the candidate was claimed, including obsolete
refs scheduled for deletion.

## Verification and maintenance review

Automatic replay runs `scripts/ci/verify-stgit-replay` before version stamping
or publication. The gate installs the frozen candidate, runs stack/docs checks,
lint, all workspace typechecks and tests, and rejects changes to the candidate.
A failure keeps remote main and the release tag unchanged. Do not add a blanket
package exemption for an upstream failure; compare the exact failing check at
pure upstream and repair or explicitly review a narrowly scoped exception.
Release builds validate the stamped child separately.

`prepare-stgit-publication` stores leases under the checkout's Git directory.
It is idempotent for the same initial state and refuses to renew a record for
new remote state. After publication or lease loss, use a fresh checkout. Explicit
`STGIT_EXPECTED_REMOTE_MAIN`, `STGIT_EXPECTED_REMOTE_STACK` and
`STGIT_EXPECTED_PATCH_REFS_JSON` remain supported for candidate deployment.
The external repair bot uses `prepare-stgit-publication --format=json` as its
stack-context command, capturing the lease before its own rebase begins while
receiving the same validated context contract.

At retirement reviews, measure repair duration, repeated conflicting files,
upstream lag and regressions after promotion alongside textual conflict count.
Use workflow logs and immutable stack snapshots as the evidence; do not create
a second status tracker. Record meaningful semantic decisions in the owning
inventory entry. A durable product requirement does not make its downstream
implementation permanent: retire it when upstream meets that requirement.

`depends_on` means a required capability or implementation, not merely a useful
ordering. When a temporary dependency retires, verify the dependent feature
against upstream's replacement and remove or narrow that dependency. Test feature
removal in a disposable clone before claiming independent removability. Mid-stack
buildability is not guaranteed, particularly for the generated lockfile.

## Recovery

- `stg undo --hard` aborts the last bad stack operation.
- `stg push --all` restores a stack that was merely left popped.
- `stg log` shows stack-operation history.
- `stg uncommit --number 1` absorbs an accidental plain commit.

Before a split, combination, rename, retirement, or reorder, record the base,
ordered names, patch object IDs, and rendered tree. Maintain an explicit
path/hunk staging ledger and verify the final tree. For an intentional feature
removal, verify implementation, tests, documentation, inventory stanza, and
obsolete publication ref disappear together.

The official [StGit tutorial](https://stacked-git.github.io/guides/tutorial/)
and [rebase manual](https://stacked-git.github.io/man/stg-rebase/) define the
commands used here.

### Recover a published stack

Use a fresh disposable clone with the current published stack and fetched
metadata. First run `scripts/ci/prepare-stgit-publication` so recovery is leased
against the publication being replaced. Select an exact history ref using
`git ls-remote origin 'refs/stack-history/stgit/adopt/*'`; the timestamp without
`-previous` identifies the new stack, and its `-previous` partner identifies
the stack before that publication. Inspect the chosen snapshot's head and
inventory before restoring anything. Preserve the current publisher outside
the checkout so rolling back code cannot roll back publication safeguards.

```bash
publisher_copy="$(mktemp)"
cp scripts/ci/publish-stgit-stack "$publisher_copy"
# Set restore_ref to the reviewed exact refs/stack-history/... ref.
git fetch origin "$restore_ref:refs/recovery/reviewed-stack"
git show refs/recovery/reviewed-stack:stack.json
# Only after reviewing that snapshot, restore the clean disposable checkout:
git update-ref refs/stacks/stgit/adopt refs/recovery/reviewed-stack
restore_head="$(git show refs/stacks/stgit/adopt:stack.json | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).head)')"
git reset --hard "$restore_head"
git for-each-ref --format='delete %(refname)' refs/patches/stgit/adopt/ | git update-ref --stdin
git show refs/stacks/stgit/adopt:stack.json | bun -e '
  const stack = JSON.parse(await Bun.stdin.text());
  for (const name of stack.applied)
    console.log(`update refs/patches/stgit/adopt/${name} ${stack.patches[name].oid}`);
' | git update-ref --stdin
scripts/ci/check-stgit-stack
# Verify the restored behavior before publication.
bash "$publisher_copy" --check
bash "$publisher_copy" --push
```

The current checkout's lease file stays under `.git` throughout recovery. The
publisher atomically restores main, stack and canonical patch refs, removes
obsolete remote patch refs, and creates a new recovery snapshot pair. Never
force-push just main. Source rollback does not roll back an installed app or a
migrated database; use the release runbook to publish a new monotonic version
when an application rollback is required.
