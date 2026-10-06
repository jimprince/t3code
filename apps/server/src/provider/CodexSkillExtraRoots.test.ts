// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { resolveCodexSkillExtraRoots } from "./CodexSkillExtraRoots.ts";

it.effect(
  "expands the server home while preserving absolute path spelling, order and duplicates",
  () =>
    Effect.gen(function* () {
      const literal = NodePath.join(NodeOS.tmpdir(), "skills") + "/../skills";
      assert.deepEqual(yield* resolveCodexSkillExtraRoots([literal, "~/skills", literal]), [
        literal,
        NodePath.join(NodeOS.homedir(), "skills"),
        literal,
      ]);
      assert.deepEqual(yield* resolveCodexSkillExtraRoots(), []);
    }),
);
