import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  PlanId,
  ThreadId,
  type PlanPublicationInput,
  type GiteaInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { PlanTaskLaunchInput } from "./PlanTaskLaunch.ts";
import { make } from "./PlanPublicationService.ts";
import type { RequestLedger } from "./RequestLedger.ts";

const instance: GiteaInstanceConfig = {
  id: "test",
  host: "git.test",
  sshAliases: [],
  sshPorts: [22],
  webOrigin: "https://git.test",
  apiOrigin: "http://api.test",
  token: "fake",
};
const threadId = ThreadId.make("publisher");
const input = {
  threadId,
  title: "Ship parser",
  owner: "Parser manager",
  source: {
    type: "markdown" as const,
    key: "parser-v2",
    markdown:
      "- Parse input <!-- task:parse -->\n  Owner: Parsing specialist\n  Reject invalid input.\n- Render output <!-- task:render -->",
  },
};
interface Issue {
  number: number;
  html_url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  kind?: string;
}
const decodeWriteBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ title: Schema.String, body: Schema.String })),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function harness() {
  const issues: Issue[] = [];
  const calls: string[] = [];
  const jobs: PlanTaskLaunchInput[] = [];
  let loseCreateAt: number | undefined;
  let creates = 0;
  let failPage: number | undefined;
  let pageSize = 100;
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1/repos/brad/tasks", "");
      calls.push(`${request.method} ${path}`);
      const body =
        request.body._tag === "Uint8Array"
          ? decodeWriteBody(new TextDecoder().decode(request.body.body))
          : { title: "", body: "" };
      const response = (status: number, data: unknown) =>
        HttpClientResponse.fromWeb(request, new Response(encodeJson(data), { status }));
      if (request.method === "GET" && path === "/issues") {
        const page = Number(url.searchParams.get("page"));
        return page === failPage
          ? response(500, {})
          : response(200, issues.slice((page - 1) * pageSize, page * pageSize));
      }
      if (request.method === "POST" && path === "/issues") {
        creates++;
        const number = issues.length + 1;
        const issue = {
          number,
          html_url: `https://git.test/brad/tasks/issues/${number}`,
          state: "open" as const,
          ...body,
        };
        issues.push(issue);
        return creates === loseCreateAt ? response(500, {}) : response(201, issue);
      }
      const number = Number(path.split("/").at(-1));
      const issue = issues.find((issue) => issue.number === number);
      if (!issue) return response(404, {});
      if (request.method === "PATCH") Object.assign(issue, body);
      return response(200, issue);
    }),
  );
  const ledger = {
    resolveThread: () =>
      Effect.succeed({
        target: { instance, host: "git.test", repository: "brad/tasks" },
        thread: { projectId: "project" },
        root: { id: threadId },
      }),
    update: (input: { reference: string; kind: string }) =>
      Effect.sync(() => {
        issues.find((issue) => issue.number === Number(input.reference.split("#").at(-1)))!.kind =
          input.kind;
        return {};
      }),
  } as unknown as RequestLedger;
  const publish = (source: PlanPublicationInput = input) =>
    make(ledger, (job) =>
      Effect.sync(() => {
        jobs.push(job);
        return ThreadId.make(`job-${job.task.key}`);
      }),
    ).pipe(
      Effect.flatMap((service) => service.publish(source)),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(ThreadManagementService, {
        getThreadRecords: () =>
          Effect.succeed({
            thread: { projectId: "project" },
            plans: [
              {
                id: PlanId.make("approved"),
                kind: "proposed_plan",
                status: "active",
                markdown: input.source.markdown,
              },
            ],
          }),
      } as never),
    );
  return {
    issues,
    calls,
    jobs,
    publish,
    loseCreate: (number: number) => {
      loseCreateAt = number;
    },
    failPage: (number: number) => {
      failPage = number;
    },
    capPageSize: (size: number) => {
      pageSize = size;
    },
  };
}

describe("approved plan publishing", () => {
  it.effect(
    "publishes an epic with owned task issues, updates on rerun, preserves completion and manual notes",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const first = yield* h.publish();
        expect(first.tasks.map((task) => task.owner)).toEqual([
          "Parsing specialist",
          "Parser manager",
        ]);
        expect(h.issues).toHaveLength(3);
        expect(h.issues.map((issue) => issue.kind)).toEqual(["epic", "task", "task"]);
        expect(h.issues[0]!.body).toContain("- [ ] #2 Parse input");
        expect(h.issues[1]!.body).toContain("Part of #1\nOwner: Parsing specialist");
        h.issues[1]!.state = "closed";
        h.issues[1]!.body += "\n\nKeep this manual note.";
        const second = yield* h.publish({
          ...input,
          source: {
            ...input.source,
            markdown: input.source.markdown.replace("Parse input", "Parse safely"),
          },
        });
        expect(second.tasks.map((task) => task.number)).toEqual(
          first.tasks.map((task) => task.number),
        );
        expect(h.issues).toHaveLength(3);
        expect(h.issues[1]!.title).toBe("Parse safely");
        expect(h.issues[1]!.body).toContain("Keep this manual note.");
        expect(h.issues[1]!.state).toBe("closed");
        expect(h.issues[0]!.body).toContain("- [x] #2 Parse safely");
      }),
  );
  it.effect(
    "recovers an accepted create with a lost response and concurrent reruns without duplicate issues",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.loseCreate(2);
        expect((yield* h.publish().pipe(Effect.flip))._tag).toBe("ProjectIssuesError");
        expect(h.issues).toHaveLength(2);
        const results = yield* Effect.all([h.publish(), h.publish()], { concurrency: "unbounded" });
        expect(h.issues).toHaveLength(3);
        expect(results[0]).toEqual(results[1]);
      }),
  );
  it.effect("publishes the stored proposed plan", () =>
    Effect.gen(function* () {
      const h = harness();
      const result = yield* h.publish({
        ...input,
        source: { type: "proposed_plan", threadId, planId: PlanId.make("approved") },
      });
      expect(result.tasks).toHaveLength(2);
      expect(h.issues).toHaveLength(3);
    }),
  );
  it.effect(
    "optionally starts owned task workers with stable issue and job identities on rerun",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const first = yield* h.publish({ ...input, createThreads: true });
        const second = yield* h.publish({ ...input, createThreads: true });
        expect(first.tasks.map((task) => task.threadId)).toEqual(["job-parse", "job-render"]);
        expect(second.tasks).toEqual(first.tasks);
        expect(h.jobs.every((job) => job.parentThreadId === threadId)).toBe(true);
        expect(h.jobs[0]!.identity).toBe(h.jobs[2]!.identity);
        expect(h.jobs[0]!.issue).toBe(first.tasks[0]!.url);
        expect(h.issues).toHaveLength(3);
      }),
  );
  it.effect(
    "finds existing tasks when Gitea caps the requested page size, without duplicating them",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const first = yield* h.publish();
        h.capPageSize(1);
        const second = yield* h.publish();
        expect(second.tasks).toEqual(first.tasks);
        expect(h.issues).toHaveLength(3);
      }),
  );
  it.effect("refuses ambiguous publication markers before updating any issue", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.publish();
      h.issues.push({ ...h.issues[1]!, number: 4 });
      h.calls.length = 0;
      expect((yield* h.publish().pipe(Effect.flip)).message).toContain("Several issues");
      expect(h.calls.some((call) => call.startsWith("POST") || call.startsWith("PATCH"))).toBe(
        false,
      );
    }),
  );
  it.effect("never creates from a partial paginated read", () =>
    Effect.gen(function* () {
      const h = harness();
      for (let number = 1; number <= 100; number++)
        h.issues.push({
          number,
          title: "Other",
          body: "",
          state: "open",
          html_url: `https://git.test/brad/tasks/issues/${number}`,
        });
      h.failPage(2);
      expect((yield* h.publish().pipe(Effect.flip)).message).toContain("HTTP 500");
      expect(h.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
      expect(h.issues).toHaveLength(100);
    }),
  );
});
