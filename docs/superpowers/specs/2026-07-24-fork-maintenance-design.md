# Fork Maintenance Strategy — Design

**Date:** 2026-07-24
**Scope:** `jimprince/t3code` only. Ice and OrcaSlicer are greenfield forks suited to a
merge-based model and get their own spec.
**Decision:** Keep the rebase model. Fix the patch stack (A) and shrink the fork
surface (C). Add patch retirement.

## 1. Measured baseline

All figures measured 2026-07-24 against merge-base `b511227b7ad421c422f1ebca65116776020e4799`.

| Metric                                                    | Value                                |
| --------------------------------------------------------- | ------------------------------------ |
| Fork commits replayed on every sync                       | 120                                  |
| Upstream commits since merge-base                         | 113 (~5 days)                        |
| Files the fork touches                                    | 274                                  |
| — net-new (structurally cannot conflict)                  | 129                                  |
| — modified in place (the conflict surface)                | 144                                  |
| Fork-modified files upstream also touched in those 5 days | 77                                   |
| Sync cadence                                              | every 3 hours, force-push to `main`  |
| Conflict handling                                         | fail loudly, hand off to human/agent |
| `rerere`                                                  | disabled; no `rr-cache`              |

### Composition of the 120 commits

| Category                                                                | Count | Assessment                                                                    |
| ----------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `fix(ci)` / `ci:` / `fix(release)` / `fix(mobile)` — repair scar tissue | 47    | Removable. Several share the message `fix(ci): repair Sync Upstream failure`. |
| `chore(release): prepare vX` — version stamps                           | 16    | Removable, and provably redundant (§2.2).                                     |
| `docs:`                                                                 | 10    | Carries value but compacts into one topic.                                    |
| Genuine features, fixes and tests                                       | 47    | Irreducible; needs isolation, not deletion.                                   |

63 of 120 commits (47 repair + 16 stamps) are pure process debris with no ongoing fork
value. Categories sum to 120.

### Where the fork changes live

| Area                                                      | Additive files | Modified files              |
| --------------------------------------------------------- | -------------- | --------------------------- |
| `apps/t3-thread`                                          | 67             | 0 — does not exist upstream |
| `apps/server`                                             | 24             | 67                          |
| `apps/web`                                                | 6              | 27                          |
| `apps/desktop`                                            | 0              | 10                          |
| `apps/mobile`                                             | 5              | 7                           |
| `packages/contracts`                                      | 0              | 6                           |
| `packages/client-runtime`                                 | 0              | 5                           |
| `.github/workflows`                                       | 4              | 4                           |
| `scripts`, `ops`, `oxlint-plugin-t3code`, `infra`, `docs` | ~23            | ~18                         |

### Conflict tax — fork-modified files ranked by upstream churn

Upstream commits touching the file in the last 6 months, against fork lines changed.
Small fork edits in hot upstream files are the worst ratio and the best removals.

| File                                                       | Upstream commits/6mo | Fork lines changed |
| ---------------------------------------------------------- | -------------------- | ------------------ |
| `apps/web/src/components/ChatView.tsx`                     | 108                  | 160                |
| `apps/server/src/server.test.ts`                           | 73                   | 189                |
| `apps/web/src/components/Sidebar.tsx`                      | 71                   | 605                |
| `apps/server/src/ws.ts`                                    | 66                   | 263                |
| `pnpm-lock.yaml`                                           | 55                   | 591                |
| `apps/server/src/server.ts`                                | 51                   | 19                 |
| `apps/web/src/components/chat/MessagesTimeline.tsx`        | 50                   | 29                 |
| `apps/web/src/components/chat/ChatComposer.tsx`            | 47                   | 7                  |
| `packages/contracts/src/ipc.ts`                            | 45                   | 14                 |
| `.github/workflows/release.yml`                            | 41                   | 1022               |
| `apps/web/package.json`                                    | 33                   | 2                  |
| `apps/server/package.json`                                 | 33                   | 2                  |
| `package.json`                                             | 31                   | 4                  |
| `apps/desktop/package.json`                                | 29                   | 2                  |
| `apps/web/src/components/settings/ConnectionsSettings.tsx` | 27                   | 5                  |
| `pnpm-workspace.yaml`                                      | 24                   | 1                  |
| `apps/web/src/components/BranchToolbarBranchSelector.tsx`  | 23                   | 10                 |

## 2. Root causes

### 2.1 The patch stack is an archive, not a payload

Rebase cost scales with (commit count x overlap). 63 of 120 commits carry no ongoing fork
value, and 47 of those are repairs of _previous_ rebases — so the repair mechanism is the
primary source of the problem it repairs. Nothing has ever compacted or retired a patch.

### 2.2 Generated artifacts are committed as patches

The 16 `chore(release): prepare` commits each rewrite the same four `package.json`
version fields plus `pnpm-lock.yaml`. They are redundant: `release.yml` line 153 states
_"Tag name is authoritative for both version and channel"_, and lines 266 and 440 re-run
`scripts/update-release-package-versions.ts` against the tag-derived version at build
time. The committed stamps are overwritten by the build that consumes them, yet they
conflict on the five most churn-prone files in the repo on every rebase.

`pnpm-lock.yaml` is likewise generated. Merging it is a category error; it must be
regenerated.

### 2.3 No conflict memory

`rerere` is disabled and CI checks out fresh, so every resolution is discarded and
re-derived every 3 hours. `scripts/ci/reproduce-sync-upstream` has grown a
hand-maintained bash ours/theirs table, which is `rerere` reimplemented without
persistence.

### 2.4 Deep in-place modification of upstream's hot path

67 fork-modified files in `apps/server` and 27 in `apps/web` sit exactly where upstream
is actively refactoring. This is real and partially irreducible — but the table in §1
shows a large share are tiny edits in very hot files, which is pure tax.

## 3. Requirements

Requirements are the authoritative statement of what this project must deliver.
Provenance is recorded so later agents do not mistake inference for instruction.

### 3.1 Functional requirements

| #   | Requirement                                                                                                                                                                         | Provenance         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| R1  | Fork customizations are maintained **automatically**, at low maintenance cost.                                                                                                      | stated             |
| R2  | Agents resolve sync conflicts **autonomously**; the current failure mode is agents unable to do so.                                                                                 | stated             |
| R3  | Fork patches are **retired** once upstream makes them unnecessary.                                                                                                                  | stated             |
| R4  | Retirement must detect upstream fixes that differ in **file, method, or scope** from the fork's fix.                                                                                | stated             |
| R5  | Retirement is **test-based**: a probe is written when the bug is found, re-run against each new upstream version, and a pass is **reviewed by an LLM** before the patch is dropped. | stated             |
| R6  | The work must fit the CI/CD pipeline, or adapt it deliberately.                                                                                                                     | stated             |
| R7  | Autonomous changes publish immediately; safety comes from **fast rollback**, not from gating.                                                                                       | decided            |
| R8  | Rollback must trigger **automatically**, not on Brad noticing (see §3.4).                                                                                                           | derived from R1+R7 |
| R9  | Upstreaming to `pingdotgg/t3code` happens **only if an agent runs it end to end**.                                                                                                  | decided            |

### 3.2 Constraints

| #   | Constraint                                                                       | Provenance             |
| --- | -------------------------------------------------------------------------------- | ---------------------- |
| C1  | The **rebase** model is retained. Merge-based forking is rejected.               | decided                |
| C2  | Strategy is compact-the-stack (A) plus shrink-the-surface (C).                   | decided                |
| C3  | History rewrite of `main` is acceptable.                                         | decided                |
| C4  | `rr-cache` persists on a self-hosted Linux runner on the desktop dev VM.         | decided                |
| C5  | **Private infrastructure preferred** over public.                                | stated                 |
| C6  | Scope is `jimprince/t3code` only. Ice and OrcaSlicer get a separate spec.        | decided                |
| C7  | Release artifact semantics, tag scheme and updater feed behaviour are unchanged. | inferred, unchallenged |

### 3.3 Acceptance criterion for "low maintenance"

**Brad is pulled into a sync roughly once per month.** Everything more frequent than that
is the automation's responsibility. This is the calibration for how far Phases 3–5 are
worth taking.

### 3.4 The autonomy/rollback interlock

R2 removes the human from the conflict loop. R7 chooses immediate publication with fast
rollback rather than gating. R1/§3.3 caps involvement at roughly monthly.

These are only consistent if **breakage detection and rollback are automated**. If Brad
is the detector, R7 silently reintroduces the human that R2 removed, at the worst
possible moment — after a bad build has already auto-updated his machine.

Current state, measured:

- **Headless:** `scripts/headless-auto-upgrade.sh` (lines 234–240) already rolls back to
  the previous release and health-checks it on failure. Largely solved.
- **Release gate:** `release.yml` line 451 runs `smoke:headless:artifact` before publish.
- **Desktop: no equivalent.** A bad mac build reaches the updater feed and auto-installs
  with no automated detection or rollback path.

Closing the desktop gap is therefore in scope and required, not optional (§9.1).
`scripts/resolve-previous-release-tag.ts` and `scripts/merge-update-manifests.ts` already
provide the last-known-good and feed-rewriting primitives needed to build it.

### 3.5 Non-goals

- Switching to a merge-based model (C1).
- Eliminating the fork surface entirely. `apps/t3-thread`, the Sidebar thread-move UI,
  the Grok provider, headless updates and fork branding are product and stay.
- Changing release artifact semantics, tag schemes, or updater feed behaviour (C7).
- Retiring product-class patches. Upstream will never implement fork features.

### 3.6 Delivery

All five phases are delivered as one project, in order. Phase 0 remains independently
shippable so value lands before the rewrite.

## 4. Phase 0 — Stop the bleeding

Workflow-only. No history rewrite. Independently shippable.

### 4.1 Drop the version-stamp commit

Keep the version-stamp commit off `main`, rather than removing the stamped release source.
Both `sync-upstream.yml` and `fork-push-nightly.yml` call
`scripts/ci/prepare-release-tag`, which records the rebased pre-stamp SHA, creates a
prepared child containing the version stamps and refreshed lockfile, and tags that child.
Before replay, bind the explicit lease to the exact checked-out starting HEAD and require
live `origin/main` to equal it; a stale queued checkout fails instead of renewing its
authority from the remote. Push `main` at the recorded parent with that lease, then push
the release tag only after the main push succeeds. `release.yml` consumes the tag and
never finalizes the stamp back onto `main`.

Removes 16 commits from the replay stack immediately and prevents ~2/day accruing.
The stamped child preserves correct tag-checkout/headless versions, while the build still
re-derives the version from the tag name (§2.2).

**Verification:** prove the release tag resolves to the prepared child, the remote main
ref resolves to its unstamped parent, a stale queued checkout is rejected before replay,
and an outdated exact lease rejects the main push before the tag is published. A release
built from that tag must report the tag version, and `nightly-mac.yml` must remain
byte-identical in shape to a pre-change release.

### 4.2 Regenerate the lockfile, never merge it

In `scripts/ci/reproduce-sync-upstream`, on `pnpm-lock.yaml` conflict: take the upstream
side, then regenerate with `vp install --lockfile-only`. Never attempt a textual merge.

### 4.3 Persistent rerere on a self-hosted Linux runner

Provision a self-hosted Linux runner on the desktop dev VM, labelled
`t3code-linux-sync`. Follow the `github-actions-local-runner` skill, which already covers
the `t3code-mac-arm64` runner.

Move the `sync` job to that runner. Set `rerere.enabled=true` and `rerere.autoupdate=true`,
with `rr-cache` on the runner's persistent disk outside the workspace
(`~/.t3code-fork-meta/rr-cache`, symlinked into `.git/rr-cache` at job start).

**Availability fallback:** reuse the online/busy probe pattern from `release.yml`
(lines 210–231). If `t3code-linux-sync` is offline or busy, fall back to
`ubuntu-24.04` without rerere — degraded (conflicts re-derived) but sync still functions.
A sync must never be blocked by the VM being down.

**Exit criteria for Phase 0:** replayed commits down from 120 to 104, with the five
highest-churn manifest/lockfile touch points removed from the replay entirely; a repeat
conflict resolved once is auto-resolved on the following sync.

## 5. Phase 1 — Compact the stack

One-time history rewrite of `main`. Force-push approved. Tags are unaffected (they point
at immutable commits).

### 5.1 Target topic commits

Built from `b511227` (the current merge-base), so compaction is isolated from syncing.
The next scheduled sync is then a normal rebase and the first real test.

_Additive — structurally cannot conflict, grouped freely:_

1. `fork: t3-thread operator CLI` — `apps/t3-thread/**` (67 files)
2. `fork: build and release tooling` — additive `scripts/**`, `ops/**`, `oxlint-plugin-t3code/**`
3. `fork: docs` — `docs/**`

_Modifying — grouped so a conflict lands in one coherent commit:_

4. `fork(server): orchestration and projection`
5. `fork(server): provider runtime (Codex, OpenCode, Grok)`
6. `fork(server): ws transport, auth, headless updates`
7. `fork(web): client resilience and thread-move UI`
8. `fork(desktop): branding, packaging flavor, update channels`
9. `fork(mobile): EAS configuration`
10. `fork(contracts): shared schema extensions`
11. `fork(ci): release and sync pipeline`

### 5.2 Method

Build each topic commit from the final tree state by path, rather than reordering 120
commits interactively:

```bash
git branch backup/pre-compact-20260724 main
git checkout -b main-compact b511227
# per topic:
git checkout main -- <topic path set>
git commit -m "fork(server): orchestration and projection"
```

### 5.3 Mandatory verification gates

Both must pass before force-push.

1. **Tree identity.** `git diff main main-compact` must produce empty output. The tree is
   identical by construction; this proves it.
2. **Path coverage.** The union of topic path sets must exactly equal the changed-file
   set — no file assigned twice, none dropped:

```bash
git diff --name-only b511227 main | sort > /tmp/all.txt
git diff --name-only b511227 main-compact | sort > /tmp/covered.txt
diff /tmp/all.txt /tmp/covered.txt   # must be empty
```

3. Full CI green on `main-compact` before it replaces `main`.

**Exit criteria:** 104 replayed commits to ~11, of which only ~8 are conflict-eligible
(topics 1–3 are additive or docs and cannot conflict with upstream).

## 6. Phase 2 — Keep it compact

Phase 1 decays without this. The stack reached 120 because nothing stopped it.

**Rule:** no new top-level fork commits on `main`. Every integration fix is committed as
`git commit --fixup=<topic-sha>`, and the sync driver runs `git rebase --autosquash`,
folding the fix into the topic commit it repairs. The fix is kept; the commit is not.

**Enforcement: CI, not documentation.** A check on `main` rejects any commit that is
neither a `fixup!` nor an authorised new topic commit (topic additions require an
explicit label or inventory entry). Documented-only policy is insufficient — 47 existing
commits are direct evidence that agents will not remember the convention unaided.

`LLM_INSTRUCTIONS.md` documents the rule and names the CI check that enforces it.

## 7. Phase 3 — Patch inventory and retirement

### 7.1 Patch classification

Every topic commit is classified in a patch inventory (`docs/fork/patch-inventory.md`).
The two classes have different retirement semantics:

| Class                                                                                                 | Examples                                                                                                  | Retirement                                                              |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Divergence** — bugfixes, workarounds, compat shims, flaky-test stabilizations, dependency overrides | flaky codex re-probe stabilization, vulnerable transitive dependency overrides, mobile pod/import patches | Probe required. These should die when upstream catches up.              |
| **Product** — fork features                                                                           | `t3-thread`, Sidebar thread-move UI, Grok provider, headless updates, fork branding                       | None. Upstream will never "fix" these. Isolate cleanly and leave alone. |

Only the divergence subset needs retirement machinery, which bounds the cost.

### 7.2 Inventory entry schema

```yaml
- id: fork-server-ws-reconnect
  topic: "fork(server): ws transport, auth, headless updates"
  class: divergence
  intent: "Client reconnects and resumes stream without losing events."
  probe: apps/server/probes/ws-reconnect.probe.test.ts # fork-owned, additive-only
  probe_targets: [apps/server/src/ws.ts] # lines the probe must execute
  verified_failing_at: <sha> # CORE_MANDATES §3.4 "verify catch"
  exit_criterion: "Upstream provides reconnect-with-resume on the ws transport."
  files: [apps/server/src/ws.ts]
```

**Probes are written when the bug is found, not lazily at retirement time.** This costs
nothing extra: `CORE_MANDATES` §3 already requires a regression test with every fix, and
§3.4 already requires breaking the fix to confirm the test fails. That "verify catch"
step is exactly the probe's precondition, so the probe is existing mandated work, tagged
and made addressable. Writing probes at retirement time instead means reconstructing
intent from a months-old patch with the least context anyone will ever have.

**Probes live in a fork-owned, additive-only location** (`apps/<app>/probes/`) that no
patch modifies. If a probe lived inside a file its patch touches, dropping the patch could
drop the probe, making "run the test without the patch" impossible. Cheap to establish up
front; painful to retrofit.

### 7.3 Three-tier retirement ladder

**Tier 1 — mechanical, free, narrow.**
Empty-patch detection: when a fork commit rebases to nothing, upstream has made a
byte-identical change. Surface it loudly instead of skipping silently. Plus convergence
tracking: record `git diff upstream/main...main -- <paths>` line count per topic each
sync; a shrinking diff means upstream is converging.

Tier 1 only catches identical convergence, which is the rare case. It is nearly free, so
it ships regardless, but it is not the primary mechanism.

**Tier 2 — behavioral probe. Definitive, and the answer to different-file /
different-method / different-scope convergence.**

A probe asserts the _behavior_ a patch provides, written with no reference to how it is
implemented. Retirement becomes mechanical:

```
drop the patch -> run its probe against upstream + the remaining stack
   probe passes -> upstream provides this behavior, by whatever means -> retire
   probe fails  -> still needed
```

Because the probe tests observable behavior rather than code shape, upstream fixing the
issue in a different file, by a different method, is detected correctly. Partial-scope
convergence is handled too: the probe fails so the patch is kept, while the Tier 1
convergence signal indicates the patch should be _narrowed_ rather than dropped.

This is the inverse of the regression-test rule in `CORE_MANDATES` §3: there you
reintroduce the bug to confirm the test fails; here you remove the fix and check whether
the test still passes.

**A passing probe is necessary but not sufficient.** A probe goes green for two very
different reasons:

1. Upstream genuinely fixed the behavior. Retire the patch. ✅
2. Upstream deleted, renamed or restructured the code path, so the probe no longer
   exercises anything and passes **vacuously**. Retiring here silently reintroduces the
   bug. ❌

Case 2 is not hypothetical: it is most likely exactly where the fork's hottest files are
(`ChatView.tsx` at 108 upstream commits, `ws.ts` at 66), so a naive "probe passed →
retire" rule fails precisely where it is needed most.

**Coverage gate (mechanical).** Run the probe with coverage and assert that
`probe_targets` were actually executed. A probe that passes without executing the
behavior under test is vacuous by definition, and that is detectable without judgement.

**Evaluation is per-patch against the full remaining stack.** Dropping patch A can change
whether patch B is still needed. Retire one at a time and re-run, rather than batch
dropping everything that went green in a single sync.

**Tier 3 — agent semantic review. Fuzzy, advisory only.**
A monthly job reads upstream release notes and diffs against each inventory entry's
`intent` and `exit_criterion`, and proposes retirement candidates. Monthly cadence keeps
it cheap. Tier 3 never retires anything on its own: a proposal must be confirmed by a
Tier 2 probe run before the patch is dropped.

### 7.4 The three gates (R5)

Each gate rules out a distinct failure mode. Any gate failing means **keep the patch**,
which is the safe default.

| Gate          | Question                                        | Evidence                                     | Rules out                           |
| ------------- | ----------------------------------------------- | -------------------------------------------- | ----------------------------------- |
| 1. Probe      | Does the behavior survive without the patch?    | Probe run against upstream + remaining stack | Patch still needed                  |
| 2. Coverage   | Is the probe actually exercising the behavior?  | Coverage over `probe_targets`                | Vacuous pass (§7.3 case 2)          |
| 3. LLM review | Does upstream cover the patch's **full** scope? | Fork patch diff vs upstream implementation   | Partial coverage, lost side effects |

Gate 3 is deliberately narrow and checkable rather than an open-ended "review this":

1. Is the probe still meaningfully exercising the behavior, or vacuous? (coverage output
   is the evidence)
2. Does upstream's implementation cover the **full scope** of the fork patch, or only the
   slice the probe happens to assert on?
3. Does the patch have side effects outside probe coverage that would be lost?

Verdicts: **`retire`**, **`narrow`** (upstream covers part — shrink the patch rather than
drop it), or **`keep`**.

### 7.5 Retirement action

A `retire` verdict drops the patch content from its topic commit (or deletes the topic
commit if fully retired), removes the inventory entry, and **keeps the probe** as a
standing regression test against upstream.

A `narrow` verdict rewrites the patch to the residual scope and updates the inventory
entry's `intent` and `exit_criterion`.

Both are `fixup!` commits under §6, so retirement does not grow the stack.

## 8. Phase 4 — Shrink the surface

Ongoing. Ranked by conflict tax from §1.

| Target                                   | Upstream commits/6mo | Fork lines | Action                   |
| ---------------------------------------- | -------------------- | ---------- | ------------------------ |
| `ChatComposer.tsx`                       | 47                   | 7          | Upstream PR              |
| `ConnectionsSettings.tsx`                | 27                   | 5          | Config                   |
| `BranchToolbarBranchSelector.tsx`        | 23                   | 10         | Upstream PR              |
| `contracts/src/ipc.ts`                   | 45                   | 14         | Additive contract module |
| `server/src/server.ts`                   | 51                   | 19         | Registration hook        |
| `MessagesTimeline.tsx`                   | 50                   | 29         | Upstream PR              |
| 4x `package.json`, `pnpm-workspace.yaml` | 24–33                | 1–4        | Eliminated in Phase 0    |

`Sidebar.tsx` (605 lines) and `ws.ts` (263 lines) are genuine fork product. They stay and
are isolated cleanly rather than reduced.

### 8.1 Upstreaming is agent-run end to end (R9)

Upstreaming permanently deletes a conflict source and is the highest-leverage item here,
but it must cost Brad nothing. An agent drafts, files and shepherds each PR, including
responding to review feedback.

Realistic limit: an agent cannot guarantee a maintainer's response. The protocol is
therefore non-blocking — file the PR, record `upstream_pr: #NNNN` on the inventory entry,
and **keep the patch local meanwhile**. If the PR stalls beyond 60 days or is rejected,
the entry is marked `upstream: declined` and the patch is treated as permanent fork
surface. Nothing waits on upstream, and no PR ever reaches Brad's queue.

When a filed PR merges, it becomes a Tier 1 retirement signal (the patch will usually
rebase empty), confirmed through the normal §7.4 gates.

### 8.2 Standing rule

A new fork change to an upstream file must first be attempted as, in order: (1) an
upstream PR, (2) an additive file plus a registration point, (3) config. In-place edit is
the last resort and requires a patch inventory entry with an exit criterion.

**Surface ratchet.** CI fails if the count of in-place-modified upstream files grows
without a corresponding inventory entry. This is what prevents §2.4 recurring.

## 9. Phase 5 — CI/CD adaptation

### 9.1 Automated detection and rollback (R7, R8) — required

R7 chooses immediate publication with fast rollback. R8 requires the rollback trigger to
be automatic, because §3.3 caps Brad's involvement at roughly monthly, so he cannot be
the detector. Without this, autonomous resolution (R2) ships breakage straight to the
machine that auto-updates from the nightly feed.

**Headless — already solved.** `scripts/headless-auto-upgrade.sh` (lines 234–240) rolls
back to the previous release and health-checks it on failure. Verify and keep.

**Desktop — the gap. Build it.** Post-publish verification for the mac lane:

1. After `release.yml` publishes, a verification job installs the published artifact and
   runs a launch/health smoke check.
2. On failure, resolve the last known good tag with the existing
   `scripts/resolve-previous-release-tag.ts`, and republish its manifest to the updater
   feed using the existing `scripts/merge-update-manifests.ts` — yanking the bad build
   from the feed.
3. Notify via the existing Discord release notifier
   (`scripts/notify-discord-release.ts`), so Brad learns about it without being the
   detection mechanism.

Both primitives already exist; this wires them into a post-publish path rather than
building new machinery.

**Rollback drill.** The rollback path is exercised on a deliberately broken build as part
of acceptance. An untested rollback is not a rollback.

### 9.2 Sync and resolution

- `sync` job runs on `t3code-linux-sync` (dev VM) with persistent `rr-cache`, falling
  back to `ubuntu-24.04` without rerere when unavailable (§4.3).
- On conflict, an agent resolution job attempts resolution using rerere, the ownership
  map in `scripts/ci/reproduce-sync-upstream`, and **the test suite as the oracle**.
  It escalates to a human only when tests fail after resolution — replacing today's
  unconditional fail-loudly handoff.
- Agent resolution commits are `fixup!` commits (§6), so successful autonomous repair
  does not grow the stack.
- Release behaviour, tag scheme and updater feeds are unchanged throughout.

## 10. Risks

| Risk                                                                     | Mitigation                                                                                                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 1 rewrite silently drops fork changes                              | Two mandatory gates: empty `git diff` against old `main`, and exact path-coverage diff. Backup branch retained.                                                                 |
| Dev VM offline blocks all syncs                                          | Explicit fallback to `ubuntu-24.04` without rerere; sync never hard-depends on the VM.                                                                                          |
| `fixup!` enforcement blocks legitimate new topics                        | New topic commits permitted via explicit label plus inventory entry.                                                                                                            |
| Agent auto-resolution lands a wrong-but-compiling resolution             | Test suite is the oracle; escalate on failure. Resolutions are `fixup!` commits, so they are reviewable within their topic.                                                     |
| Probe cost grows unbounded                                               | Probes only for divergence-class patches, written lazily on first flag.                                                                                                         |
| Tier 3 proposes a false retirement                                       | Tier 3 is advisory; Tier 2 probe confirmation is mandatory before any drop.                                                                                                     |
| **Vacuous probe pass** retires a patch and silently reintroduces the bug | Coverage gate (§7.3) asserts `probe_targets` executed; LLM gate 3 independently checks scope. Most likely in the hottest files, so treated as a primary risk, not an edge case. |
| Bad autonomous resolution auto-updates Brad's desktop before he notices  | Automated post-publish verification and feed rollback (§9.1). This is the direct cost of choosing R7 over gating.                                                               |
| Desktop rollback path is itself broken when first needed                 | Rollback drill against a deliberately broken build is an acceptance requirement (§9.1).                                                                                         |
| Upstream PR stalls and blocks surface reduction                          | Non-blocking protocol: patch stays local, 60-day timeout, marked `upstream: declined` (§8.1). Nothing waits on upstream.                                                        |
| Monthly-involvement target (§3.3) silently missed                        | Track human interventions per sync as a first-class metric (§11.9); it is the acceptance criterion for R1.                                                                      |

## 11. Success criteria

Each criterion traces to a requirement in §3.

| #   | Criterion                                                                                                                                                                       | Traces to  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Fork commits replayed per sync: 120 to ~11 (104 after Phase 0 alone).                                                                                                           | C2         |
| 2   | Conflict-eligible commits per sync: 120 to ~8.                                                                                                                                  | C2         |
| 3   | Zero `chore(release): prepare` commits on `main`; release artifact versions unchanged.                                                                                          | C2, C7     |
| 4   | A conflict resolved once is auto-resolved on the next sync without agent involvement.                                                                                           | R2, C4     |
| 5   | Stack size does not grow between syncs; integration fixes land as `fixup!`.                                                                                                     | R1         |
| 6   | Every divergence-class patch has an inventory entry, a probe, and an exit criterion.                                                                                            | R3, R5     |
| 7   | At least one patch retired through all three gates, proving the loop closes.                                                                                                    | R3, R4, R5 |
| 8   | A deliberately broken desktop build is detected and rolled off the updater feed **automatically**, with no human in the loop.                                                   | R7, R8     |
| 9   | **Human interventions per sync trend to zero, with a running rate of at most one per month.** This is the acceptance criterion for R1 and the measure the project is judged on. | R1, §3.3   |
| 10  | At least one upstream PR filed and shepherded by an agent with zero Brad involvement.                                                                                           | R9         |
