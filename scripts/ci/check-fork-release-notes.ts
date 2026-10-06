#!/usr/bin/env bun

// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodePath from "node:path";
import { loadEntries } from "./lib/fork-release-notes.ts";

// Fails closed on any invalid change entry (bad TOML, unknown category,
// missing field, filename/id mismatch, duplicate id). This is the strict
// counterpart to render-fork-release-notes, which stays best-effort so a
// malformed entry can never block an actual release; this check is what
// should catch it first, in CI.
function main(): void {
  const entriesDir = NodePath.resolve(
    process.cwd(),
    process.env.RELEASE_NOTES_ENTRIES_DIR ?? "docs/release-notes/entries",
  );
  const entries = loadEntries(entriesDir, { strict: true });
  console.log(
    `release-notes: ${entries.length} valid entr${entries.length === 1 ? "y" : "ies"} in ${NodePath.relative(process.cwd(), entriesDir)}`,
  );
}

try {
  main();
} catch (error) {
  console.error(`release-notes: invalid change entry: ${(error as Error).message ?? error}`);
  process.exit(1);
}
