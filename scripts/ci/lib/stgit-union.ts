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

type Stanza = {
  readonly raw: string;
  readonly key: string;
  readonly lastInSource: boolean;
};

type ParsedInventory = {
  readonly preamble: string;
  readonly stanzas: ReadonlyMap<string, Stanza>;
};

const stanzaHeader = /^\[\[patch\]\]$/m;

const normalizeStanza = (stanza: string): string => `${stanza.replace(/\s+$/, "")}\n`;

const parseInventory = (text: string): ParsedInventory => {
  const parts = text.split(stanzaHeader);
  const stanzas = new Map<string, Stanza>();
  for (const [index, part] of parts.slice(1).entries()) {
    const name = /^name = "([^"\n]+)"$/m.exec(part)?.[1];
    if (name === undefined) throw new Error("inventory stanza without a name");
    if (stanzas.has(name)) throw new Error(`inventory lists ${name} twice`);
    const lastInSource = index === parts.length - 2;
    const raw = `[[patch]]${part}`;
    stanzas.set(name, {
      raw: lastInSource ? normalizeStanza(raw) : raw,
      key: normalizeStanza(raw),
      lastInSource,
    });
  }
  return { preamble: parts[0] ?? "", stanzas };
};

export type InventoryMergeResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly added: readonly string[];
      readonly changed: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const threeWay = <T>(
  base: T,
  ours: T,
  theirs: T,
  same: (left: T, right: T) => boolean = (left, right) => left === right,
): { readonly value: T } | undefined => {
  if (same(ours, theirs)) return { value: ours };
  if (same(ours, base)) return { value: theirs };
  if (same(theirs, base)) return { value: ours };
  return undefined;
};

const sameStanza = (left: Stanza | undefined, right: Stanza | undefined): boolean =>
  left?.key === right?.key;

/**
 * Merges the fork inventory stanza by stanza. A stanza changed on one side
 * wins; the same stanza changed differently on both sides fails the merge.
 * Stanzas are emitted in `order` (the resulting stack); any stanza that is not
 * in the stack keeps its encounter order after the ordered ones so the stack
 * check, not this merge, reports it.
 */
export const mergeInventoryStanzas = (input: {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  readonly order: readonly string[];
}): InventoryMergeResult => {
  try {
    const base = parseInventory(input.base);
    const ours = parseInventory(input.ours);
    const theirs = parseInventory(input.theirs);
    const preamble = threeWay(base.preamble, ours.preamble, theirs.preamble);
    if (preamble === undefined)
      return { ok: false, reason: "inventory header changed on both sides" };
    const encountered = [...new Set([...ours.stanzas.keys(), ...theirs.stanzas.keys()])];
    const merged = new Map<string, Stanza>();
    const added: string[] = [];
    const changed: string[] = [];
    for (const name of encountered) {
      const resolved = threeWay(
        base.stanzas.get(name),
        ours.stanzas.get(name),
        theirs.stanzas.get(name),
        sameStanza,
      );
      if (resolved === undefined)
        return { ok: false, reason: `inventory stanza ${name} changed on both sides` };
      if (resolved.value === undefined) continue;
      merged.set(name, resolved.value);
      if (!ours.stanzas.has(name)) added.push(name);
      else if (!sameStanza(resolved.value, ours.stanzas.get(name))) changed.push(name);
    }
    const known = new Set(input.order);
    const ordered = [
      ...input.order.filter((name) => merged.has(name)),
      ...[...merged.keys()].filter((name) => !known.has(name)),
    ];
    return {
      ok: true,
      text:
        preamble.value +
        ordered
          .map((name, index) => {
            const stanza = merged.get(name);
            if (stanza === undefined) return "";
            if (index === ordered.length - 1) return normalizeStanza(stanza.raw);
            return stanza.lastInSource ? `${stanza.raw}\n` : stanza.raw;
          })
          .join(""),
      added,
      changed,
    };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
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
