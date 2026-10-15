import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";
import { layerMemory } from "../persistence/Sqlite.ts";
import { makeSubheadRegistry } from "./SubheadRegistry.ts";
import { validateNaming } from "./NamedAgentPolicy.ts";

const template = {
  name: "review",
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make("head"),
  description: "Reviews changes",
  prompt: "Review the request and return findings.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "approval-required" as const,
  concurrency: 1,
};

it.layer(NodeServices.layer)("virtual registry", (it) => {
  it.effect("requires the creator for mutations and keeps execution ownership immutable", () =>
    Effect.gen(function* () {
      const registry = yield* makeSubheadRegistry;
      yield* registry.create(template, "creator");
      expect(
        yield* registry.edit("review", template, 1, "other").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* registry.setState("review", "enable", "other").pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* registry
          .edit("review", { ...template, ownerThreadId: ThreadId.make("other-head") }, 1, "creator")
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* registry
          .edit("review", { ...template, projectId: ProjectId.make("other-project") }, 1, "creator")
          .pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect((yield* registry.setState("review", "enable", "creator")).enabled).toBe(true);
    }).pipe(Effect.provide(layerMemory)),
  );
  it.effect("creates several disabled names per project and retains immutable revisions", () =>
    Effect.gen(function* () {
      const registry = yield* makeSubheadRegistry;
      const first = yield* registry.create(template);
      yield* registry.create({ ...template, name: "audit" });
      expect(first).toMatchObject({ kind: "virtual", version: 1, enabled: false });
      expect(yield* registry.list(false)).toHaveLength(2);
      const edited = yield* registry.edit("review", { ...template, prompt: "New prompt" }, 1);
      expect(edited.version).toBe(2);
      expect((yield* registry.revision(first.id, 1)).prompt).toBe(template.prompt);
      expect(yield* registry.edit("review", template, 1).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("version"),
      });
    }).pipe(Effect.provide(layerMemory)),
  );
  it.effect("reserves retired names and rejects standing-agent collisions both ways", () =>
    Effect.gen(function* () {
      const registry = yield* makeSubheadRegistry;
      yield* registry.create(template);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* validateNaming(sql, ProjectId.make("standing"), "review").pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("virtual") });
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at,permanent_agent_json) VALUES ('standing','Standing','/tmp','[]','2026-10-15T00:00:00Z','2026-10-15T00:00:00Z','{"name":"printer"}')`;
      expect(
        yield* registry.create({ ...template, name: "printer" }).pipe(Effect.flip),
      ).toMatchObject({ message: expect.stringContaining("exists") });
      yield* registry.setState("review", "retire");
      expect(yield* registry.list(false)).toEqual([]);
      expect(yield* registry.list(true)).toHaveLength(1);
      expect(yield* registry.create(template).pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("exists"),
      });
      expect(yield* registry.setState("review", "enable").pipe(Effect.flip)).toMatchObject({
        message: expect.stringContaining("retired"),
      });
    }).pipe(Effect.provide(layerMemory)),
  );
  it.effect(
    "concurrent edits have one winner and reject unsupported prompt-only restrictions",
    () =>
      Effect.gen(function* () {
        const registry = yield* makeSubheadRegistry;
        yield* registry.create(template);
        const attempts = yield* Effect.all(
          [
            registry.edit("review", { ...template, prompt: "A" }, 1).pipe(Effect.result),
            registry.edit("review", { ...template, prompt: "B" }, 1).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(attempts.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect((yield* registry.get("review")).version).toBe(2);
        expect(
          yield* registry
            .create({ ...template, name: "restricted", toolAllowlist: ["read"] })
            .pipe(Effect.flip),
        ).toMatchObject({ message: expect.any(String) });
      }).pipe(Effect.provide(layerMemory)),
  );
});
