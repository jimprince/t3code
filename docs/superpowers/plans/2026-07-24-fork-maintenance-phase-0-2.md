# Fork Maintenance Phases 0–2 Implementation Plan

> **Historical design record.** It describes the pre-StGit
> `fork-topics.json`/autosquash implementation. For current operations, use
> [LLM_INSTRUCTIONS.md](../../../LLM_INSTRUCTIONS.md), the repository-local
> [`fork-patch-stack` skill](../../../.agents/skills/fork-patch-stack/SKILL.md),
> and the [fork maintenance runbook](../../operations/fork-maintenance.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the fork's replayed commit stack from 120 to ~11, give conflict resolution persistent memory, and make the stack structurally unable to regrow.

**Architecture:** Three sequenced changes to the upstream sync pipeline. Phase 0 stops generated release metadata from entering `main` (the prep commit is tagged but never pushed to `main`) and gives `rerere` a persistent home on a self-hosted runner. Phase 1 rebuilds `main` as ~11 curated topic commits built from the final tree state by path, gated on byte-identical tree verification. Phase 2 adds CI enforcement so integration fixes land as `fixup!` commits absorbed into their topic rather than accumulating beside it.

**Tech Stack:** Bash (sync driver, `scripts/ci/`), TypeScript + `@effect/vitest` (tests), GitHub Actions, Vite+ (`vp`) as package manager and test runner, `git rerere`, self-hosted GitHub Actions runner on the desktop dev VM.

**Spec:** `docs/superpowers/specs/2026-07-24-fork-maintenance-design.md`

## Global Constraints

- **Rebase model is retained** (spec C1). Never convert `main` to a merge-based fork.
- **Release artifact semantics, tag scheme, and updater feed behaviour are unchanged** (spec C7). Any change to published artifact names, tag formats, or feed contents is a plan failure.
- **`release.yml` installs with `--frozen-lockfile`** (lines 434, 436, 489, 656). The commit a release tag points at MUST carry a lockfile consistent with its manifests, or every release build fails.
- **Tag name is authoritative for version and channel** (`release.yml` line 153). `release.yml` re-stamps versions at build time (lines 266, 440). Committed version stamps on `main` are therefore redundant.
- **During a rebase, `--ours` is the upstream side and `--theirs` is the fork commit being replayed.** `scripts/ci/reproduce-sync-upstream` relies on this. Getting it backwards silently discards fork work.
- **Private infrastructure preferred** (spec C5). No new public services.
- **Test command:** `vp test run <path>` from repo root. Scripts workspace tests: `vp run --filter @t3tools/scripts test`.
- **Never force-push `main` outside Task 8**, and only after both verification gates pass.
- **Repo root for all commands:** the active worktree root (contains `pnpm-workspace.yaml`).

---

## File Structure

| File                                         | Responsibility                                                                                                                              | Task    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `scripts/ci/lib/git-fixture.ts`              | Create/destroy throwaway git repos for driver tests. Pure helper, no assertions.                                                            | 1       |
| `scripts/ci/git-fixture.test.ts`             | Proves the fixture helper itself works.                                                                                                     | 1       |
| `scripts/ci/prepare-release-tag`             | Creates the release-prep commit, tags it, reports the SHA `main` should be pushed at. Extracted from `sync-upstream.yml` so it is testable. | 2       |
| `scripts/ci/prepare-release-tag.test.ts`     | TDD + regression coverage for prep-commit isolation.                                                                                        | 2       |
| `.github/workflows/sync-upstream.yml`        | Calls the extracted script; pushes `main` at the pre-prep SHA.                                                                              | 3       |
| `scripts/sync-upstream-workflow.test.ts`     | Existing file. Extended with workflow-shape assertions.                                                                                     | 3, 5, 6 |
| `scripts/ci/reproduce-sync-upstream`         | Existing rebase driver. Gains rerere activation and lockfile policy.                                                                        | 4, 5    |
| `scripts/ci/compact-stack`                   | Builds the ~11 topic commits from the final tree by path.                                                                                   | 7       |
| `scripts/ci/compact-stack.test.ts`           | Verifies tree identity and path coverage gates.                                                                                             | 7       |
| `scripts/ci/fork-topics.json`                | Declarative topic → path-set mapping. Single source of truth for topics.                                                                    | 7       |
| `scripts/ci/check-commit-discipline`         | Rejects non-`fixup!` commits on `main`.                                                                                                     | 9       |
| `scripts/ci/check-commit-discipline.test.ts` | TDD for the discipline check.                                                                                                               | 9       |
| `.github/workflows/ci.yml`                   | Existing. Gains the commit-discipline job.                                                                                                  | 9       |
| `LLM_INSTRUCTIONS.md`                        | Existing. Documents the `fixup!` rule and names its enforcing check.                                                                        | 9       |

---

## Task 1: Git fixture harness

Driver logic is bash operating on real git state. Testing it requires real throwaway repos. Every later task depends on this.

**Files:**

- Create: `scripts/ci/lib/git-fixture.ts`
- Test: `scripts/ci/git-fixture.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `createFixtureRepo(): FixtureRepo` — makes a temp git repo with one initial commit on `main`.
  - `type FixtureRepo = { dir: string; git: (...args: string[]) => string; writeFile: (rel: string, contents: string) => void; commitAll: (message: string) => string; cleanup: () => void }`
  - `git()` returns trimmed stdout and throws on non-zero exit.
  - `commitAll()` returns the new commit SHA.

- [ ] **Step 1: Write the failing test**

Create `scripts/ci/git-fixture.test.ts`:

```typescript
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo } from "./lib/git-fixture.ts";

describe("git fixture", () => {
  it("creates a repo with one commit on main", () => {
    const repo = createFixtureRepo();
    try {
      assert.strictEqual(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
      assert.strictEqual(repo.git("rev-list", "--count", "HEAD"), "1");
    } finally {
      repo.cleanup();
    }
  });

  it("commitAll returns the sha of the new commit", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile("a.txt", "hello");
      const sha = repo.commitAll("feat: add a");
      assert.strictEqual(sha, repo.git("rev-parse", "HEAD"));
      assert.strictEqual(repo.git("rev-list", "--count", "HEAD"), "2");
    } finally {
      repo.cleanup();
    }
  });

  it("git() throws on a failing command", () => {
    const repo = createFixtureRepo();
    try {
      assert.throws(() => repo.git("rev-parse", "definitely-not-a-ref"));
    } finally {
      repo.cleanup();
    }
  });

  it("cleanup removes the directory", () => {
    const repo = createFixtureRepo();
    const dir = repo.dir;
    repo.cleanup();
    assert.isFalse(existsSync(dir));
  });
});
```

Add the import for `existsSync` at the top:

```typescript
import { existsSync } from "node:fs";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/ci/git-fixture.test.ts`
Expected: FAIL — cannot resolve `./lib/git-fixture.ts`.

- [ ] **Step 3: Write the implementation**

Create `scripts/ci/lib/git-fixture.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export type FixtureRepo = {
  readonly dir: string;
  readonly git: (...args: readonly string[]) => string;
  readonly writeFile: (rel: string, contents: string) => void;
  readonly commitAll: (message: string) => string;
  readonly cleanup: () => void;
};

/**
 * Creates a throwaway git repo with a single commit on `main`.
 *
 * Uses the system git binary directly, bypassing any interactive safety
 * wrappers on PATH — the same reason `reproduce-sync-upstream` honours
 * CI_REPAIR_BOT_GIT_BIN. Fixture repos are disposable by construction.
 */
export const createFixtureRepo = (): FixtureRepo => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-fixture-"));

  const git = (...args: readonly string[]): string =>
    NodeChildProcess.execFileSync("/usr/bin/git", [...args], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  const writeFile = (rel: string, contents: string): void => {
    const target = NodePath.join(dir, rel);
    NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
    NodeFS.writeFileSync(target, contents);
  };

  const commitAll = (message: string): string => {
    git("add", "-A");
    git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  writeFile("README.md", "fixture\n");
  commitAll("chore: init");

  return {
    dir,
    git,
    writeFile,
    commitAll,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/ci/git-fixture.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify the fixture catches a real failure**

Temporarily change `git("init", "-b", "main")` to `git("init", "-b", "master")`. Re-run. Expected: the first test FAILS with `expected 'master' to equal 'main'`. Revert the change.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/lib/git-fixture.ts scripts/ci/git-fixture.test.ts
git commit -m "test(ci): add git fixture harness for sync driver tests"
```

---

## Task 2: Extract `prepare-release-tag` with an off-`main` prep commit

**Files:**

- Create: `scripts/ci/prepare-release-tag`
- Test: `scripts/ci/prepare-release-tag.test.ts`

**Interfaces:**

- Consumes: `createFixtureRepo` from Task 1.
- Produces: executable `scripts/ci/prepare-release-tag`.
  - Required env: `RELEASE_TAG` (e.g. `v0.0.29-nightly.20260725.860-fork.1`).
  - Optional env: `SYNC_SKIP_INSTALL=1` (skip `vp install` / `vp fmt`, for tests), `SYNC_GIT_BIN` (git binary path).
  - Writes to `$GITHUB_OUTPUT` when set: `main_sha`, `prep_sha`, `tag`.
  - Consumed by Task 3.

**Why this shape:** `release.yml` needs a valid lockfile at the tagged commit (`--frozen-lockfile`), so the prep commit cannot simply be deleted. Instead it is created and tagged, but `main` is pushed at its _parent_ — so the tag carries the generated metadata and `main` never does.

- [ ] **Step 1: Write the failing test**

Create `scripts/ci/prepare-release-tag.test.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/prepare-release-tag");

const seedForkRepo = (repo: FixtureRepo): void => {
  repo.writeFile("apps/server/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("apps/desktop/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("apps/web/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("packages/contracts/package.json", '{\n  "version": "0.0.0"\n}\n');
  repo.writeFile("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  repo.commitAll("fork: seed manifests");
};

const runPrepare = (repo: FixtureRepo, tag: string): string => {
  const outputFile = NodePath.join(repo.dir, "gh-output");
  NodeChildProcess.execFileSync(script, [], {
    cwd: repo.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: tag,
      SYNC_SKIP_INSTALL: "1",
      GITHUB_OUTPUT: outputFile,
      SYNC_GIT_BIN: "/usr/bin/git",
    },
  });
  return NodeChildProcess.execFileSync("/bin/cat", [outputFile], { encoding: "utf8" });
};

const outputValue = (output: string, key: string): string => {
  const line = output.split("\n").find((entry) => entry.startsWith(`${key}=`));
  assert.isDefined(line, `expected ${key} in step output`);
  return line!.slice(key.length + 1);
};

describe("prepare-release-tag", () => {
  it("keeps the prep commit off main and points the tag at it", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);
      const headBefore = repo.git("rev-parse", "HEAD");

      const output = runPrepare(repo, "v1.2.3-fork.1");
      const mainSha = outputValue(output, "main_sha");
      const prepSha = outputValue(output, "prep_sha");

      assert.strictEqual(mainSha, headBefore, "main must stay at the rebased head");
      assert.notStrictEqual(prepSha, mainSha, "prep commit must be a new commit");
      assert.strictEqual(
        repo.git("rev-parse", `${prepSha}^`),
        mainSha,
        "prep commit must be a direct child of main",
      );
      assert.strictEqual(repo.git("rev-parse", "v1.2.3-fork.1^{commit}"), prepSha);
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: main accumulates zero release-prep commits across repeated syncs", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);

      for (const tag of ["v1.2.3-fork.1", "v1.2.4-fork.1", "v1.2.5-fork.1"]) {
        const output = runPrepare(repo, tag);
        const mainSha = outputValue(output, "main_sha");
        // Simulate the workflow pushing main at the pre-prep sha.
        repo.git("reset", "--hard", mainSha);
      }

      const log = repo.git("log", "--format=%s", "main");
      assert.notInclude(
        log,
        "chore(release): prepare",
        "REGRESSION: release-prep commits must never land on main",
      );
      assert.strictEqual(repo.git("rev-list", "--count", "main"), "2");
    } finally {
      repo.cleanup();
    }
  });

  it("stamps the release version into every manifest at the tagged commit", () => {
    const repo = createFixtureRepo();
    try {
      seedForkRepo(repo);
      const output = runPrepare(repo, "v1.2.3-fork.1");
      const prepSha = outputValue(output, "prep_sha");

      const manifest = repo.git("show", `${prepSha}:apps/server/package.json`);
      assert.include(manifest, '"version": "1.2.3-fork.1"');
    } finally {
      repo.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/ci/prepare-release-tag.test.ts`
Expected: FAIL — `ENOENT`, `scripts/ci/prepare-release-tag` does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/ci/prepare-release-tag`:

```bash
#!/usr/bin/env bash

set -euo pipefail

# Creates the release-preparation commit (version stamps + refreshed lockfile),
# tags it, and reports the SHA that `main` must be pushed at.
#
# The prep commit is deliberately NOT on main. `release.yml` derives the version
# from the tag name (line 153) and re-stamps at build time (lines 266, 440), so
# main carries no generated release metadata. Keeping it off main removes one
# replayed commit per sync from the rebase stack — historically 16 of them, each
# conflicting on the four manifests plus pnpm-lock.yaml.
#
# The commit still exists and is still tagged, because release.yml installs with
# --frozen-lockfile and needs a consistent lockfile at the tagged commit.
#
# Required env:
#   RELEASE_TAG          e.g. v0.0.29-nightly.20260725.860-fork.1
# Optional env:
#   SYNC_SKIP_INSTALL=1  skip vp install/fmt (tests)
#   SYNC_GIT_BIN         git binary path (bypass interactive wrappers)
#
# Outputs (appended to $GITHUB_OUTPUT when set):
#   main_sha  SHA to push to main
#   prep_sha  tagged commit
#   tag       the created tag

: "${RELEASE_TAG:?RELEASE_TAG is required}"

GIT_BIN="${SYNC_GIT_BIN:-$(command -v git)}"
if [[ ! -x "$GIT_BIN" ]]; then
  echo "git executable is unavailable: $GIT_BIN" >&2
  exit 2
fi

git_cmd() {
  "$GIT_BIN" "$@"
}

MANIFESTS=(
  apps/server/package.json
  apps/desktop/package.json
  apps/web/package.json
  packages/contracts/package.json
)

main_sha="$(git_cmd rev-parse HEAD)"
version="${RELEASE_TAG#v}"

if [[ "${SYNC_SKIP_INSTALL:-0}" != "1" ]]; then
  # A freshly rebased upstream may change manifests before the fork stamp, so
  # refresh the lockfile before the install that runs the stamping script.
  vp install --lockfile-only --ignore-scripts
  vp install --frozen-lockfile --ignore-scripts
fi

node scripts/update-release-package-versions.ts "$version"

if [[ "${SYNC_SKIP_INSTALL:-0}" != "1" ]]; then
  vp fmt "${MANIFESTS[@]}"
  vp install --lockfile-only --ignore-scripts
fi

if git_cmd diff --quiet -- "${MANIFESTS[@]}" pnpm-lock.yaml; then
  echo "Package versions already match $version; tagging main head."
  prep_sha="$main_sha"
else
  git_cmd add -- "${MANIFESTS[@]}" pnpm-lock.yaml
  git_cmd commit -m "chore(release): prepare $RELEASE_TAG"
  prep_sha="$(git_cmd rev-parse HEAD)"
fi

git_cmd tag -f "$RELEASE_TAG" "$prep_sha"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    echo "main_sha=$main_sha"
    echo "prep_sha=$prep_sha"
    echo "tag=$RELEASE_TAG"
  } >> "$GITHUB_OUTPUT"
fi

echo "main stays at $main_sha"
echo "tag $RELEASE_TAG -> $prep_sha"
```

Make it executable:

```bash
chmod +x scripts/ci/prepare-release-tag
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/ci/prepare-release-tag.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the regression test catches the bug it prevents**

In `prepare-release-tag`, temporarily change `main_sha="$(git_cmd rev-parse HEAD)"` to run _after_ the commit block instead of before (move the line to just above the `git_cmd tag -f` line). Re-run.
Expected: the REGRESSION test FAILS with `REGRESSION: release-prep commits must never land on main`.
Revert the change and confirm the test passes again.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/prepare-release-tag scripts/ci/prepare-release-tag.test.ts
git commit -m "feat(ci): keep release-prep commits off main"
```

---

## Task 3: Wire `prepare-release-tag` into the sync workflow

**Files:**

- Modify: `.github/workflows/sync-upstream.yml:207-266` (the "Push rebased main and release tag" step)
- Modify: `scripts/sync-upstream-workflow.test.ts`

**Interfaces:**

- Consumes: `scripts/ci/prepare-release-tag` from Task 2 (`main_sha`, `prep_sha`, `tag` outputs).
- Produces: a sync workflow that pushes `main` at `main_sha` and the tag at `prep_sha`.

- [ ] **Step 1: Write the failing test**

Append to the existing `it.layer` block in `scripts/sync-upstream-workflow.test.ts`, immediately after the existing `it.effect(...)` call:

```typescript
it.effect("pushes main at the pre-prep sha so release metadata stays off main", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const workflow = yield* fs.readFileString(
      path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
    );

    assert.include(workflow, "scripts/ci/prepare-release-tag");
    assert.include(workflow, "steps.prepare.outputs.main_sha");
    assert.notInclude(
      workflow,
      "git push origin HEAD:main",
      "REGRESSION: pushing HEAD to main would carry the release-prep commit",
    );
  }),
);

it.effect("no longer stamps release versions inline in the workflow", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const workflow = yield* fs.readFileString(
      path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
    );

    assert.notInclude(
      workflow,
      "node scripts/update-release-package-versions.ts",
      "version stamping belongs in scripts/ci/prepare-release-tag",
    );
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: FAIL — the workflow still contains `git push origin HEAD:main` and inline stamping.

- [ ] **Step 3: Replace the push step**

In `.github/workflows/sync-upstream.yml`, replace the entire `- name: Push rebased main and release tag` step (lines 207–266) with these two steps:

```yaml
- name: Prepare release tag
  if: steps.check.outputs.needed == 'true' && steps.rebase.outputs.status == 'clean'
  id: prepare
  env:
    CHANNEL: ${{ steps.channel.outputs.channel }}
    UPSTREAM_TAG: ${{ steps.upstream.outputs.tag }}
  run: |
    set -euo pipefail

    if [[ "$CHANNEL" == "nightly" ]]; then
      # Fork nightly tag: ${upstream_tag}-fork.<N>. N is the next integer
      # after the largest existing -fork.<N> for this upstream tag.
      # Semver note: "88-fork" is a single pre-release identifier (hyphens
      # are valid inside identifiers); because it's alphanumeric (not pure
      # digits), it sorts strictly higher than the numeric "88" — so the
      # fork version is always > the upstream nightly it's based on.
      mapfile -t existing < <(git tag --list "${UPSTREAM_TAG}-fork.*" \
        | awk -F '-fork\\.' 'NF==2 && $2 ~ /^[0-9]+$/ { print $2 }' \
        | sort -n)
      if [[ ${#existing[@]} -eq 0 ]]; then
        next_n=1
      else
        last="${existing[-1]}"
        next_n=$((last + 1))
      fi
      new_tag="${UPSTREAM_TAG}-fork.${next_n}"
    else
      new_tag="$UPSTREAM_TAG"
    fi

    RELEASE_TAG="$new_tag" scripts/ci/prepare-release-tag

- name: Push main and release tag
  if: steps.check.outputs.needed == 'true' && steps.rebase.outputs.status == 'clean'
  env:
    CHANNEL: ${{ steps.channel.outputs.channel }}
    GH_TOKEN: ${{ secrets.GH_PAT || github.token }}
    MAIN_SHA: ${{ steps.prepare.outputs.main_sha }}
    NEW_TAG: ${{ steps.prepare.outputs.tag }}
  run: |
    set -euo pipefail

    # main is pushed at the pre-prep sha. The release-prep commit is
    # reachable only from the tag, so main never accumulates generated
    # release metadata and the rebase stack stays flat.
    git push origin "${MAIN_SHA}:main" --force-with-lease

    if [[ "$CHANNEL" == "nightly" ]]; then
      git push origin "$NEW_TAG"
    else
      git push origin "$NEW_TAG" --force
    fi
    echo "Pushed $NEW_TAG (main at $MAIN_SHA) — release.yml will build and publish."

    # The persisted GH_PAT credential makes this tag push trigger
    # release.yml. Do not dispatch it again or the same tag builds twice.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the workflow is valid YAML**

Run:

```bash
node -e "const YAML=require('yaml');const fs=require('fs');YAML.parse(fs.readFileSync('.github/workflows/sync-upstream.yml','utf8'));console.log('valid')"
```

Expected: `valid`

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/sync-upstream.yml scripts/sync-upstream-workflow.test.ts
git commit -m "feat(ci): push main without release-prep commit"
```

---

## Task 4: Lockfile conflict policy in the rebase driver

**Files:**

- Modify: `scripts/ci/reproduce-sync-upstream:33-40` (the `UPSTREAM_RESOLVE_FILES` block)
- Modify: `scripts/sync-upstream-workflow.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: no interface change. Behaviour change only — documented lockfile policy.

**Context:** `pnpm-lock.yaml` is already in `UPSTREAM_RESOLVE_FILES`, so conflicts already take the upstream side via `git checkout --ours`. Task 2 regenerates it afterward in `prepare-release-tag`. This task makes that contract explicit and test-enforced so a future agent does not "fix" the lockfile by attempting a textual merge.

- [ ] **Step 1: Write the failing test**

Append to the `it.layer` block in `scripts/sync-upstream-workflow.test.ts`:

```typescript
it.effect("resolves the lockfile to upstream rather than merging it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const driver = yield* fs.readFileString(
      path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
    );

    const upstreamBlock = driver.slice(
      driver.indexOf("UPSTREAM_RESOLVE_FILES=("),
      driver.indexOf(")", driver.indexOf("UPSTREAM_RESOLVE_FILES=(")),
    );
    assert.include(
      upstreamBlock,
      "pnpm-lock.yaml",
      "REGRESSION: the lockfile is generated and must resolve to upstream, never merge",
    );
    assert.include(
      driver,
      "regenerated by scripts/ci/prepare-release-tag",
      "the lockfile policy must state where regeneration happens",
    );
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: FAIL — the explanatory string is absent.

- [ ] **Step 3: Document the policy in the driver**

In `scripts/ci/reproduce-sync-upstream`, replace the comment above `UPSTREAM_RESOLVE_FILES` (currently two lines starting `# Generated release metadata is rewritten...`) with:

```bash
# Generated release metadata is rewritten after a successful rebase, so the
# upstream version is authoritative while replaying fork commits.
#
# pnpm-lock.yaml is generated, not authored. Never attempt a textual merge of
# it: take the upstream side here, then let it be regenerated by
# scripts/ci/prepare-release-tag before tagging. release.yml installs with
# --frozen-lockfile, so the tagged commit must carry a consistent lockfile.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/ci/reproduce-sync-upstream scripts/sync-upstream-workflow.test.ts
git commit -m "docs(ci): pin lockfile conflict policy to regeneration"
```

---

## Task 5: Enable rerere in the rebase driver

**Files:**

- Modify: `scripts/ci/reproduce-sync-upstream` (after the `git_cmd` helper definition, before the first fetch)
- Modify: `scripts/sync-upstream-workflow.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: driver honours `SYNC_RERERE_CACHE` — an absolute path to a persistent `rr-cache` directory. When set, it is symlinked to `$(git rev-parse --git-path rr-cache)` and rerere is enabled. When unset, rerere stays off and the driver behaves exactly as before.
- Consumed by Task 6.

- [ ] **Step 1: Write the failing test**

Append to the `it.layer` block in `scripts/sync-upstream-workflow.test.ts`:

```typescript
it.effect("wires a persistent rerere cache when SYNC_RERERE_CACHE is set", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const driver = yield* fs.readFileString(
      path.join(repoRoot, "scripts/ci/reproduce-sync-upstream"),
    );

    assert.include(driver, "SYNC_RERERE_CACHE");
    assert.include(driver, "rerere.enabled");
    assert.include(driver, "rerere.autoupdate");
    assert.include(
      driver,
      "rr-cache",
      "the cache must be linked into the git dir to survive checkout",
    );
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: FAIL — `SYNC_RERERE_CACHE` is absent.

- [ ] **Step 3: Add rerere wiring to the driver**

In `scripts/ci/reproduce-sync-upstream`, insert immediately after the `START_HEAD="$(git_cmd rev-parse HEAD)"` line:

```bash
# Persistent conflict memory. Without this, every resolution is discarded when
# the ephemeral CI workspace is destroyed, and identical conflicts are
# re-derived from scratch on every sync. SYNC_RERERE_CACHE points at a
# directory on the self-hosted runner's disk that outlives the workspace.
if [[ -n "${SYNC_RERERE_CACHE:-}" ]]; then
  mkdir -p "$SYNC_RERERE_CACHE"
  rr_cache_path="$(git_cmd rev-parse --git-path rr-cache)"
  if [[ ! -e "$rr_cache_path" ]]; then
    ln -s "$SYNC_RERERE_CACHE" "$rr_cache_path"
  fi
  git_cmd config rerere.enabled true
  git_cmd config rerere.autoupdate true
  echo "rerere enabled with persistent cache at $SYNC_RERERE_CACHE"
else
  echo "rerere disabled (SYNC_RERERE_CACHE unset); conflicts will be re-derived"
fi
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify rerere actually replays a resolution**

This proves the mechanism end to end rather than just checking for strings.

```bash
cd "$(mktemp -d)"
G=/usr/bin/git
$G init -b main -q .
$G config user.email t@e.com && $G config user.name T
$G config rerere.enabled true && $G config rerere.autoupdate true
printf 'base\n' > f.txt && $G add . && $G commit -qm base
$G checkout -qb feature && printf 'fork\n' > f.txt && $G commit -qam fork
FEATURE_BEFORE=$($G rev-parse feature)
$G checkout -q main && printf 'upstream\n' > f.txt && $G commit -qam upstream
$G checkout -q feature
$G rebase main >/dev/null 2>&1 || true
printf 'resolved\n' > f.txt && $G add f.txt
GIT_EDITOR=true $G rebase --continue >/dev/null 2>&1
echo "--- resolution recorded; now replay the IDENTICAL conflict ---"
# Reset the branch to its pre-rebase state so the replayed conflict has the
# same base, same ours, and same theirs. rerere keys on the conflict preimage,
# so a merely *similar* conflict is a miss — it must be the same one.
$G checkout -q -B feature "$FEATURE_BEFORE"
$G rebase main 2>&1 | grep -q "using previous resolution" \
  && echo "RERERE HIT: resolution replayed" \
  || echo "NO RERERE HIT"
```

Expected: `RERERE HIT: resolution replayed`.

Two traps this transcript avoids, both of which produce a false pass:

1. **Grep on the wrong string.** `grep -i "Resolved"` matches git's generic advice line _"mark them as resolved with"_, which is printed on **every** conflict — so it reports success even with rerere completely disabled. Only `using previous resolution` is emitted exclusively on a real rerere hit.
2. **Replaying a different conflict.** Creating new commits (`upstream2`/`fork2`) yields a different preimage, so rerere correctly does _not_ fire, and the test would fail for a reason unrelated to the wiring being broken.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci/reproduce-sync-upstream scripts/sync-upstream-workflow.test.ts
git commit -m "feat(ci): give the rebase driver persistent conflict memory"
```

---

## Task 6: Route sync to the self-hosted runner with a fallback

**Files:**

- Modify: `.github/workflows/sync-upstream.yml` (add a `runner` job; change the `sync` job's `runs-on` and rebase step env)
- Modify: `scripts/sync-upstream-workflow.test.ts`

**Interfaces:**

- Consumes: `SYNC_RERERE_CACHE` from Task 5.
- Produces: `sync` runs on `t3code-linux-sync` when that runner is online and idle, else on `ubuntu-24.04` with rerere disabled.

**Prerequisite (manual, one-time):** register a self-hosted Linux runner on the desktop dev VM with labels `self-hosted,Linux,X64,t3code-linux-sync`, following the `github-actions-local-runner` skill. Create `~/.t3code-fork-meta/rr-cache` on that VM. The plan's automation does not provision the runner; the fallback ensures sync works before it exists.

- [ ] **Step 1: Write the failing test**

Append to the `it.layer` block in `scripts/sync-upstream-workflow.test.ts`:

```typescript
it.effect("prefers the self-hosted sync runner but falls back to GitHub-hosted", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
    const workflow = yield* fs.readFileString(
      path.join(repoRoot, ".github/workflows/sync-upstream.yml"),
    );

    assert.include(workflow, "t3code-linux-sync");
    assert.include(
      workflow,
      "ubuntu-24.04",
      "REGRESSION: sync must still run when the dev VM is offline",
    );
    assert.include(workflow, "SYNC_RERERE_CACHE");
  }),
);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: FAIL — `t3code-linux-sync` is absent.

- [ ] **Step 3: Add the runner-selection job**

In `.github/workflows/sync-upstream.yml`, insert this job immediately after the `jobs:` line and before `sync:`:

```yaml
runner:
  name: Select sync runner
  runs-on: ubuntu-24.04
  timeout-minutes: 5
  outputs:
    labels: ${{ steps.pick.outputs.labels }}
    rerere_cache: ${{ steps.pick.outputs.rerere_cache }}
  steps:
    # Mirrors the mac-runner probe in release.yml (lines 210-231). GitHub
    # Actions cannot migrate a job already queued on a self-hosted label, so
    # the choice must happen before the sync job is created.
    - name: Pick runner
      id: pick
      env:
        GH_TOKEN: ${{ secrets.GH_PAT || github.token }}
      run: |
        set -euo pipefail
        hosted='["ubuntu-24.04"]'
        self_hosted='["self-hosted","Linux","X64","t3code-linux-sync"]'

        if runner_name=$(gh api "repos/${GITHUB_REPOSITORY}/actions/runners" \
          --jq '.runners[] | select(.status == "online" and .busy == false and ([.labels[].name] | index("t3code-linux-sync"))) | .name' \
          2>/dev/null | head -n1) && [[ -n "$runner_name" ]]; then
          echo "Using self-hosted sync runner: $runner_name (rerere enabled)."
          echo "labels=$self_hosted" >> "$GITHUB_OUTPUT"
          echo "rerere_cache=$HOME/.t3code-fork-meta/rr-cache" >> "$GITHUB_OUTPUT"
        else
          echo "Self-hosted sync runner offline or busy; using GitHub-hosted (rerere disabled)."
          echo "labels=$hosted" >> "$GITHUB_OUTPUT"
          echo "rerere_cache=" >> "$GITHUB_OUTPUT"
        fi
```

- [ ] **Step 4: Point the sync job at the selected runner**

In the `sync` job, change:

```yaml
runs-on: ubuntu-24.04
```

to:

```yaml
needs: runner
runs-on: ${{ fromJSON(needs.runner.outputs.labels) }}
```

Then in the `- name: Rebase fork commits onto upstream tag` step, add one line to its existing `env:` block:

```yaml
SYNC_RERERE_CACHE: ${{ needs.runner.outputs.rerere_cache }}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `vp test run scripts/sync-upstream-workflow.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the workflow is valid YAML**

Run:

```bash
node -e "const YAML=require('yaml');const fs=require('fs');const w=YAML.parse(fs.readFileSync('.github/workflows/sync-upstream.yml','utf8'));console.log(Object.keys(w.jobs).join(','))"
```

Expected: `runner,sync`

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/sync-upstream.yml scripts/sync-upstream-workflow.test.ts
git commit -m "feat(ci): run sync on the dev VM runner with hosted fallback"
```

---

## Task 7: Compaction tooling with both verification gates

**Files:**

- Create: `scripts/ci/fork-topics.json`
- Create: `scripts/ci/compact-stack`
- Test: `scripts/ci/compact-stack.test.ts`

**Interfaces:**

- Consumes: `createFixtureRepo` from Task 1.
- Produces: executable `scripts/ci/compact-stack`.
  - Required env: `COMPACT_BASE` (merge-base SHA), `COMPACT_SOURCE` (branch holding current fork work), `COMPACT_TARGET` (branch name to create).
  - Optional env: `SYNC_GIT_BIN`, `COMPACT_TOPICS` (path to topics JSON; defaults to `scripts/ci/fork-topics.json`).
  - Exits non-zero if either gate fails.

**The two gates (spec §5.3):**

1. **Tree identity** — `git diff <source> <target>` must be empty.
2. **Path coverage** — the changed-file set of source and target must be identical, so no file is dropped or double-assigned.

- [ ] **Step 1: Write the failing test**

Create `scripts/ci/compact-stack.test.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/compact-stack");

const runCompact = (
  repo: FixtureRepo,
  topicsPath: string,
  base: string,
): { readonly status: number; readonly output: string } => {
  try {
    const output = NodeChildProcess.execFileSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        COMPACT_BASE: base,
        COMPACT_SOURCE: "main",
        COMPACT_TARGET: "main-compact",
        COMPACT_TOPICS: topicsPath,
        SYNC_GIT_BIN: "/usr/bin/git",
      },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

/** Seeds a repo with a base commit plus several noisy fork commits. */
const seedForkStack = (repo: FixtureRepo): string => {
  repo.writeFile("src/app.ts", "export const app = 1;\n");
  const base = repo.commitAll("upstream: base");

  repo.writeFile("src/app.ts", "export const app = 2;\n");
  repo.commitAll("feat: change app");
  repo.writeFile("tools/cli.ts", "export const cli = true;\n");
  repo.commitAll("feat: add cli");
  repo.writeFile("tools/cli.ts", "export const cli = false;\n");
  repo.commitAll("fix(ci): repair Sync Upstream failure");
  repo.writeFile("docs/guide.md", "# guide\n");
  repo.commitAll("docs: add guide");

  return base;
};

describe("compact-stack", () => {
  it("collapses many commits into the declared topics with an identical tree", () => {
    const repo = createFixtureRepo();
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork: docs", paths: ["docs/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const result = runCompact(repo, topics, base);
      assert.strictEqual(result.status, 0, result.output);

      assert.strictEqual(
        repo.git("diff", "main", "main-compact"),
        "",
        "tree identity gate: compacted branch must be byte-identical",
      );
      assert.strictEqual(repo.git("rev-list", "--count", `${base}..main-compact`), "3");
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: fails when a changed path is not covered by any topic", () => {
    const repo = createFixtureRepo();
    try {
      const base = seedForkStack(repo);
      const topics = NodePath.join(repo.dir, "topics.json");
      // docs/ deliberately omitted.
      repo.writeFile(
        "topics.json",
        JSON.stringify([
          { message: "fork: tooling", paths: ["tools/"] },
          { message: "fork(app): behaviour", paths: ["src/"] },
        ]),
      );

      const result = runCompact(repo, topics, base);
      assert.notStrictEqual(result.status, 0, "must fail when coverage is incomplete");
      assert.include(result.output, "docs/guide.md");
      assert.include(result.output, "not covered by any topic");
    } finally {
      repo.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/ci/compact-stack.test.ts`
Expected: FAIL — `ENOENT`, `scripts/ci/compact-stack` does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/ci/compact-stack`:

```bash
#!/usr/bin/env bash

set -euo pipefail

# Rebuilds the fork's patch stack as a small set of curated topic commits.
#
# Topic commits are built from the FINAL tree state by path, not by reordering
# history. That makes the resulting tree identical by construction, which the
# tree-identity gate then proves. Reordering 120 commits interactively is both
# error-prone and unnecessary.
#
# Required env:
#   COMPACT_BASE    merge-base sha to build on top of
#   COMPACT_SOURCE  branch holding the current fork work
#   COMPACT_TARGET  branch to create
# Optional env:
#   COMPACT_TOPICS  path to topics JSON (default scripts/ci/fork-topics.json)
#   SYNC_GIT_BIN    git binary path
#
# Topics JSON: [{ "message": "fork: tooling", "paths": ["tools/", "a/b.ts"] }]
# A path ending in "/" matches by prefix; otherwise it matches exactly.

: "${COMPACT_BASE:?COMPACT_BASE is required}"
: "${COMPACT_SOURCE:?COMPACT_SOURCE is required}"
: "${COMPACT_TARGET:?COMPACT_TARGET is required}"

TOPICS_FILE="${COMPACT_TOPICS:-scripts/ci/fork-topics.json}"

GIT_BIN="${SYNC_GIT_BIN:-$(command -v git)}"
git_cmd() {
  "$GIT_BIN" "$@"
}

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

changed="$workdir/changed.txt"
covered="$workdir/covered.txt"

git_cmd diff --name-only "$COMPACT_BASE" "$COMPACT_SOURCE" | sort > "$changed"

# Gate 2a: every changed path must be claimed by exactly one topic. Run this
# BEFORE mutating any refs so a bad topics file cannot leave a half-built branch.
node --input-type=module -e '
import { readFileSync } from "node:fs";

const [topicsFile, changedFile] = process.argv.slice(1);
const topics = JSON.parse(readFileSync(topicsFile, "utf8"));
const changed = readFileSync(changedFile, "utf8").split("\n").filter(Boolean);

const matches = (file, pattern) =>
  pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;

const uncovered = [];
const duplicated = [];
for (const file of changed) {
  const owners = topics.filter((topic) => topic.paths.some((p) => matches(file, p)));
  if (owners.length === 0) uncovered.push(file);
  if (owners.length > 1) duplicated.push(`${file} -> ${owners.map((o) => o.message).join(", ")}`);
}

if (uncovered.length > 0) {
  console.error("Path coverage gate FAILED. Files not covered by any topic:");
  for (const file of uncovered) console.error(`  ${file}`);
}
if (duplicated.length > 0) {
  console.error("Path coverage gate FAILED. Files claimed by multiple topics:");
  for (const entry of duplicated) console.error(`  ${entry}`);
}
process.exit(uncovered.length + duplicated.length > 0 ? 1 : 0);
' "$TOPICS_FILE" "$changed"

git_cmd checkout -q -B "$COMPACT_TARGET" "$COMPACT_BASE"

topic_count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$TOPICS_FILE")"

for ((index = 0; index < topic_count; index++)); do
  message="$(node -e 'const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(t[Number(process.argv[2])].message)' "$TOPICS_FILE" "$index")"

  mapfile -t topic_files < <(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [topicsFile, changedFile, indexRaw] = process.argv.slice(1);
    const topic = JSON.parse(readFileSync(topicsFile, "utf8"))[Number(indexRaw)];
    const changed = readFileSync(changedFile, "utf8").split("\n").filter(Boolean);
    const matches = (file, pattern) =>
      pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern;
    for (const file of changed) {
      if (topic.paths.some((p) => matches(file, p))) console.log(file);
    }
  ' "$TOPICS_FILE" "$changed" "$index")

  if [[ ${#topic_files[@]} -eq 0 ]]; then
    echo "Topic '$message' matched no changed files; skipping."
    continue
  fi

  git_cmd checkout "$COMPACT_SOURCE" -- "${topic_files[@]}"
  git_cmd add -A -- "${topic_files[@]}"
  if git_cmd diff --cached --quiet; then
    echo "Topic '$message' produced no change; skipping."
    continue
  fi
  git_cmd commit -q -m "$message"
  echo "Created topic: $message (${#topic_files[@]} files)"
done

# Gate 1: tree identity. This is the load-bearing safety check.
if [[ -n "$(git_cmd diff "$COMPACT_SOURCE" "$COMPACT_TARGET")" ]]; then
  echo "Tree identity gate FAILED: $COMPACT_TARGET differs from $COMPACT_SOURCE" >&2
  git_cmd diff --stat "$COMPACT_SOURCE" "$COMPACT_TARGET" >&2
  exit 1
fi

# Gate 2b: the compacted branch must change exactly the same files.
git_cmd diff --name-only "$COMPACT_BASE" "$COMPACT_TARGET" | sort > "$covered"
if ! diff -q "$changed" "$covered" >/dev/null; then
  echo "Path coverage gate FAILED: changed-file sets differ" >&2
  diff "$changed" "$covered" >&2 || true
  exit 1
fi

echo "Compaction complete."
echo "  $COMPACT_SOURCE: $(git_cmd rev-list --count "${COMPACT_BASE}..${COMPACT_SOURCE}") commits"
echo "  $COMPACT_TARGET: $(git_cmd rev-list --count "${COMPACT_BASE}..${COMPACT_TARGET}") commits"
echo "  Tree identity: PASS"
echo "  Path coverage: PASS"
```

Make it executable:

```bash
chmod +x scripts/ci/compact-stack
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/ci/compact-stack.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Verify the tree-identity gate catches a real drop**

Temporarily change `git_cmd checkout "$COMPACT_SOURCE" -- "${topic_files[@]}"` to `git_cmd checkout "$COMPACT_SOURCE" -- "${topic_files[0]}"` (only the first file per topic). Re-run.
Expected: the first test FAILS with `Tree identity gate FAILED`.
Revert the change and confirm both tests pass.

- [ ] **Step 6: Write the real topics file**

Create `scripts/ci/fork-topics.json`. Path sets come from spec §5.1:

```json
[
  {
    "message": "fork: t3-thread operator CLI",
    "paths": ["apps/t3-thread/"]
  },
  {
    "message": "fork: build and release tooling",
    "paths": [
      "scripts/",
      "ops/",
      "oxlint-plugin-t3code/",
      "infra/",
      "vite.config.ts",
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml"
    ]
  },
  {
    "message": "fork: docs",
    "paths": ["docs/"]
  },
  {
    "message": "fork(server): orchestration and projection",
    "paths": [
      "apps/server/src/orchestration/",
      "apps/server/src/persistence/",
      "apps/server/integration/"
    ]
  },
  {
    "message": "fork(server): provider runtime",
    "paths": ["apps/server/src/provider/"]
  },
  {
    "message": "fork(server): transport, auth and headless updates",
    "paths": ["apps/server/"]
  },
  {
    "message": "fork(web): client resilience and thread-move UI",
    "paths": ["apps/web/"]
  },
  {
    "message": "fork(desktop): branding, packaging flavor and update channels",
    "paths": ["apps/desktop/"]
  },
  {
    "message": "fork(mobile): EAS configuration",
    "paths": ["apps/mobile/", "app.json", "assets/", "favicon.svg"]
  },
  {
    "message": "fork(contracts): shared schema extensions",
    "paths": ["packages/"]
  },
  {
    "message": "fork(ci): release and sync pipeline",
    "paths": [".github/"]
  }
]
```

Note the ordering dependency: `fork(server): transport, auth and headless updates` uses the broad `apps/server/` prefix and must come _after_ the two narrower server topics. The coverage gate rejects a file claimed by two topics, so verify ordering with a dry run in the next step.

- [ ] **Step 7: Dry-run against the real repo**

```bash
COMPACT_BASE=$(git merge-base HEAD upstream/main) \
COMPACT_SOURCE=HEAD \
COMPACT_TARGET=compact-dryrun \
scripts/ci/compact-stack
```

Expected: `Tree identity: PASS` and `Path coverage: PASS`.

If the run reports files claimed by multiple topics, make the broad `apps/server/` topic exclusive by replacing its `paths` with the explicit subdirectories that remain (list them from the failure output). If it reports uncovered files, add their paths to the appropriate topic. Re-run until both gates pass.

Clean up the dry run:

```bash
git checkout -q "$(git rev-parse --abbrev-ref @{-1})" && git branch -D compact-dryrun
```

- [ ] **Step 8: Commit**

```bash
git add scripts/ci/compact-stack scripts/ci/compact-stack.test.ts scripts/ci/fork-topics.json
git commit -m "feat(ci): add stack compaction with tree and coverage gates"
```

---

## Task 8: Execute the compaction

**Files:** none created. This task rewrites `main`.

**Interfaces:**

- Consumes: `scripts/ci/compact-stack` and `scripts/ci/fork-topics.json` from Task 7.
- Produces: a `main` of ~11 topic commits.

**This is the only task that force-pushes `main`. Do not proceed unless Task 7's dry run passed both gates.**

- [ ] **Step 1: Confirm a clean working tree and current upstream state**

```bash
git status --porcelain
git fetch upstream --quiet
git merge-base HEAD upstream/main
```

Expected: empty `git status` output. Record the merge-base SHA.

- [ ] **Step 2: Create the backup branch**

```bash
git branch backup/pre-compact-$(git rev-parse --short HEAD) main
git branch --list 'backup/pre-compact-*'
```

Expected: the new backup branch is listed.

- [ ] **Step 3: Run the compaction**

```bash
COMPACT_BASE=$(git merge-base main upstream/main) \
COMPACT_SOURCE=main \
COMPACT_TARGET=main-compact \
scripts/ci/compact-stack
```

Expected: `Tree identity: PASS`, `Path coverage: PASS`, and a commit count of roughly 11.

- [ ] **Step 4: Verify tree identity independently**

Do not rely solely on the script's own gate.

```bash
git diff main main-compact | wc -l
git rev-list --count main-compact ^$(git merge-base main upstream/main)
```

Expected: `0` from the first command. A count near 11 from the second.

- [ ] **Step 5: Run the full test suite on the compacted branch**

```bash
git checkout main-compact
vp install --frozen-lockfile
vp run -r test
vp run -r typecheck
vp lint --report-unused-disable-directives
```

Expected: all pass. If the lockfile install fails, run `vp install --lockfile-only` and fold the result into the `fork: build and release tooling` topic with `git commit --fixup`, then `git rebase --autosquash`.

- [ ] **Step 6: Verify a rebase onto current upstream succeeds**

This is the real test of the whole exercise.

```bash
git checkout -B compact-rebase-check main-compact
CI_REPAIR_BOT_UPSTREAM_TARGET=refs/remotes/upstream/main \
CI_REPAIR_BOT_UPSTREAM_SOURCE_REF=refs/heads/main \
CI_REPAIR_BOT_CONFLICT_MODE=output \
SYNC_GIT_BIN=/usr/bin/git \
git rebase upstream/main
```

Expected: the rebase completes, or conflicts appear in far fewer commits than before. Record the count for comparison against the pre-compaction baseline.

```bash
git checkout main-compact && git branch -D compact-rebase-check
```

- [ ] **Step 7: Replace `main`**

```bash
git checkout main
git reset --hard main-compact --i-mean-it
git push origin main --force-with-lease
```

Note: `--i-mean-it` is required by the repo's `git` safety wrapper (`~/.shared/bin/git`) for `reset --hard`. This is the deliberate, confirmed destructive step the wrapper exists to guard.

- [ ] **Step 8: Verify the pushed result**

```bash
git fetch origin --quiet
git rev-list --count origin/main ^$(git merge-base origin/main upstream/main)
git log --oneline origin/main -12
git diff origin/main backup/pre-compact-* | wc -l
```

Expected: roughly 11 commits, all `fork:` / `fork(scope):` prefixed, and `0` from the final diff.

- [ ] **Step 9: Commit the branch cleanup**

No file changes. Delete the working branch:

```bash
git branch -D main-compact
```

---

## Task 9: Enforce `fixup!` commit discipline

**Files:**

- Create: `scripts/ci/check-commit-discipline`
- Test: `scripts/ci/check-commit-discipline.test.ts`
- Modify: `.github/workflows/ci.yml`
- Modify: `LLM_INSTRUCTIONS.md`

**Interfaces:**

- Consumes: `createFixtureRepo` from Task 1.
- Produces: executable `scripts/ci/check-commit-discipline`.
  - Required env: `DISCIPLINE_BASE` (upstream ref), `DISCIPLINE_HEAD` (ref to check).
  - Optional env: `SYNC_GIT_BIN`, `DISCIPLINE_TOPICS` (default `scripts/ci/fork-topics.json`).
  - Exits non-zero when a commit is neither a declared topic nor a `fixup!`.

**Rationale (spec §6):** 47 of the original 120 commits were `fix(ci)` repairs appended to `main`. Documented policy did not prevent that. The check is what makes the rule hold.

- [ ] **Step 1: Write the failing test**

Create `scripts/ci/check-commit-discipline.test.ts`:

```typescript
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { createFixtureRepo, type FixtureRepo } from "./lib/git-fixture.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/check-commit-discipline");

const runCheck = (
  repo: FixtureRepo,
  base: string,
  topicsPath: string,
): { readonly status: number; readonly output: string } => {
  try {
    const output = NodeChildProcess.execFileSync(script, [], {
      cwd: repo.dir,
      encoding: "utf8",
      env: {
        ...process.env,
        DISCIPLINE_BASE: base,
        DISCIPLINE_HEAD: "HEAD",
        DISCIPLINE_TOPICS: topicsPath,
        SYNC_GIT_BIN: "/usr/bin/git",
      },
    });
    return { status: 0, output };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
};

const seedTopics = (repo: FixtureRepo): string => {
  repo.writeFile(
    "topics.json",
    JSON.stringify([
      { message: "fork: tooling", paths: ["tools/"] },
      { message: "fork(app): behaviour", paths: ["src/"] },
    ]),
  );
  repo.commitAll("chore: topics");
  return NodePath.join(repo.dir, "topics.json");
};

describe("check-commit-discipline", () => {
  it("accepts declared topic commits and fixup! commits", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("src/b.ts", "export const b = 1;\n");
      repo.commitAll("fork(app): behaviour");
      repo.writeFile("tools/a.ts", "export const a = 2;\n");
      repo.commitAll("fixup! fork: tooling");

      const result = runCheck(repo, base, topics);
      assert.strictEqual(result.status, 0, result.output);
    } finally {
      repo.cleanup();
    }
  });

  it("REGRESSION: rejects an appended repair commit", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("tools/a.ts", "export const a = 2;\n");
      repo.commitAll("fix(ci): repair Sync Upstream failure");

      const result = runCheck(repo, base, topics);
      assert.notStrictEqual(result.status, 0, "appended repair commits must be rejected");
      assert.include(result.output, "fix(ci): repair Sync Upstream failure");
      assert.include(result.output, "--fixup");
    } finally {
      repo.cleanup();
    }
  });

  it("allows release-prep commits, which are tagged but never on main", () => {
    const repo = createFixtureRepo();
    try {
      const topics = seedTopics(repo);
      const base = repo.git("rev-parse", "HEAD");

      repo.writeFile("tools/a.ts", "export const a = 1;\n");
      repo.commitAll("fork: tooling");
      repo.writeFile("tools/a.ts", "export const a = 3;\n");
      repo.commitAll("chore(release): prepare v1.2.3-fork.1");

      const result = runCheck(repo, base, topics);
      assert.strictEqual(result.status, 0, result.output);
    } finally {
      repo.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `vp test run scripts/ci/check-commit-discipline.test.ts`
Expected: FAIL — `ENOENT`, script does not exist.

- [ ] **Step 3: Write the implementation**

Create `scripts/ci/check-commit-discipline`:

```bash
#!/usr/bin/env bash

set -euo pipefail

# Rejects commits that would regrow the fork's patch stack.
#
# The stack reached 120 commits because integration fixes were appended to main
# as new top-level commits — 47 of them, several sharing the message
# "fix(ci): repair Sync Upstream failure". Each one is then replayed onto every
# future upstream tag, forever. A fix committed as `git commit --fixup=<topic>`
# is folded into the topic it repairs by `git rebase --autosquash`, so the fix
# is kept and the commit is not.
#
# Required env:
#   DISCIPLINE_BASE  upstream ref to compare against
#   DISCIPLINE_HEAD  ref to check
# Optional env:
#   DISCIPLINE_TOPICS  topics JSON (default scripts/ci/fork-topics.json)
#   SYNC_GIT_BIN       git binary path

: "${DISCIPLINE_BASE:?DISCIPLINE_BASE is required}"
: "${DISCIPLINE_HEAD:?DISCIPLINE_HEAD is required}"

TOPICS_FILE="${DISCIPLINE_TOPICS:-scripts/ci/fork-topics.json}"

GIT_BIN="${SYNC_GIT_BIN:-$(command -v git)}"
git_cmd() {
  "$GIT_BIN" "$@"
}

mapfile -t topic_messages < <(node -e '
  const topics = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const topic of topics) console.log(topic.message);
' "$TOPICS_FILE")

is_allowed() {
  local subject="$1"
  local topic

  # fixup!/squash! commits are absorbed by rebase --autosquash.
  [[ "$subject" == fixup!* || "$subject" == squash!* ]] && return 0

  # Release-prep commits are tagged but pushed off main by
  # scripts/ci/prepare-release-tag; they never enter the replay stack.
  [[ "$subject" == "chore(release): prepare "* ]] && return 0

  for topic in "${topic_messages[@]}"; do
    [[ "$subject" == "$topic" ]] && return 0
  done

  return 1
}

violations=()
while IFS= read -r subject; do
  [[ -z "$subject" ]] && continue
  if ! is_allowed "$subject"; then
    violations+=("$subject")
  fi
done < <(git_cmd log --format='%s' "${DISCIPLINE_BASE}..${DISCIPLINE_HEAD}")

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "Commit discipline FAILED. These commits would permanently grow the rebase stack:" >&2
  printf '  %s\n' "${violations[@]}" >&2
  echo "" >&2
  echo "Fix: commit integration repairs against the topic they repair, e.g." >&2
  echo "  git commit --fixup=\$(git log --format='%H %s' ${DISCIPLINE_BASE}..HEAD | grep 'fork(server): provider runtime' | cut -d' ' -f1)" >&2
  echo "" >&2
  echo "Declared topics live in ${TOPICS_FILE}. Adding a genuinely new topic means" >&2
  echo "adding it there in the same change." >&2
  exit 1
fi

echo "Commit discipline PASS: $(git_cmd rev-list --count "${DISCIPLINE_BASE}..${DISCIPLINE_HEAD}") commits, all topics or fixups."
```

Make it executable:

```bash
chmod +x scripts/ci/check-commit-discipline
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `vp test run scripts/ci/check-commit-discipline.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Verify the check catches the real historical failure**

Run the check against the pre-compaction backup branch, which contains the 47 repair commits:

```bash
DISCIPLINE_BASE=$(git merge-base backup/pre-compact-* upstream/main) \
DISCIPLINE_HEAD=backup/pre-compact-* \
SYNC_GIT_BIN=/usr/bin/git \
scripts/ci/check-commit-discipline || echo "correctly rejected historical stack"
```

Expected: the check fails and lists `fix(ci): repair Sync Upstream failure` among the violations. This proves it would have prevented the problem.

- [ ] **Step 6: Add the CI job**

In `.github/workflows/ci.yml`, add this job at the end of the `jobs:` mapping:

```yaml
commit-discipline:
  name: Commit discipline
  runs-on: ubuntu-24.04
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@v6
      with:
        fetch-depth: 0

    - name: Fetch upstream
      run: |
        git remote add upstream https://github.com/pingdotgg/t3code.git || true
        git fetch --no-tags upstream main:refs/remotes/upstream/main

    # Guards against the failure mode that produced 47 appended repair
    # commits in the original stack. See scripts/ci/check-commit-discipline.
    - name: Check commit discipline
      env:
        DISCIPLINE_BASE: refs/remotes/upstream/main
        DISCIPLINE_HEAD: HEAD
      run: scripts/ci/check-commit-discipline
```

- [ ] **Step 7: Verify the workflow is valid YAML**

Run:

```bash
node -e "const YAML=require('yaml');const fs=require('fs');const w=YAML.parse(fs.readFileSync('.github/workflows/ci.yml','utf8'));console.log(Object.keys(w.jobs).join(','))"
```

Expected: the job list includes `commit-discipline`.

- [ ] **Step 8: Document the rule**

In `LLM_INSTRUCTIONS.md`, add this section immediately after the `## Fast path for release/update work` section:

````markdown
## Fork commit discipline (enforced by CI)

`main` is a curated patch series of ~11 topic commits declared in
`scripts/ci/fork-topics.json`. Every sync replays all of them onto the new
upstream tag, so each additional commit is a permanent per-sync cost.

**Never append a new top-level commit to `main`.** Commit integration repairs
against the topic they repair:

```bash
git commit --fixup=<sha of the topic commit>
```
````

`scripts/ci/reproduce-sync-upstream` runs `rebase --autosquash`, which folds the
fix into its topic. The fix is kept; the commit is not.

This is enforced by the `commit-discipline` job in `.github/workflows/ci.yml`
(`scripts/ci/check-commit-discipline`). It exists because the stack previously
grew to 120 commits, 47 of which were appended repair commits — documented
policy alone did not hold.

Adding a genuinely new topic is allowed, but it must be added to
`scripts/ci/fork-topics.json` in the same change.

Release-prep commits are exempt: `scripts/ci/prepare-release-tag` creates and
tags them, but `main` is pushed at the pre-prep SHA, so they never enter the
replay stack.

````

- [ ] **Step 9: Commit**

```bash
git add scripts/ci/check-commit-discipline scripts/ci/check-commit-discipline.test.ts .github/workflows/ci.yml LLM_INSTRUCTIONS.md
git commit -m "feat(ci): enforce fixup-only commit discipline on main"
````

---

## Task 10: Verify the pipeline end to end

**Files:** none. Verification only.

- [ ] **Step 1: Run the whole test suite**

```bash
vp run -r test
vp run -r typecheck
vp lint --report-unused-disable-directives
```

Expected: all pass.

- [ ] **Step 2: Trigger a real nightly sync**

```bash
gh workflow run sync-upstream.yml --repo jimprince/t3code -f channel=nightly
gh run watch "$(gh run list --repo jimprince/t3code --workflow=sync-upstream.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --repo jimprince/t3code --exit-status
```

Expected: the run succeeds.

- [ ] **Step 3: Verify `main` did not gain a release-prep commit**

```bash
git fetch origin --quiet
git log --format='%s' origin/main -5
git log --format='%s' origin/main | grep -c 'chore(release): prepare' || echo "0 prep commits on main"
```

Expected: `0 prep commits on main`.

- [ ] **Step 4: Verify the tag does carry the prep commit**

```bash
tag=$(gh release list --repo jimprince/t3code --limit 1 --json tagName --jq '.[0].tagName')
git fetch origin "refs/tags/${tag}:refs/tags/${tag}" --quiet
git log --format='%s' -1 "$tag"
git show "${tag}:apps/server/package.json" | grep version
```

Expected: the tag's commit is `chore(release): prepare <tag>` and the manifest version matches the tag.

- [ ] **Step 5: Verify the release built and published**

```bash
gh release view "$tag" --repo jimprince/t3code --json tagName,isPrerelease,assets --jq '{tag: .tagName, prerelease: .isPrerelease, assets: (.assets | length)}'
```

Expected: the release exists with a non-zero asset count — confirming `--frozen-lockfile` succeeded against the tagged commit.

- [ ] **Step 6: Verify rerere recorded resolutions (if a conflict occurred)**

On the dev VM:

```bash
ssh <dev-vm> 'ls -1 ~/.t3code-fork-meta/rr-cache | wc -l'
```

Expected: non-zero if any conflict was resolved. Zero is acceptable if the sync was clean.

- [ ] **Step 7: Record the new baseline**

```bash
echo "commits replayed: $(git rev-list --count $(git merge-base origin/main upstream/main)..origin/main)"
```

Expected: roughly 11, down from 120. This is success criteria #1 from the spec.

---

## Self-Review

**Spec coverage:**

| Spec section                                   | Task                   |
| ---------------------------------------------- | ---------------------- |
| §4.1 Drop the version-stamp commit             | 2, 3                   |
| §4.2 Regenerate the lockfile, never merge it   | 2, 4                   |
| §4.3 Persistent rerere on a self-hosted runner | 5, 6                   |
| §5.1 Target topic commits                      | 7 (`fork-topics.json`) |
| §5.2 Compaction method                         | 7                      |
| §5.3 Mandatory verification gates              | 7, 8                   |
| §6 Keep it compact (`fixup!`, CI-enforced)     | 9                      |
| §7 Patch inventory and retirement              | **Deferred to Plan 3** |
| §8 Shrink the surface                          | **Deferred to Plan 4** |
| §9.1 Automated detection and rollback          | **Deferred to Plan 2** |
| §9.2 Agent conflict resolution                 | **Deferred to Plan 2** |

**Deferred work is intentional.** Spec §9.1 (desktop rollback) must land before §9.2 (autonomous resolution), because autonomy without automated rollback ships breakage to an auto-updating desktop app. Plan 2 covers both in that order.

**Placeholder scan:** No `TBD`, `TODO`, or "add error handling" steps. Every code step contains complete, runnable content.

**Type consistency:** `FixtureRepo` (Task 1) is imported by Tasks 2, 7, 9 with matching member names (`dir`, `git`, `writeFile`, `commitAll`, `cleanup`). Env var names are consistent: `SYNC_GIT_BIN` across all four scripts; `COMPACT_*` in Task 7; `DISCIPLINE_*` in Task 9; `SYNC_RERERE_CACHE` between Tasks 5 and 6. The topics JSON shape (`{message, paths}`) is identical in Tasks 7 and 9.

**Known risk carried into execution:** Task 7 Step 7's dry run may reveal that the broad `apps/server/` topic overlaps the two narrower server topics. The coverage gate catches this by design, and Step 7 includes the remediation.
