#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodePath from "node:path";
import {
  listPreviousEntryIds,
  loadEntries,
  renderForkChangesSection,
  selectNewEntries,
} from "./lib/fork-release-notes.ts";

// Prints the fork's own "new since the previous release" change notes to
// stdout, or nothing when there is nothing new. Never blocks release
// publication: any failure here (bad TOML, missing git, ...) degrades to an
// empty section rather than a non-zero exit. Local entries should already be
// caught earlier by the strict `check-fork-release-notes` validator.
function main(): void {
  const repoRoot = process.cwd();
  const entriesDir = NodePath.resolve(
    repoRoot,
    process.env.RELEASE_NOTES_ENTRIES_DIR ?? "docs/release-notes/entries",
  );

  const currentEntries = loadEntries(entriesDir, { strict: false });
  const previousIds = listPreviousEntryIds({
    repoRoot,
    entriesDir,
    previousTag: process.env.RELEASE_PREVIOUS_TAG ?? "",
    previousIdsJsonPath: process.env.RELEASE_NOTES_PREVIOUS_ENTRY_IDS_JSON,
  });
  const newEntries = selectNewEntries(currentEntries, previousIds);
  process.stdout.write(renderForkChangesSection(newEntries));
}

try {
  main();
} catch (error) {
  console.error(`render-fork-release-notes: ${String(error)}`);
}
