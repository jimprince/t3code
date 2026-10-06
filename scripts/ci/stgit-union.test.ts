// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { mergeInventoryStanzas, runUnionGate, unionAdditiveHunks } from "./lib/stgit-union.ts";

const conflict = (ours: string[], base: string[], theirs: string[]): string[] => [
  "<<<<<<< ours",
  ...ours,
  "||||||| base",
  ...base,
  "=======",
  ...theirs,
  ">>>>>>> theirs",
];

describe("unionAdditiveHunks", () => {
  it("keeps ours then theirs for every hunk with an empty base", () => {
    const text = [
      "head",
      ...conflict(["a"], [], ["b", "c"]),
      "middle",
      ...conflict(["d"], [], ["e"]),
      "tail",
      "",
    ].join("\n");
    const result = unionAdditiveHunks(text);
    assert.isTrue(result.ok);
    if (!result.ok) return;
    assert.strictEqual(result.text, "head\na\nb\nc\nmiddle\nd\ne\ntail\n");
    assert.deepEqual(result.hunks, [
      { line: 2, oursLines: 1, theirsLines: 2 },
      { line: 10, oursLines: 1, theirsLines: 1 },
    ]);
  });

  it("refuses the whole file when any hunk edits existing lines", () => {
    const text = [...conflict(["a"], [], ["b"]), ...conflict(["x"], ["old"], ["y"])].join("\n");
    const result = unionAdditiveHunks(text);
    assert.isFalse(result.ok);
    if (!result.ok) assert.include(result.reason, "non-empty base");
  });

  it("refuses text that is not diff3 style, has stray markers, or has no hunk", () => {
    assert.isFalse(unionAdditiveHunks("<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n").ok);
    assert.isFalse(unionAdditiveHunks("x\n>>>>>>> b\n").ok);
    assert.isFalse(unionAdditiveHunks("<<<<<<< a\nx\n||||||| b\n").ok);
    assert.isFalse(unionAdditiveHunks("plain\n").ok);
  });
});

const stanza = (name: string, extra = ""): string =>
  `[[patch]]\nname = "${name}"\nsubject = "feat: ${name}"\n${extra}roles = []\n`;
const inventory = (...stanzas: string[]): string => `schema = 2\n\n${stanzas.join("\n")}`;

describe("mergeInventoryStanzas", () => {
  const one = stanza("fork-one");
  const two = stanza("fork-two");
  const three = stanza("fork-three");
  const four = stanza("fork-four");

  it("round-trips the real inventory byte for byte", () => {
    const real = NodeFS.readFileSync(
      NodePath.resolve(
        NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        "../../docs/operations/fork-inventory.toml",
      ),
      "utf8",
    );
    const order = [...real.matchAll(/^name = "([^"]+)"$/gm)].map((match) => match[1] ?? "");
    const merged = mergeInventoryStanzas({ base: real, ours: real, theirs: real, order });
    assert.isTrue(merged.ok);
    if (merged.ok) assert.isTrue(merged.text === real);
  });

  it("adds stanzas inserted on both sides and orders them by the stack", () => {
    const merged = mergeInventoryStanzas({
      base: inventory(one),
      ours: inventory(one, three),
      theirs: inventory(one, two),
      order: ["fork-one", "fork-two", "fork-three"],
    });
    assert.isTrue(merged.ok);
    if (!merged.ok) return;
    assert.strictEqual(merged.text, inventory(one, two, three));
    assert.deepEqual(merged.added, ["fork-two"]);
    assert.deepEqual(merged.changed, []);
  });

  it("takes a stanza edited on one side only", () => {
    const edited = stanza("fork-one", 'note = "edited"\n');
    const merged = mergeInventoryStanzas({
      base: inventory(one, two),
      ours: inventory(one, stanza("fork-two", 'note = "ours"\n')),
      theirs: inventory(edited, two),
      order: ["fork-one", "fork-two"],
    });
    assert.isTrue(merged.ok);
    if (!merged.ok) return;
    assert.include(merged.text, 'note = "edited"');
    assert.include(merged.text, 'note = "ours"');
    assert.deepEqual(merged.changed, ["fork-one"]);
  });

  it("keeps decision tables with their stanza", () => {
    const decided = `${one}\n[[patch.decision]]\nid = "d"\nrationale = "r"\n`;
    const merged = mergeInventoryStanzas({
      base: inventory(one),
      ours: inventory(decided),
      theirs: inventory(one, four),
      order: ["fork-one", "fork-four"],
    });
    assert.isTrue(merged.ok);
    if (merged.ok) assert.strictEqual(merged.text, inventory(decided, four));
  });

  it("fails when both sides edit the same stanza differently", () => {
    const merged = mergeInventoryStanzas({
      base: inventory(one),
      ours: inventory(stanza("fork-one", 'note = "a"\n')),
      theirs: inventory(stanza("fork-one", 'note = "b"\n')),
      order: ["fork-one"],
    });
    assert.isFalse(merged.ok);
    if (!merged.ok) assert.include(merged.reason, "fork-one");
  });

  it("fails on a stanza without a name and on duplicate names", () => {
    assert.isFalse(
      mergeInventoryStanzas({
        base: inventory(one),
        ours: 'schema = 2\n\n[[patch]]\nsubject = "x"\n',
        theirs: inventory(one),
        order: [],
      }).ok,
    );
    assert.isFalse(
      mergeInventoryStanzas({
        base: inventory(one),
        ours: inventory(one, one),
        theirs: inventory(one),
        order: [],
      }).ok,
    );
  });
});

describe("runUnionGate", () => {
  const calls: string[] = [];
  const operations = (failOn?: string) => ({
    format: (files: readonly string[]) => {
      calls.push(`format ${files.join(",")}`);
      if (failOn === "format") throw new Error("format failed");
    },
    typecheckDirFor: (file: string) => (file.startsWith("apps/") ? file.split("/")[1] : undefined),
    typecheck: (directory: string) => {
      calls.push(`typecheck ${directory}`);
      if (failOn === "typecheck") throw new Error("typecheck failed");
    },
  });

  it("formats every file and typechecks each owning package once", () => {
    calls.length = 0;
    runUnionGate(["apps/web/a.ts", "apps/web/b.ts", "apps/server/c.ts", "docs/d.md"], operations());
    assert.deepEqual(calls, [
      "format apps/web/a.ts,apps/web/b.ts,apps/server/c.ts,docs/d.md",
      "typecheck server",
      "typecheck web",
    ]);
  });

  it("stops at the first failing stage", () => {
    calls.length = 0;
    assert.throws(() => runUnionGate(["apps/web/a.ts"], operations("format")));
    assert.deepEqual(calls, ["format apps/web/a.ts"]);
    assert.throws(() => runUnionGate(["apps/web/a.ts"], operations("typecheck")));
  });
});
