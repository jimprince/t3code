// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Seeds the global quality scripts once. They are ordinary rows afterwards: edits and deletions
 * stick, and a global script Brad already named the same way wins.
 */
const COMMON = `Scope: this project's repositories only (its workspace and the branches its threads work on). Read the code and history; do not change code, settings or data.
For every finding give: what and where (file:line, command or screen), the evidence (output, measurement, quote), impact, and a suggested action with rough effort. Rank by impact; prefer a few strong findings over a long list. Say plainly when an area is fine.
Obey the result mode at the end of this prompt.`;

const STARTERS: ReadonlyArray<{ name: string; description: string; prompt: string }> = [
  {
    name: "code-quality",
    description: "Correctness risks, unclear code and missing tests.",
    prompt:
      "Review code quality: likely bugs, unhandled errors and edge cases, unclear or duplicated logic, weak typing, and important behavior without focused tests. Use the repository's own conventions as the bar.",
  },
  {
    name: "performance",
    description: "Responsiveness and performance hot spots.",
    prompt:
      "Review responsiveness and performance: slow startup or interactions, heavy renders and continuously repainting animations, large payloads over the network or websocket, N+1 queries, blocking work on hot paths, and memory growth. Measure where you can and state how.",
  },
  {
    name: "dependencies",
    description: "Outdated, vulnerable and unused dependencies.",
    prompt:
      "Review dependencies: outdated packages (with the gap and notable breaking changes), known vulnerabilities (with advisory ids), unused or duplicate dependencies, and pinned versions that block upgrades. Use the package manager's own outdated and audit commands where available.",
  },
  {
    name: "refactoring",
    description: "Refactoring opportunities that simplify the system.",
    prompt:
      "Find refactoring opportunities that make the system smaller or clearer: duplicated mechanisms, layers that add no value, tangled modules, and code that fights its framework. Prefer deletions and consolidations over new abstractions.",
  },
  {
    name: "ux-review",
    description: "A full user-experience review.",
    prompt:
      "Review the full user experience: main flows from first use to daily work, confusing or inconsistent screens and copy, missing reverse actions, stale or lying status, error states, accessibility, and every client surface the project ships. Walk the flows in the code (and the running app if one is available).",
  },
  {
    name: "docs-currency",
    description: "Documentation that no longer matches the code.",
    prompt:
      "Check documentation currency: user guides, READMEs, operations runbooks and agent instructions that no longer match the code, commands that would fail as written, and important behavior with no documentation. Quote the stale text and the code that contradicts it.",
  },
  {
    name: "data-model-review",
    description: "Schemas, persistence and data integrity.",
    prompt:
      "Review the data model: schemas and contracts, persistence and migrations, invariants that are not enforced, duplicated or derivable state, risky nullable or loosely typed fields, and upgrade or rollback hazards for stored data.",
  },
  {
    name: "dead-code",
    description: "Dead or removable modules (propose only).",
    prompt:
      "Find dead or removable code: unused files and exports, features with no entry point, stale flags and compatibility shims whose reason has passed. For each, show why it is unused and what removing it would lose. Propose only: removals need Brad's explicit OK, and an unused feature may be broken rather than unwanted.",
  },
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = "2026-10-05T00:00:00.000Z";
  for (const starter of STARTERS) {
    const id = `starter:${starter.name}`;
    const script = {
      id,
      projectId: null,
      name: starter.name,
      description: starter.description,
      prompt: `${starter.prompt}\n\n${COMMON}`,
      resultMode: "review",
      createdAt: now,
      updatedAt: now,
    };
    yield* sql`
      INSERT INTO automation_scripts (script_id, project_id, name, script_json, created_at, updated_at)
      VALUES (${id}, NULL, ${starter.name}, ${JSON.stringify(script)}, ${now}, ${now})
      ON CONFLICT DO NOTHING
    `;
  }
});
