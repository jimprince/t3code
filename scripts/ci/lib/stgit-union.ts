export type UnionedHunk = {
  readonly line: number;
  readonly oursLines: number;
  readonly theirsLines: number;
};

export type HunkUnionResult =
  | { readonly ok: true; readonly text: string; readonly hunks: readonly UnionedHunk[] }
  | { readonly ok: false; readonly reason: string };

const isMarker = (line: string, marker: string): boolean =>
  line === marker || line.startsWith(`${marker} `);

/**
 * Resolves every conflict hunk whose diff3 base section is empty, meaning both
 * sides only inserted lines at the same spot, by keeping ours then theirs. Any
 * other hunk makes the whole file unresolvable, so callers never get a partial
 * resolution.
 */
export const unionAdditiveHunks = (text: string): HunkUnionResult => {
  const lines = text.split("\n");
  const out: string[] = [];
  const hunks: UnionedHunk[] = [];
  let section: "text" | "ours" | "base" | "theirs" = "text";
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];
  let startLine = 0;
  for (const [index, line] of lines.entries()) {
    if (section === "text") {
      if (isMarker(line, "<<<<<<<")) {
        section = "ours";
        startLine = index + 1;
        ours = [];
        base = [];
        theirs = [];
      } else if (isMarker(line, ">>>>>>>") || isMarker(line, "|||||||") || line === "=======") {
        return { ok: false, reason: `stray conflict marker at line ${index + 1}` };
      } else {
        out.push(line);
      }
    } else if (section === "ours") {
      if (isMarker(line, "|||||||")) section = "base";
      else if (line === "=======" || isMarker(line, "<<<<<<<") || isMarker(line, ">>>>>>>"))
        return { ok: false, reason: `hunk at line ${startLine} is not in diff3 style` };
      else ours.push(line);
    } else if (section === "base") {
      if (line === "=======") section = "theirs";
      else if (isMarker(line, "<<<<<<<") || isMarker(line, ">>>>>>>"))
        return { ok: false, reason: `malformed hunk at line ${startLine}` };
      else base.push(line);
    } else if (isMarker(line, ">>>>>>>")) {
      if (base.length !== 0)
        return { ok: false, reason: `hunk at line ${startLine} has a non-empty base` };
      out.push(...ours, ...theirs);
      hunks.push({ line: startLine, oursLines: ours.length, theirsLines: theirs.length });
      section = "text";
    } else if (isMarker(line, "<<<<<<<") || isMarker(line, "|||||||") || line === "=======") {
      return { ok: false, reason: `malformed hunk at line ${startLine}` };
    } else {
      theirs.push(line);
    }
  }
  if (section !== "text") return { ok: false, reason: `unterminated hunk at line ${startLine}` };
  if (hunks.length === 0) return { ok: false, reason: "no conflict hunks found" };
  return { ok: true, text: out.join("\n"), hunks };
};

export type UnionGateOperations = {
  readonly format: (files: readonly string[]) => void;
  readonly typecheckDirFor: (file: string) => string | undefined;
  readonly typecheck: (directory: string) => void;
};

/**
 * A union only stands if every touched file still parses and formats, and each
 * owning package still typechecks. Format failure covers syntax errors.
 */
export const runUnionGate = (files: readonly string[], operations: UnionGateOperations): void => {
  operations.format(files);
  const directories = new Set<string>();
  for (const file of files) {
    const directory = operations.typecheckDirFor(file);
    if (directory !== undefined) directories.add(directory);
  }
  for (const directory of [...directories].sort()) operations.typecheck(directory);
};
