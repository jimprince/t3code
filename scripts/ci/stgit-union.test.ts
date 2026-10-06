// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { runUnionGate, unionAdditiveHunks } from "./lib/stgit-union.ts";

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
