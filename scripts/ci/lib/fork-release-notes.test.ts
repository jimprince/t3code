// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";

import { createFixtureRepo } from "./git-fixture.ts";

// fork-release-notes.ts uses Bun.TOML and only runs correctly under the bun
// runtime (via its bash wrappers), same constraint as check-stgit-stack.ts.
// So, like check-stgit-stack.test.ts, these tests spawn the real CLI
// scripts rather than importing the module into the Node-based test runner.
const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const renderScript = NodePath.join(repoRoot, "scripts/ci/render-fork-release-notes");
const checkScript = NodePath.join(repoRoot, "scripts/ci/check-fork-release-notes");

const entryToml = (fields: Partial<Record<"id" | "category" | "functionality" | "text", string>>) =>
  Object.entries(fields)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
    .join("\n");

const makeEntriesDir = (): { readonly dir: string; readonly cleanup: () => void } => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-release-notes-entries-"));
  return { dir, cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }) };
};

const writeEntry = (
  dir: string,
  id: string,
  fields: Record<"category" | "functionality" | "text", string>,
) => NodeFS.writeFileSync(NodePath.join(dir, `${id}.toml`), entryToml({ id, ...fields }));

const runRender = (
  entriesDir: string,
  env: Readonly<Record<string, string | undefined>> = {},
  cwd = repoRoot,
): NodeChildProcess.SpawnSyncReturns<string> =>
  NodeChildProcess.spawnSync(renderScript, [], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, RELEASE_NOTES_ENTRIES_DIR: entriesDir, ...env },
  });

const runCheck = (entriesDir: string): NodeChildProcess.SpawnSyncReturns<string> =>
  NodeChildProcess.spawnSync(checkScript, [], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, RELEASE_NOTES_ENTRIES_DIR: entriesDir },
  });

describe("render-fork-release-notes", () => {
  it("groups new entries functionality-first and omits empty categories", () => {
    const fixture = makeEntriesDir();
    try {
      writeEntry(fixture.dir, "m1", {
        category: "maintenance",
        functionality: "build",
        text: "Maintenance change.",
      });
      writeEntry(fixture.dir, "f1", {
        category: "feature",
        functionality: "web",
        text: "Feature one.",
      });
      writeEntry(fixture.dir, "x1", { category: "fix", functionality: "web", text: "Fix one." });
      writeEntry(fixture.dir, "f2", {
        category: "feature",
        functionality: "web",
        text: "Feature two.",
      });

      const result = runRender(fixture.dir);

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(
        result.stdout,
        [
          "### Features",
          "",
          "- Feature one.",
          "- Feature two.",
          "",
          "### Fixes",
          "",
          "- Fix one.",
          "",
          "### Maintenance",
          "",
          "- Maintenance change.",
        ].join("\n"),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("announces everything on the first release (no previous tag)", () => {
    const fixture = makeEntriesDir();
    try {
      writeEntry(fixture.dir, "f1", {
        category: "feature",
        functionality: "web",
        text: "Feature one.",
      });
      const result = runRender(fixture.dir, { RELEASE_PREVIOUS_TAG: "" });
      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "- Feature one.");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not repeat an entry already announced (JSON test seam), even after a wording refresh", () => {
    const fixture = makeEntriesDir();
    try {
      writeEntry(fixture.dir, "already-announced", {
        category: "fix",
        functionality: "web",
        text: "Refreshed wording for an existing fix.",
      });
      writeEntry(fixture.dir, "brand-new", {
        category: "feature",
        functionality: "web",
        text: "Brand new feature.",
      });

      const previousIdsPath = NodePath.join(fixture.dir, "previous-ids.json");
      NodeFS.writeFileSync(previousIdsPath, JSON.stringify(["already-announced"]));

      const result = runRender(fixture.dir, {
        RELEASE_PREVIOUS_TAG: "v1.0.0-fork.1",
        RELEASE_NOTES_PREVIOUS_ENTRY_IDS_JSON: previousIdsPath,
      });

      assert.strictEqual(result.status, 0, result.stderr);
      assert.include(result.stdout, "- Brand new feature.");
      assert.notInclude(result.stdout, "Refreshed wording");
    } finally {
      fixture.cleanup();
    }
  });

  it("selects new entries between two real fork release tags, spanning skipped/batched versions", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile(
        "docs/release-notes/entries/first.toml",
        entryToml({
          id: "first",
          category: "feature",
          functionality: "web",
          text: "First feature.",
        }),
      );
      repo.commitAll("docs(release-notes): add first entry");
      repo.git("tag", "v1.0.0-fork.1");

      // Two more releases' worth of entries land before the next actual
      // release tag is cut (a batch/skipped-version scenario).
      repo.writeFile(
        "docs/release-notes/entries/second.toml",
        entryToml({ id: "second", category: "fix", functionality: "web", text: "Second fix." }),
      );
      repo.commitAll("docs(release-notes): add second entry");
      repo.writeFile(
        "docs/release-notes/entries/third.toml",
        entryToml({
          id: "third",
          category: "feature",
          functionality: "web",
          text: "Third feature.",
        }),
      );
      repo.commitAll("docs(release-notes): add third entry");
      repo.git("tag", "v1.0.2-fork.1");

      const result = runRender(
        "docs/release-notes/entries",
        { RELEASE_PREVIOUS_TAG: "v1.0.0-fork.1" },
        repo.dir,
      );

      assert.strictEqual(result.status, 0, result.stderr);
      assert.notInclude(result.stdout, "First feature.");
      assert.include(result.stdout, "Second fix.");
      assert.include(result.stdout, "Third feature.");
    } finally {
      repo.cleanup();
    }
  });

  it("renders nothing new on a no-change replay of the same release", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile(
        "docs/release-notes/entries/only.toml",
        entryToml({ id: "only", category: "feature", functionality: "web", text: "Only feature." }),
      );
      repo.commitAll("docs(release-notes): add only entry");
      repo.git("tag", "v1.0.0-fork.1");
      // Simulate a rebuild/reroll: same tree content, new tag.
      repo.git("tag", "v1.0.0-fork.2");

      const result = runRender(
        "docs/release-notes/entries",
        { RELEASE_PREVIOUS_TAG: "v1.0.0-fork.1" },
        repo.dir,
      );

      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout, "");
    } finally {
      repo.cleanup();
    }
  });

  it("degrades to an empty section instead of failing when entries are missing or invalid", () => {
    const missing = runRender("/nonexistent/entries/dir");
    assert.strictEqual(missing.status, 0, missing.stderr);
    assert.strictEqual(missing.stdout, "");

    const fixture = makeEntriesDir();
    try {
      NodeFS.writeFileSync(NodePath.join(fixture.dir, "broken.toml"), 'category = "nope"');
      const invalid = runRender(fixture.dir);
      assert.strictEqual(invalid.status, 0, invalid.stderr);
      assert.strictEqual(invalid.stdout, "");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not re-announce history when the previous release cannot be read", () => {
    const repo = createFixtureRepo();
    try {
      repo.writeFile(
        "docs/release-notes/entries/only.toml",
        entryToml({ id: "only", category: "feature", functionality: "web", text: "Only feature." }),
      );
      repo.commitAll("docs(release-notes): add only entry");

      const result = runRender(
        "docs/release-notes/entries",
        { RELEASE_PREVIOUS_TAG: "v0.0.0-does-not-exist" },
        repo.dir,
      );

      assert.strictEqual(result.status, 0, result.stderr);
      assert.notInclude(result.stdout, "Only feature.");
      assert.include(result.stderr, "Cannot read previous release");
    } finally {
      repo.cleanup();
    }
  });
});

describe("check-fork-release-notes", () => {
  it("passes closed (exit 0) when every entry is valid", () => {
    const fixture = makeEntriesDir();
    try {
      writeEntry(fixture.dir, "ok", { category: "feature", functionality: "web", text: "Fine." });
      const result = runCheck(fixture.dir);
      assert.strictEqual(result.status, 0, result.stderr);
    } finally {
      fixture.cleanup();
    }
  });

  it("passes when the entries directory does not exist yet", () => {
    const result = runCheck("/nonexistent/entries/dir");
    assert.strictEqual(result.status, 0, result.stderr);
  });

  it("fails closed on an invalid category", () => {
    const fixture = makeEntriesDir();
    try {
      writeEntry(fixture.dir, "bad", { category: "chore", functionality: "web", text: "x" });
      const result = runCheck(fixture.dir);
      assert.notStrictEqual(result.status, 0);
      assert.include(result.stderr, "category");
    } finally {
      fixture.cleanup();
    }
  });

  it("fails closed when the filename does not match the id", () => {
    const fixture = makeEntriesDir();
    try {
      NodeFS.writeFileSync(
        NodePath.join(fixture.dir, "wrong-name.toml"),
        entryToml({ id: "right-name", category: "fix", functionality: "web", text: "x" }),
      );
      const result = runCheck(fixture.dir);
      assert.notStrictEqual(result.status, 0);
      assert.include(result.stderr, 'filename must match "id"');
    } finally {
      fixture.cleanup();
    }
  });
});
