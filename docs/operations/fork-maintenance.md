# Fork Maintenance — Agent Playbook

How this fork stays close to `pingdotgg/t3code` without drowning in conflicts.

**Audience:** agents doing upstream syncs, resolving rebase conflicts, or running the
weekly fork-health review. Read this before touching the sync pipeline.

**Related:** `LLM_INSTRUCTIONS.md` (fork facts and release runbook) ·
`docs/superpowers/specs/2026-07-24-fork-maintenance-design.md` (why this exists) ·
`scripts/ci/reproduce-sync-upstream` (the rebase driver) ·
`scripts/ci/fork-topics.json` (the declared patch series)

---

## 1. Mental model

**This project maintains a set of patches that converts the most recent upstream into our
fork, with as few conflicts as possible.** It does not maintain a history. Read that
sentence again before making decisions here — most mistakes come from the other framing.

Consequences that follow directly, and that are easy to get wrong otherwise:

- **`main` is not an archive. It is the current rendering of the patch set on top of one
  specific upstream point.** Regenerating it with `scripts/ci/compact-stack` is a routine
  operation, not a dangerous rewrite. What must be preserved is the resulting _tree_, and
  the tree-identity gate proves exactly that. Git history of how a patch came to be has no
  value here; the patch does.
- **The unit of work is a patch, not a commit.** There is no such thing as "a commit
  outside a patch" — that is why integration fixes are `fixup!`s. Not a restriction, just
  the model.
- **Every patch owes an answer to "why does this exist, and what would make it
  unnecessary?"** A patch without a stated reason and an exit criterion is a defect, not
  merely undocumented. That is what the patch inventory is for.
- **The metric is conflict probability, not commit count.** Driving 135 commits to 11
  changed no conflicts at all. The numbers that matter are how many upstream files the
  patches touch (currently 17) and how many fork lines sit inside them. Optimise those.
- **A smaller patch is a better patch,** even when the larger one is tidier code. Fewer
  lines inside upstream files means fewer conflicts forever.

This is a well-trodden shape. Debian, OpenWrt and Yocto all maintain patch sets against
moving upstreams; `scripts/ci/fork-topics.json` is functionally Debian's
`debian/patches/series`, and `compact-stack` does what `gbp pq export` does. See §9.

Within that frame, the _sync_ itself is a **closed-loop control system**:

| Component   | Here                                                            |
| ----------- | --------------------------------------------------------------- |
| Disturbance | Upstream ships a release; sync rebases the fork onto it         |
| Measurement | The test suite tells you how far the fork drifted from healthy  |
| Controller  | An agent reads failures, applies fixes, re-measures until green |

The agent does not need to get the rebase right first try — it needs to **iterate**.
The loop only works if the measurement is trustworthy, which is why §2 exists.

Two quantities drive everything:

- **Replay cost** — how many commits get replayed each sync. Controlled by keeping the
  patch series small (§4).
- **Conflict surface** — how many upstream files the fork edits in place. Controlled by
  moving fork code out of upstream files (§6). _This is the one that actually reduces
  conflicts._

Compaction and surface reduction are independent. Measured on this fork: collapsing 135
commits into 11 left the conflicting-file set **completely unchanged** — the same 19
files. Do not expect stack hygiene to reduce conflicts; it reduces replay cost and makes
recorded conflict resolutions reusable.

---

## 2. Baseline gate (do this first, always)

**Before rebasing, confirm the fork's test results are no worse than upstream's.**

The gate is **"no worse than upstream", not "green".** Upstream ships red tests sometimes,
and when it does, an absolute-green gate blocks a sync on a failure the fork neither
caused nor can fix. Measured 2026-07-27: upstream's own commit `108e01746` ("Upgrade
Effect and Alchemy betas") broke `NodeSqliteClient.test.ts` and
`VcsStatusBroadcaster.test.ts` — both files carry **zero** fork lines, and both fail on
pure upstream with no patches applied.

So the procedure is:

1. Run the suite on the fork.
2. For every failure, check it against **pure upstream** with no patches applied:
   `git checkout <upstream-tag> && ./node_modules/.bin/vitest run <failing-test>`
3. A failure that reproduces on pure upstream is **upstream's**. Record it, do not attempt
   to fix it, and do not let it block the sync. Consider reporting it upstream.
4. A failure that does NOT reproduce on pure upstream is **ours**. Stop and fix it before
   rebasing — it cannot serve as an oracle otherwise.

Skipping step 2 leads to the trap this gate exists to prevent, in reverse: attributing an
upstream regression to a fork patch and "retiring" something that was never the cause.

If the fork's own results are already failing, the suite cannot serve as the oracle for
whether a conflict resolution was correct — you will "fix" the rebase until it reaches an
already-broken state and call it done.

```bash
pnpm exec vp run -r test
```

### Known-bad tests (not ours — do not chase)

Verified as of 2026-07-27. Re-verify per §2 step 2 rather than trusting this list
indefinitely; upstream fixes land and entries should be removed when they do.

| Test                                                   | Why it fails                                                                                               | Fork lines |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------: |
| `apps/mobile/.../nativeReviewDiffHighlighter.test.ts`  | Pre-existing flake under parallel load. Fails on unmodified `main`; count varies 1–2; passes in isolation. |          — |
| `apps/server/src/persistence/NodeSqliteClient.test.ts` | Upstream `108e01746` (Effect/Alchemy bump)                                                                 |      **0** |
| `apps/server/src/vcs/VcsStatusBroadcaster.test.ts`     | Upstream `108e01746` (Effect/Alchemy bump)                                                                 |      **0** |

For the flake specifically, re-run the package in isolation before attributing any failure
in it to your change.

Do not pipe the suite through `tail` or `head` and read the exit code — the pipe's exit
status masks the runner's. Capture the status explicitly:

```bash
pnpm exec vp run -r test > /tmp/suite.log 2>&1; echo "EXIT=$?"
```

A thin or flaky suite gives a weak error signal and the loop converges slowly or wrongly.
Improving test reliability is fork-maintenance work, not a distraction from it.

---

## 3. Invariants

Non-negotiable. Violating any of these is what produced the 120-commit stack this
playbook exists to prevent.

1. **Never append a top-level commit to `main`.** Integration fixes are
   `git commit --fixup=<topic-sha>`, folded by `rebase --autosquash`. Enforced by the
   `commit-discipline` CI job (`scripts/ci/check-commit-discipline`).
2. **Never commit generated artifacts to `main`.** Version stamps and `pnpm-lock.yaml`
   are produced by `scripts/ci/prepare-release-tag`, which tags them but pushes `main` at
   the pre-stamp SHA.
3. **Never textually merge `pnpm-lock.yaml`.** Take upstream's side, regenerate.
4. **`--ours` is upstream, `--theirs` is the fork commit** during a rebase. Getting this
   backwards silently discards fork work.
5. **A new fork change to an upstream file is a last resort.** Try, in order: upstream
   PR → additive file + registration point → config → in-place edit with an inventory
   entry and an exit criterion.
6. **Sync often.** Conflict difficulty scales with how much upstream changed since the
   last sync. Long gaps are the expensive failure mode.

---

## 4. Weekly fork-health review

Run this as a scheduled job. Each level is cheap and mechanical before it is expensive
and judgement-heavy — stop early if a level reports nothing.

Define once per run:

```bash
MB=$(git merge-base main upstream/main)
```

### Level 1 — Stack hygiene (cheap, mechanical)

```bash
git rev-list --count $MB..main                    # expect ~11
scripts/ci/check-commit-discipline                # expect PASS
git log --format='%s' $MB..main | grep '^fixup!'  # pending fixups
```

- Commit count materially above the topic count in `scripts/ci/fork-topics.json` means
  commits are accumulating — find them and fold them into their topic.
- Pending `fixup!` commits mean an autosquash was missed. Fold them.

### Level 2 — Surface trend (cheap, mechanical)

```bash
git diff --name-status $MB main | awk '$1=="M"' | wc -l   # in-place modified files
git diff --name-status $MB main | awk '$1=="A"' | wc -l   # additive (harmless)
```

The modified count is the conflict surface. It must trend **down**, never up. A rise
without a corresponding patch-inventory entry is a regression — CI's surface ratchet
should catch it, but verify here too.

### Level 3 — Retirement candidates (cheap → expensive; see §5)

Run the mechanical detectors first; only escalate to probes and LLM review for whatever
they surface.

### Level 4 — Extraction candidates (judgement)

For each file in the current conflict set, ask whether the fork's change could live
outside the upstream file at all (§6). Test files are the highest-yield case and are
almost always extractable.

To get the current conflict set without waiting for a real sync, replay against upstream
on a throwaway branch:

```bash
git checkout -B conflict-probe main
CI_REPAIR_BOT_UPSTREAM_TARGET=refs/tags/upstream/probe \
CI_REPAIR_BOT_UPSTREAM_SOURCE_REF=refs/heads/main \
CI_REPAIR_BOT_CONFLICT_MODE=output \
CI_REPAIR_BOT_GIT_BIN=/usr/bin/git \
scripts/ci/reproduce-sync-upstream
git rebase --abort 2>/dev/null; git checkout main
git branch -D conflict-probe; git tag -d upstream/probe
```

The driver's diagnostic mode replays the whole series and reports the full conflict
chain, so this is a complete picture rather than the first stop.

---

## 5. Retirement ladder

The point of a fork patch is to become unnecessary. Work down this ladder; each rung is
more expensive and more capable than the one above.

> **Not used: `git range-diff`.** It looks like the ideal detector — it compares patch
> content, so in principle it spots a patch upstream adopted even after reworking it. It
> does not work here and we do not run it. Measured 2026-07-27: across all 11 topics
> against 29 upstream commits it produced **zero matches**, because `range-diff` compares
> whole commits and our topics are coarse bundles of many unrelated changes, which will
> essentially never match a single upstream commit. In the same run a _conflict_ revealed
> a genuinely superseded fork change that `range-diff` missed entirely. Don't reach for
> it again unless the patch series is ever split to one-change-per-commit.

### Rung 1 — Conflicts (the primary signal)

Counter-intuitively the best detector, and free: you get it whether you want it or not.

Conflicts concentrate exactly where upstream is changing code your patch touches, which
is precisely where supersession happens. So on every conflict, ask in this order:

1. **Is the fork's side still needed at all?** — retire
2. Does upstream now cover part of it? — narrow
3. Only then: how do I reconcile them? — adapt

Measured 2026-07-27: resolving a conflict in `apps/server/src/git/GitManager.test.ts`
revealed that upstream's refactor had made the fork's duplicated `evaluateGoal` logic
redundant. No mechanical detector found it; the conflict did.

The failure mode this guards against is answering question 3 first, which silently
preserves patches that no longer need to exist and makes them conflict again next sync.

Set `merge.conflictstyle = diff3` so the common ancestor appears in conflict markers —
it makes upstream-adopted changes visible at a glance while resolving:

```bash
git config merge.conflictstyle diff3
```

### Rung 2 — Empty patch (mechanical, narrow)

When a fork commit rebases to nothing, upstream made a byte-identical change. Surface
this loudly rather than skipping it silently. Only catches exact convergence.

### Rung 3 — Convergence trend (mechanical, early warning)

Record per-topic `git diff upstream/main...main -- <paths>` line counts each sync. A
shrinking diff means upstream is converging on you — a candidate before it reaches empty.

### Rung 4 — Behavioral probe (definitive; handles different file/method/scope)

Rungs 1–3 only catch upstream doing roughly what you did. When upstream fixes the same
problem a different way, in a different file, at a different scope, only behaviour tells
you:

```
drop the patch -> run its probe against upstream + the remaining stack
   probe passes -> upstream provides this behavior somehow -> retirement candidate
   probe fails  -> still needed
```

Probes are written **when the bug is found**, not at retirement time —
`CORE_MANDATES` §3 already requires a regression test with every fix, and §3.4 already
requires breaking the fix to confirm the test fails. That is the probe's precondition.
Probes live in a fork-owned, additive-only location (`apps/<app>/probes/`) so that
dropping a patch cannot drop its own probe.

**A passing probe is necessary but not sufficient.** It can pass vacuously if upstream
deleted or restructured the code path, so the probe no longer exercises anything.
Guard mechanically: run with coverage and assert the probe's target lines actually
executed.

### Rung 5 — LLM scope review (judgement, mandatory before dropping)

Three questions, three possible verdicts:

1. Is the probe still meaningfully exercising the behaviour, or vacuous? (coverage is the
   evidence)
2. Does upstream cover the **full scope** of the fork patch, or only the slice the probe
   asserts on?
3. Does the patch have side effects outside probe coverage that would be lost?

Verdicts: **`retire`** · **`narrow`** (upstream covers part — shrink the patch) ·
**`keep`**.

Evaluate one patch at a time against the full remaining stack — dropping patch A can
change whether patch B is still needed.

### What never retires

Product patches. Upstream will not implement fork features. `apps/t3-thread`, the Sidebar
thread-move UI, the Grok provider, headless updates and fork branding stay. Classify them
in the inventory so no one wastes retirement effort on them.

---

## 6. Surface reduction ladder

Ranked by **conflict tax** — upstream churn on the file versus how much fork code is in
it. A small fork edit in a hot upstream file is the worst ratio and the best removal.

1. **Upstream PR.** Permanently deletes a conflict source. Agent-run end to end;
   non-blocking — file it, record `upstream_pr: #NNNN` in the inventory, keep the patch
   local meanwhile, mark `upstream: declined` after 60 days or rejection.
2. **Extract to an additive file.** Files the fork _adds_ have never conflicted. Move the
   fork's logic into a new file and touch the upstream file only at one small stable
   registration point, or not at all.
3. **Config.** Upstream ships the knob, the fork sets it.
4. **Ownership map.** For genuinely fork-owned files, add them to `FORK_RESOLVE_FILES` in
   `scripts/ci/reproduce-sync-upstream` so conflicts auto-resolve to the fork side. Only
   valid where the fork should always win — not a way to dodge real integration.

### Test files are the highest-yield extraction

Both sides append cases to the same test file, so it conflicts constantly. Move
fork-added cases into a sibling `<name>.fork.test.ts` in the same directory. Coverage is
identical, behaviour unchanged, and the original file converges to upstream's — leaving
the conflict surface entirely.

Only extract cases the fork **added**. A fork _modification_ to an upstream test cannot
be moved out; moving it silently drops the fork's change.

**Extraction is blocked when the test depends on a heavy shared fixture.** Measured
2026-07-27 on `apps/server/src/server.test.ts`: its single fork-added case depends on
`buildAppUnderTest`, a ~1200-line fixture the whole file shares. Duplicating it into the
sibling is disproportionate, and _importing_ it is unsafe — `it.layer`/`it.effect` register
tests as module-load side effects, so importing the original re-ran its entire 114-test
suite inside the sibling file. Confirmed empirically, not theorised.

When you hit this, leave the test in place and record why. The fix is to make the fixture
importable without registering tests (extract it to a `*.fixture.ts` module), which is a
separate, larger change — and a good upstream PR candidate, since upstream benefits too.

Verify extraction worked:

```bash
git diff $MB main -- <original-file>    # empty output == left the conflict surface
```

### Extraction only takes effect after compaction — do not be fooled

An extraction commit reverts the fork's edits at the **tip**, but the older fork commits
in history still modify that file. A commit-by-commit replay therefore still hits the old
conflict, and the conflict set looks unchanged. Measured on this fork: extracting two test
files left the conflict chain at 19 files on raw history, then dropped it to 17 once the
series was compacted — because compaction rebuilds topics from the _final tree_, where the
fork's edits to those files no longer exist.

**Consequences:**

- Always measure the conflict surface on the **compacted** series, never on raw history.
  Run `scripts/ci/compact-stack` into a throwaway branch first, then probe that.
- Follow extraction work with compaction (or a `fixup!` into the owning topic) before
  expecting any benefit.
- An agent that extracts a file, re-probes raw history, sees no change, and concludes
  "extraction doesn't work" has drawn the wrong conclusion. This is a known trap.

---

## 7. The sync loop (canonical)

This is the canonical loop. Run it for every sync, and as the weekly review at a slower
cadence. The steps are ordered deliberately — cheap checks that can _delete work_ come
before expensive work.

**0. Baseline gate** (§2). Tests green on the fork as it stands. If not, stop: without a
trustworthy oracle, step 5 cannot tell you anything.

**1. Dry-run the patch set against the newest upstream.** Non-mutating — find out whether
the patches still apply before changing anything. Use the driver's diagnostic mode (§4,
Level 4) to get the _full_ conflict chain rather than the first stop.

**2. Retire what upstream has already superseded.** Deleting a patch beats resolving it.
Run the cheap pre-checks now — empty-patch and convergence trend (§5 rungs 2–3) — plus any
inventory entry whose exit criterion has plainly been met.

Be aware this pre-check is **weak on its own**. With `range-diff` removed there is no
reliable detector that runs _before_ application, so expect most retirements to surface
during step 4, when a conflict points straight at code upstream has reworked. Treat step 2
as "catch the free ones" and step 4 as where retirement actually happens. Verdicts either
way are `retire`, `narrow`, or `keep`.

**3. Apply the remaining patches.** Render the surviving topics onto the new upstream.

**4. If conflicts remain, adjust the patches until there are none.**

This is the step that makes the whole model converge, and the easiest one to get wrong.
A conflict means the patch no longer fits the upstream it targets. **Fix the patch, not
the merge.** Never resolve a conflict into a new commit that sits beside the patch — that
is precisely how this fork previously grew 47 repair commits, each of which then
conflicted again on every subsequent sync, forever.

Before adjusting, understand what upstream actually did, so the patch is adapted to their
intent rather than to whichever side you happened to pick:

```bash
git diff <prev-upstream-tag>..<new-upstream-tag> -- <conflicting-path>
```

Then choose the response that fits the cause:

| Why it conflicted                                               | Response                                                         |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| Upstream restructured code the patch legitimately touches       | Adapt the patch to the new structure                             |
| The patch is broader than it needs to be                        | **Narrow it** — this reduces the surface permanently (§6)        |
| The fork's change could live outside the upstream file          | **Extract it** to an additive file — leaves the surface entirely |
| The file is genuinely fork-owned and the fork should always win | Add it to the ownership map (§6.4)                               |
| Upstream covers part of what the patch does                     | `narrow` per §5 rung 5                                           |

Adjustments land as `fixup!` commits against their topic and are folded by
`rebase --autosquash`, so the patch set stays at its declared size. After the sync
succeeds, re-render with `scripts/ci/compact-stack` so every adjustment is absorbed into
the patch it belongs to and nothing is left dangling.

Bound the loop: **three adjustment rounds**, then escalate. An agent iterating past that
is usually fighting a design decision rather than a conflict.

**5. Run the tests.** Area-specific first, then the full suite. Iterate until green.

**6. Record what was learned** — ownership-map entries, inventory changes, exit criteria,
or corrections to this playbook. A conflict that taught you something and wasn't written
down will be re-learned next sync.

### Why this converges

Each pass can only shrink the problem: patches get retired, narrowed, or extracted, and
adjustments are folded back into the patches themselves. Nothing accumulates beside the
patch set. That is the difference between this loop and the one that produced a
120-commit stack.

### Escalate to a human when

- The suite cannot be made green after the bounded rounds.
- A resolution requires choosing between two plausible product behaviours.
- Upstream changed something the fork depends on in a way that needs a design decision.
- **Resolving would require the conflict surface to grow** — that is a design smell, not a
  merge problem.
- A retirement is load-bearing and the probe evidence is ambiguous.

---

## 8. Cadence

Sync frequently — conflict difficulty scales with upstream drift since the last sync.
Continuous nightly tracking is the current policy; the alternative (deliberately lagging
a release or two so upstream changes settle) trades freshness for fewer, larger
integrations.

Run the §4 review weekly. Retirement rungs 1–3 are cheap enough to run every sync; rungs
4–5 belong in the weekly pass.

---

## 9. References

- [Being friendly: Strategies for friendly fork management — GitHub Blog](https://github.blog/developer-skills/github/friend-zone-strategies-friendly-fork-management/)
  — `diff3` conflict style, merging-rebase, sync cadence. (Its `range-diff` recipe was
  tried here and rejected — see §5.)
- [Automating fork maintenance with AI agents — Cohere](https://cohere.com/blog/automating-fork-maintenance-with-ai-agents)
  — the closed-loop framing, baseline verification, upstream-delta-aware conflict
  resolution, "a fork with a thin test suite gives a weak signal".
- [History-preserving fork maintenance with git](https://amboar.github.io/notes/2021/09/16/history-preserving-fork-maintenance-with-git.html)
  — `merge -s ours` to keep a patch stack on top without force-pushing.
- [How to fork: best practices](https://joaquimrocha.com/how-to-fork/) — atomic commits,
  frequent syncing.

### Patch-set prior art

The "maintain patches against a moving upstream" model is long-established. Worth reading
before inventing new machinery here:

- [Quilt for Debian Maintainers](https://perl-team.pages.debian.net/howto/quilt.html) —
  the `debian/patches/series` file is functionally `scripts/ci/fork-topics.json`: an
  ordered, named list of patches applied to pristine upstream.
- [`gbp pq`](https://manpages.ubuntu.com/manpages/xenial/man1/gbp-pq.1.html) — maintains
  the patch queue on a separate branch and _regenerates_ it, which is what
  `scripts/ci/compact-stack` does. Its `--topic` flag separates upstream-bound patches
  from downstream-only ones, the same split as our divergence/product classification.
- [StGit](https://stacked-git.github.io/guides/tutorial/) — a git-native patch stack you
  push and pop; the closest tool to what this fork hand-rolls.
- [TopGit](https://mackyle.github.io/topgit/overview.html) — patch queues with explicit
  dependencies between patches.

We deliberately hand-roll rather than adopt one of these, because the patch set must live
in a normal git branch that GitHub Actions builds and releases from. But when a question
arises that these tools already answer, take their answer.
