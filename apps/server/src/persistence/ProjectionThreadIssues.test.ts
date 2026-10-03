import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { ProjectionThreadIssueRepository, layer } from "./ProjectionThreadIssues.ts";

const repositoryLayer = it.layer(layer.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

repositoryLayer("ProjectionThreadIssueRepository", (it) => {
  it.effect("round-trips, normalizes, updates, and deletes issue links", () =>
    Effect.gen(function* () {
      const issues = yield* ProjectionThreadIssueRepository;
      const threadId = ThreadId.make("thread-issues");
      const linkedAt = "2026-10-03T00:00:00.000Z";
      const base = {
        threadId,
        host: "GIT.BRADLEYPRINCE.COM",
        repository: "BRAD/T3CODE-FORK",
        number: 73,
        url: "https://git.bradleyprince.com/brad/t3code-fork/issues/73",
        linkedAt,
        snapshot: { title: "Show linked issues", state: "open" as const, syncedAt: linkedAt },
      };
      yield* issues.upsert(base);
      yield* issues.upsert({
        ...base,
        snapshot: { ...base.snapshot, title: "Show Gitea issue links", state: "closed" },
      });

      assert.deepStrictEqual(yield* issues.listByThreadId({ threadId }), [
        {
          ...base,
          host: "git.bradleyprince.com",
          repository: "brad/t3code-fork",
          snapshot: { ...base.snapshot, title: "Show Gitea issue links", state: "closed" },
        },
      ]);

      yield* issues.delete({
        threadId,
        host: base.host,
        repository: base.repository,
        number: base.number,
      });
      assert.deepStrictEqual(yield* issues.listByThreadId({ threadId }), []);
    }),
  );
});
