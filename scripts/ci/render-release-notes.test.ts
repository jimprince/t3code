// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const script = NodePath.join(repoRoot, "scripts/ci/render-release-notes");

const previousTag = "v0.0.34-nightly.20260813.1084-fork.1";
const releaseTag = "v0.0.34-nightly.20260815.1100-fork.1";

const writeComparePayload = (
  payload: unknown,
): { readonly path: string; readonly cleanup: () => void } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-notes-"));
  const path = NodePath.join(dir, "compare.json");
  NodeFS.writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
  NodeFS.writeFileSync(NodePath.join(dir, "previous-ids.json"), "[]");
  return {
    path,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

const comparePayload = (subjects: readonly string[]) => ({
  commits: subjects.map((message) => ({ commit: { message } })),
});

const runRenderer = (
  compareJson: string,
  previous = previousTag,
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): NodeChildProcess.SpawnSyncReturns<string> =>
  NodeChildProcess.spawnSync(script, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_TAG: releaseTag,
      RELEASE_PREVIOUS_TAG: previous,
      RELEASE_REPO: "jimprince/t3code",
      UPSTREAM_REPO: "pingdotgg/t3code",
      RELEASE_NOTES_COMPARE_JSON: compareJson,
      RELEASE_NOTES_ENTRIES_DIR: NodePath.join(NodePath.dirname(compareJson), "empty-entries"),
      RELEASE_NOTES_PREVIOUS_ENTRY_IDS_JSON: NodePath.join(
        NodePath.dirname(compareJson),
        "previous-ids.json",
      ),
      ...extraEnv,
    },
  });

const entryToml = (fields: Record<"id" | "category" | "functionality" | "text", string>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");

const writeForkEntriesDir = (
  entries: ReadonlyArray<Record<"id" | "category" | "functionality" | "text", string>>,
): { readonly dir: string; readonly cleanup: () => void } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-notes-entries-"));
  for (const entry of entries) {
    NodeFS.writeFileSync(NodePath.join(dir, `${entry.id}.toml`), entryToml(entry));
  }
  return { dir, cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};

describe("render-release-notes", () => {
  it("front-loads the newest 20 upstream subjects and reports the overflow", () => {
    const fixture = writeComparePayload(
      comparePayload(
        Array.from({ length: 22 }, (_, index) => `feat: upstream change ${index + 1}`),
      ),
    );
    try {
      const result = runRenderer(fixture.path);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(
        result.stdout,
        "## Compare: upstream v0.0.34-nightly.20260813.1084 → v0.0.34-nightly.20260815.1100",
      );
      assert.include(result.stdout, "- feat: upstream change 22");
      assert.include(result.stdout, "- feat: upstream change 3");
      assert.notInclude(result.stdout, "- feat: upstream change 2\n");
      assert.notInclude(result.stdout, "- feat: upstream change 1\n");
      assert.isBelow(
        result.stdout.indexOf("- feat: upstream change 22"),
        result.stdout.indexOf("- feat: upstream change 3"),
        "most recent upstream subjects must appear first",
      );
      assert.strictEqual(
        result.stdout.match(/^- feat: upstream change \d+$/gm)?.length,
        20,
        "the subject list is capped at 20 items",
      );
      assert.include(result.stdout, "- +2 more upstream changes");
      assert.notInclude(result.stdout, "\n\n- ");
      assert.include(
        result.stdout,
        "[Upstream compare](https://github.com/pingdotgg/t3code/compare/v0.0.34-nightly.20260813.1084...v0.0.34-nightly.20260815.1100)",
      );
      assert.isTrue(
        result.stdout
          .trim()
          .endsWith(
            "Full Changelog: https://github.com/jimprince/t3code/compare/v0.0.34-nightly.20260813.1084-fork.1...v0.0.34-nightly.20260815.1100-fork.1",
          ),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("emits a minimal first-release body when no previous tag exists", () => {
    const fixture = writeComparePayload(
      comparePayload(["feat: this payload is intentionally ignored"]),
    );
    try {
      const result = runRenderer(fixture.path, "");

      assert.strictEqual(result.status, 0, result.stderr);
      assert.notInclude(result.stdout, "## Compare:");
      assert.notInclude(result.stdout, "this payload is intentionally ignored");
      assert.strictEqual(
        result.stdout.trim(),
        "## What's changed\n\nFull Changelog: https://github.com/jimprince/t3code/releases/tag/v0.0.34-nightly.20260815.1100-fork.1",
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps release publication non-blocking for malformed or missing compare payloads", () => {
    const malformedFixture = writeComparePayload("{ this is not JSON");
    const missingPath = NodePath.join(NodeOS.tmpdir(), `missing-release-notes-${process.pid}.json`);
    try {
      for (const compareJson of [malformedFixture.path, missingPath]) {
        const result = runRenderer(compareJson);

        assert.strictEqual(result.status, 0, result.stderr);
        assert.notInclude(result.stdout, "## Compare:");
        assert.include(
          result.stdout,
          "[Upstream compare](https://github.com/pingdotgg/t3code/compare/v0.0.34-nightly.20260813.1084...v0.0.34-nightly.20260815.1100)",
        );
        assert.isTrue(
          result.stdout
            .trim()
            .endsWith(
              "Full Changelog: https://github.com/jimprince/t3code/compare/v0.0.34-nightly.20260813.1084-fork.1...v0.0.34-nightly.20260815.1100-fork.1",
            ),
        );
      }
    } finally {
      malformedFixture.cleanup();
    }
  });

  it("sanitizes commit subjects into one safe markdown bullet per commit", () => {
    const fixture = writeComparePayload(
      comparePayload([
        "fix: older change",
        "feat: **[Bold]** <tag> #heading | `code`_\nsecond line",
      ]),
    );
    try {
      const result = runRenderer(fixture.path);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "- feat: Bold tag #heading code");
      assert.notInclude(result.stdout, "**[Bold]**");
      assert.notInclude(result.stdout, "<tag>");
      assert.notInclude(result.stdout, "second line");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps scoped conventional commits and pull request references readable in adjacent bullets", () => {
    const fixture = writeComparePayload(
      comparePayload([
        "test: remove redundant and stale tests (#6267)",
        "fix(web): keep highlighted command menu items clear of the scroll fade (#7132)",
        "refactor(web): simplify advanced theme controls (#7107)",
      ]),
    );
    try {
      const result = runRenderer(fixture.path);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(
        result.stdout,
        [
          "- refactor(web): simplify advanced theme controls (#7107)",
          "- fix(web): keep highlighted command menu items clear of the scroll fade (#7132)",
          "- test: remove redundant and stale tests (#6267)",
        ].join("\n"),
      );
      assert.notInclude(result.stdout, "\n\n- ");
    } finally {
      fixture.cleanup();
    }
  });

  it("renders fork changes functionality-first, ahead of and separate from upstream changes", () => {
    const fixture = writeComparePayload(comparePayload(["feat: upstream change"]));
    const entries = writeForkEntriesDir([
      {
        id: "gitea-pr-checkout",
        category: "feature",
        functionality: "source-control",
        text: "Create and check out Gitea pull requests.",
      },
      {
        id: "hide-projects-pr-list",
        category: "fix",
        functionality: "web",
        text: "Hide projects from the pull request list.",
      },
    ]);
    try {
      const result = runRenderer(fixture.path, previousTag, {
        RELEASE_NOTES_ENTRIES_DIR: entries.dir,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.isBelow(
        result.stdout.indexOf("## Fork changes"),
        result.stdout.indexOf("## Compare: upstream"),
        "fork changes must appear before the upstream compare section",
      );
      assert.include(result.stdout, "### Features\n\n- Create and check out Gitea pull requests.");
      assert.include(result.stdout, "### Fixes\n\n- Hide projects from the pull request list.");
      assert.include(result.stdout, "- feat: upstream change");
    } finally {
      fixture.cleanup();
      entries.cleanup();
    }
  });

  it("shows fork changes without a self-compare link for a same-upstream fork-only release", () => {
    const sameUpstreamPrevious = "v0.0.34-nightly.20260813.1084-fork.1";
    const sameUpstreamCurrent = "v0.0.34-nightly.20260813.1084-fork.2";
    const entries = writeForkEntriesDir([
      {
        id: "fork-only-fix",
        category: "fix",
        functionality: "updates",
        text: "Fix a fork-only packaging bug.",
      },
    ]);
    try {
      const result = runRenderer(
        NodePath.join(entries.dir, "unused-compare.json"),
        sameUpstreamPrevious,
        {
          RELEASE_TAG: sameUpstreamCurrent,
          RELEASE_NOTES_ENTRIES_DIR: entries.dir,
        },
      );

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "### Fixes\n\n- Fix a fork-only packaging bug.");
      assert.notInclude(result.stdout, "## Compare:");
      assert.notInclude(result.stdout, "[Upstream compare]");
      assert.isTrue(
        result.stdout
          .trim()
          .endsWith(
            `Full Changelog: https://github.com/jimprince/t3code/compare/${sameUpstreamPrevious}...${sameUpstreamCurrent}`,
          ),
      );
    } finally {
      entries.cleanup();
    }
  });

  it("spans skipped/batched versions and does not repeat entries already announced", () => {
    const fixture = writeComparePayload(comparePayload(["feat: upstream change"]));
    const entries = writeForkEntriesDir([
      {
        id: "already-announced",
        category: "feature",
        functionality: "web",
        text: "Already announced, since refreshed.",
      },
      {
        id: "brand-new",
        category: "feature",
        functionality: "web",
        text: "Brand new since the last release.",
      },
    ]);
    try {
      const previousIdsPath = NodePath.join(entries.dir, "previous-ids.json");
      NodeFS.writeFileSync(previousIdsPath, JSON.stringify(["already-announced"]));

      const result = runRenderer(fixture.path, previousTag, {
        RELEASE_NOTES_ENTRIES_DIR: entries.dir,
        RELEASE_NOTES_PREVIOUS_ENTRY_IDS_JSON: previousIdsPath,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "Brand new since the last release.");
      assert.notInclude(result.stdout, "Already announced");
    } finally {
      fixture.cleanup();
      entries.cleanup();
    }
  });

  it("keeps the upstream compare link and fork notes when the upstream fetch is unavailable", () => {
    const missingPath = NodePath.join(NodeOS.tmpdir(), `missing-release-notes-${process.pid}.json`);
    const entries = writeForkEntriesDir([
      {
        id: "still-useful",
        category: "feature",
        functionality: "web",
        text: "Still useful without upstream data.",
      },
    ]);
    try {
      const result = runRenderer(missingPath, previousTag, {
        RELEASE_NOTES_ENTRIES_DIR: entries.dir,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "### Features\n\n- Still useful without upstream data.");
      assert.notInclude(result.stdout, "## Compare:");
      assert.include(
        result.stdout,
        "[Upstream compare](https://github.com/pingdotgg/t3code/compare/v0.0.34-nightly.20260813.1084...v0.0.34-nightly.20260815.1100)",
      );
    } finally {
      entries.cleanup();
    }
  });
});
