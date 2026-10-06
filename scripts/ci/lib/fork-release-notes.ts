// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

declare const Bun: {
  readonly TOML: { readonly parse: (contents: string) => unknown };
};

/**
 * Fork-authored release note change entries.
 *
 * Each `docs/release-notes/entries/<id>.toml` file is one small, immutable
 * announcement owned alongside the functionality it describes (see
 * `docs/release-notes/entries/README.md`). `id` is the entry's stable
 * identity: `selectNewEntries` diffs on it, not on file content, so a stack replay never duplicates history. A follow-up fix has its own
 * new entry; published entries remain as immutable release history.
 */

export const CHANGE_CATEGORIES = [
  "feature",
  "fix",
  "performance",
  "maintenance",
  "removal",
] as const;

export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];

const CATEGORY_HEADINGS: Readonly<Record<ChangeCategory, string>> = {
  feature: "Features",
  fix: "Fixes",
  performance: "Performance",
  maintenance: "Maintenance",
  removal: "Removals",
};

export interface ChangeEntry {
  readonly id: string;
  readonly category: ChangeCategory;
  readonly functionality: string;
  readonly text: string;
}

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isChangeCategory(value: unknown): value is ChangeCategory {
  return typeof value === "string" && (CHANGE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Parses and validates one change entry file. Throws with a message naming
 * the offending file for every schema violation — callers decide whether
 * that failure blocks (strict validation) or is skipped (best-effort render).
 */
export function parseChangeEntry(fileName: string, contents: string): ChangeEntry {
  const baseName = fileName.endsWith(".toml") ? fileName.slice(0, -".toml".length) : fileName;

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(contents);
  } catch (error) {
    throw new Error(`${fileName}: invalid TOML: ${String(error)}`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${fileName}: must be a TOML table`);
  }

  const { id, category, functionality, text } = parsed as Record<string, unknown>;

  if (!isNonEmptyString(id)) {
    throw new Error(`${fileName}: "id" must be a non-empty string`);
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${fileName}: "id" must be lowercase kebab-case (got ${JSON.stringify(id)})`);
  }
  if (id !== baseName) {
    throw new Error(`${fileName}: filename must match "id" (expected ${id}.toml)`);
  }
  if (!isChangeCategory(category)) {
    throw new Error(
      `${fileName}: "category" must be one of ${CHANGE_CATEGORIES.join(", ")} (got ${JSON.stringify(category)})`,
    );
  }
  if (!isNonEmptyString(functionality)) {
    throw new Error(`${fileName}: "functionality" must be a non-empty string`);
  }
  if (!isNonEmptyString(text)) {
    throw new Error(`${fileName}: "text" must be a non-empty string`);
  }

  return { id, category, functionality: functionality.trim(), text: text.trim() };
}

export interface LoadEntriesOptions {
  /** Throw on the first invalid entry instead of skipping it with a warning. */
  readonly strict: boolean;
}

/**
 * Loads every `*.toml` change entry in `dir`, sorted by filename (= id) for
 * deterministic output. A missing directory means no entries yet, not an
 * error. In non-strict mode, invalid files are skipped with a warning on
 * stderr — the renderer must never fail a release over a bad entry; a
 * strict-mode validator run in CI is what should have caught it earlier.
 */
export function loadEntries(dir: string, options: LoadEntriesOptions): ChangeEntry[] {
  let fileNames: string[];
  try {
    fileNames = NodeFS.readdirSync(dir)
      .filter((name) => name.endsWith(".toml"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  // A file's "id" must equal its own basename (enforced in parseChangeEntry),
  // so two distinct filenames can never legitimately share an id — a
  // mismatch is reported as exactly that, per offending file.
  const entries: ChangeEntry[] = [];
  for (const fileName of fileNames) {
    try {
      const contents = NodeFS.readFileSync(NodePath.join(dir, fileName), "utf8");
      entries.push(parseChangeEntry(fileName, contents));
    } catch (error) {
      if (options.strict) throw error;
      console.error(`release-notes: skipping invalid entry: ${(error as Error).message}`);
    }
  }
  return entries;
}

export interface ListPreviousEntryIdsOptions {
  readonly repoRoot: string;
  readonly entriesDir: string;
  /** Previous fork release tag; empty for the first release. */
  readonly previousTag: string;
  /** Test seam: a JSON file containing an array of previously-announced ids. */
  readonly previousIdsJsonPath: string | undefined;
}

/**
 * Determines which entry ids were already announced as of the previous fork
 * release tag, so `selectNewEntries` only surfaces genuinely new concerns.
 * This reads the tag's tree content directly (`git ls-tree`), not commit
 * history, so it is unaffected by the fork's rebase/replay workflow rewriting
 * hashes between releases, and it naturally spans skipped/batched releases
 * since it only compares two trees.
 */
export function listPreviousEntryIds(options: ListPreviousEntryIdsOptions): Set<string> {
  if (options.previousIdsJsonPath) {
    try {
      const raw: unknown = JSON.parse(NodeFS.readFileSync(options.previousIdsJsonPath, "utf8"));
      return Array.isArray(raw)
        ? new Set(raw.filter((value): value is string => typeof value === "string"))
        : new Set();
    } catch {
      return new Set();
    }
  }

  if (!options.previousTag) return new Set();

  // Resolve symlinks before computing the relative path: `git`'s own cwd
  // resolution and callers that hand in independently-computed paths (e.g.
  // a tmp dir under a symlinked root) can otherwise disagree on what "the
  // repo root" looks like, producing a pathspec that points outside the
  // repository and silently matching nothing.
  const realpath = (path: string): string => {
    try {
      return NodeFS.realpathSync(path);
    } catch {
      return path;
    }
  };
  const relativeDir = NodePath.relative(realpath(options.repoRoot), realpath(options.entriesDir));
  const listTree = (): string | null => {
    const result = NodeChildProcess.spawnSync(
      "git",
      ["ls-tree", "-r", "--name-only", options.previousTag, "--", relativeDir],
      { cwd: options.repoRoot, encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout : null;
  };

  let output = listTree();
  if (output === null) {
    // The previous tag may not be fetched locally yet; try once, best-effort.
    NodeChildProcess.spawnSync(
      "git",
      [
        "fetch",
        "--no-tags",
        "origin",
        `refs/tags/${options.previousTag}:refs/tags/${options.previousTag}`,
      ],
      { cwd: options.repoRoot, encoding: "utf8" },
    );
    output = listTree();
  }
  if (output === null) {
    throw new Error(
      `Cannot read previous release ${options.previousTag}; refusing to re-announce all entries.`,
    );
  }

  const ids = new Set<string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.endsWith(".toml")) ids.add(NodePath.basename(trimmed, ".toml"));
  }
  return ids;
}

/** Entries present now whose id was not already announced at the previous tag. */
export function selectNewEntries(
  entries: readonly ChangeEntry[],
  previousIds: ReadonlySet<string>,
): ChangeEntry[] {
  return entries.filter((entry) => !previousIds.has(entry.id));
}

/**
 * Renders new entries grouped functionality-first: Features, Fixes,
 * Performance, Maintenance, Removals. Empty categories are omitted. Returns
 * "" when there is nothing new to announce.
 */
export function renderForkChangesSection(entries: readonly ChangeEntry[]): string {
  const groups = CHANGE_CATEGORIES.map((category) => ({
    heading: CATEGORY_HEADINGS[category],
    items: entries.filter((entry) => entry.category === category),
  })).filter((group) => group.items.length > 0);

  if (groups.length === 0) return "";

  return groups
    .map(
      ({ heading, items }) =>
        `### ${heading}\n\n${items.map((entry) => `- ${entry.text}`).join("\n")}`,
    )
    .join("\n\n");
}
