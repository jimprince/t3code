import { editIssueBody } from "./issueBody.ts";
import fixture from "./fixtures/request-order-gitea.json" with { type: "json" };
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { ThreadId, type ProjectIssue, type GiteaInstanceConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as RequestOrder from "./RequestOrder.ts";
import {
  RANK_GAP,
  replacePartOf,
  parseRankTrailer,
  parsePlacedByTrailer,
} from "./requestOrder.logic.ts";

const threadId = ThreadId.make("91f7453d-5d73-4fff-8240-8eabaa253e40");
const instance: GiteaInstanceConfig = {
  id: "test",
  host: "tracker.test",
  sshAliases: [],
  sshPorts: [],
  apiOrigin: "https://tracker.test",
  webOrigin: "https://tracker.test",
  token: "",
};
function fakeRepository(interfere = 0) {
  const rows = new Map(fixture.map((i) => [i.number, { ...i }]));
  rows.set(8, { number: 8, body: "Epic 8\n<!-- t3:rank 1024 -->", partOf: 0 });
  rows.set(9, { number: 9, body: "Epic 9\n<!-- t3:rank 2048 -->", partOf: 0 });
  const writes: number[] = [];
  const failures = new Set<number>();
  let refreshes = 0;
  const issue = (n: number): ProjectIssue => {
    const row = rows.get(n)!;
    return {
      host: "tracker.test",
      repository: "brad/test",
      number: n,
      title: `Task ${n}`,
      url: `https://tracker.test/brad/test/issues/${n}`,
      status: "pending",
      labels: ["ask", n === 8 || n === 9 ? "ask:epic" : "ask:task"],
      isRequest: true,
      requestSource: null,
      assignees: [],
      comments: 0,
      createdAt: "2026-10-14T00:00:00Z",
      updatedAt: "2026-10-14T00:00:00Z",
      closedAt: null,
      linkedThreadIds: [],
      stage: "requested",
      ...(row.partOf ? { partOf: row.partOf } : {}),
      rank: parseRankTrailer(row.body),
    };
  };
  const client = HttpClient.make((request) =>
    Effect.yieldNow.pipe(
      Effect.andThen(
        Effect.sync(() => {
          const number = Number(new URL(request.url).pathname.split("/").at(-1));
          const row = rows.get(number);
          if (!row) throw new Error(`Unexpected test URL ${request.url}`);
          if (request.method === "PATCH" && failures.has(number))
            return HttpClientResponse.fromWeb(request, new Response("{}", { status: 500 }));
          if (request.method === "PATCH") {
            if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON PATCH");
            row.body = JSON.parse(new TextDecoder().decode(request.body.body)).body;
            writes.push(number);
            if (interfere-- > 0)
              row.body = row.body.replace("- [ ] A step", "- [x] A step") + "\nConcurrent note";
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ state: "open", body: row.body }), {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    ),
  );
  const resolver = RequestOrder.RepositoryResolver.of({
    resolve: () => Effect.succeed({ host: "tracker.test", repository: "brad/test", instance }),
    actor: () => Effect.succeed({ kind: "agent", threadId, name: "Dashboard head" }),
    list: () => Effect.sync(() => [...rows.keys()].map(issue)),
    changed: () =>
      Effect.sync(() => {
        refreshes++;
      }),
  });
  const layer = RequestOrder.layer.pipe(
    Layer.provide(Layer.succeed(RequestOrder.RepositoryResolver, resolver)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  return {
    rows,
    client,
    writes,
    failures,
    layer,
    get refreshes() {
      return refreshes;
    },
  };
}
describe("RequestOrder through a fake Gitea adapter", () => {
  it.effect("preserves body edits on read-back retry and immediately refreshes", () => {
    const fake = fakeRepository(1);
    return Effect.gen(function* () {
      const service = yield* RequestOrder.RequestOrder;
      const result = yield* service.place({ threadId, reference: "1", place: { to: "bottom" } });
      expect(result).toEqual({ rank: 2048 + RANK_GAP, position: 2, workstream: 8 });
      expect(fake.writes).toEqual([1, 1]);
      expect(fake.rows.get(1)?.body).toContain("> Preserve this whitespace  ");
      expect(fake.rows.get(1)?.body).toContain("- [x] A step");
      expect(fake.rows.get(1)?.body).toContain("Concurrent note");
      expect(parsePlacedByTrailer(fake.rows.get(1)?.body)).toEqual({
        kind: "agent",
        threadId,
        name: "Dashboard head",
      });

      expect(fake.rows.get(3)?.body).toBe(fixture[2]?.body);
    }).pipe(Effect.provide(fake.layer));
  });
  it.effect("serializes same-repository moves, reading the preceding write", () => {
    const fake = fakeRepository();
    return Effect.gen(function* () {
      const service = yield* RequestOrder.RequestOrder;
      yield* Effect.all(
        [
          service.place({ threadId, reference: "1", place: { to: "bottom" } }),
          service.place({ threadId, reference: "2", place: { to: "bottom" } }),
        ],
        { concurrency: "unbounded" },
      );
      expect(parseRankTrailer(fake.rows.get(1)?.body)).toBe(2048 + RANK_GAP);
      expect(parseRankTrailer(fake.rows.get(2)?.body)).toBe(2048 + 2 * RANK_GAP);
      expect(fake.writes).toEqual([1, 2]);
    }).pipe(Effect.provide(fake.layer));
  });
  it.effect("renumbers only the affected workstream and preserves sibling attribution", () => {
    const fake = fakeRepository();
    fake.rows.get(1)!.body =
      "First\n<!-- t3:placed-by %7B%22kind%22%3A%22brad%22%7D -->\n<!-- t3:rank 10 -->";
    fake.rows.get(2)!.body = "Second\n<!-- t3:rank 11 -->";
    return Effect.gen(function* () {
      const service = yield* RequestOrder.RequestOrder;
      fake.rows.set(4, { number: 4, partOf: 8, body: "Moving item" });
      yield* service.place({ threadId, reference: "4", place: { to: "after", reference: "1" } });
      expect(fake.writes).toEqual([2, 4, 1]);
      expect(parseRankTrailer(fake.rows.get(1)?.body)).toBe(11 + RANK_GAP);
      expect(parseRankTrailer(fake.rows.get(4)?.body)).toBe(11 + 2 * RANK_GAP);
      expect(parseRankTrailer(fake.rows.get(2)?.body)).toBe(11 + 3 * RANK_GAP);
      expect(parsePlacedByTrailer(fake.rows.get(1)?.body)).toEqual({ kind: "brad" });
      expect(fake.rows.get(3)?.body).toBe(fixture[2]?.body);
      yield* service.place({ threadId, reference: "4", place: { to: "none" } });
      expect(parseRankTrailer(fake.rows.get(4)?.body)).toBeNull();
      expect(parsePlacedByTrailer(fake.rows.get(4)?.body)).toBeNull();
    }).pipe(Effect.provide(fake.layer));
  });
});

it.effect("serializes parent, attachment and order body writes without lost updates", () => {
  const fake = fakeRepository();
  const target = { host: "tracker.test", repository: "brad/test", instance };
  return Effect.gen(function* () {
    const service = yield* RequestOrder.RequestOrder;
    yield* Effect.all(
      [
        service.place({ threadId, reference: "1", place: { to: "bottom" } }),
        editIssueBody(target, 1, (body) => replacePartOf(body, 9)),
        editIssueBody(target, 1, (body) => `${body}\nAttachment link`),
      ],
      { concurrency: "unbounded" },
    );
    const body = fake.rows.get(1)!.body;
    expect(body).toMatch(/^Part of #9/);
    expect(body).toContain("Attachment link");
    expect(parseRankTrailer(body)).not.toBeNull();
    expect(parsePlacedByTrailer(body)?.kind).toBe("agent");
  }).pipe(Effect.provide(fake.layer), Effect.provideService(HttpClient.HttpClient, fake.client));
});

it.effect("a failed renumber preserves the existing sibling order", () => {
  const fake = fakeRepository();
  fake.rows.get(1)!.body = "First\n<!-- t3:rank 10 -->";
  fake.rows.get(2)!.body = "Second\n<!-- t3:rank 11 -->";
  fake.rows.set(4, { number: 4, partOf: 8, body: "Moving" });
  fake.failures.add(4);
  return Effect.gen(function* () {
    const service = yield* RequestOrder.RequestOrder;
    const result = yield* Effect.result(
      service.place({ threadId, reference: "4", place: { to: "after", reference: "1" } }),
    );
    expect(result._tag).toBe("Failure");
    expect(fake.writes).toEqual([2]);
    expect(parseRankTrailer(fake.rows.get(1)?.body)).toBeLessThan(
      parseRankTrailer(fake.rows.get(2)?.body)!,
    );
    expect(parseRankTrailer(fake.rows.get(4)?.body)).toBeNull();
  }).pipe(Effect.provide(fake.layer));
});

it.effect(
  "serializes concurrent batches against the same repository and refreshes once per batch",
  () => {
    const fake = fakeRepository();
    fake.rows.set(4, { number: 4, partOf: 8, body: "Fourth" });
    fake.rows.set(5, { number: 5, partOf: 8, body: "Fifth" });
    return Effect.gen(function* () {
      const service = yield* RequestOrder.RequestOrder;
      yield* Effect.all(
        [
          service.batch({ threadId, references: ["4"], actor: "brad", movedReference: "4" }),
          service.batch({ threadId, references: ["5"], actor: "brad" }),
        ],
        { concurrency: "unbounded" },
      );
      expect(parseRankTrailer(fake.rows.get(4)?.body)).toBe(2048 + RANK_GAP);
      expect(parseRankTrailer(fake.rows.get(5)?.body)).toBe(2048 + 2 * RANK_GAP);
      expect(parsePlacedByTrailer(fake.rows.get(4)?.body)).toEqual({ kind: "brad" });
      expect(parsePlacedByTrailer(fake.rows.get(5)?.body)).toBeNull();
      expect(fake.refreshes).toBe(2);
      expect(fake.writes).toEqual([4, 5]);
    }).pipe(Effect.provide(fake.layer));
  },
);

it.effect("refreshes a partially written batch once and reports failure", () => {
  const fake = fakeRepository();
  fake.rows.set(4, { number: 4, partOf: 8, body: "Fourth" });
  fake.rows.set(5, { number: 5, partOf: 8, body: "Fifth" });
  fake.failures.add(5);
  return Effect.gen(function* () {
    const service = yield* RequestOrder.RequestOrder;
    const failed = yield* Effect.flip(
      service.batch({ threadId, references: ["4", "5"], actor: "brad", movedReference: "5" }),
    );
    expect(failed.message).toContain("HTTP 500");
    expect(parseRankTrailer(fake.rows.get(4)?.body)).toBe(2048 + RANK_GAP);
    expect(parseRankTrailer(fake.rows.get(5)?.body)).toBeNull();
    expect(parsePlacedByTrailer(fake.rows.get(4)?.body)).toBeNull();
    expect(fake.refreshes).toBe(1);
  }).pipe(Effect.provide(fake.layer));
});
