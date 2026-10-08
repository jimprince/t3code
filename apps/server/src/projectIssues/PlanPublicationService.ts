import {
  ProjectIssuesError,
  type PlanPublicationInput,
  type PlanPublicationResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as GiteaApi from "../sourceControl/GiteaApi.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { PlanTaskLauncher } from "./PlanTaskLaunch.ts";
import type { RequestLedger } from "./RequestLedger.ts";
import {
  parsePlanTasks,
  publicationMarker,
  taskPublicationMarker,
} from "./planPublication.logic.ts";

const Issue = Schema.Struct({
  number: Schema.Int,
  html_url: Schema.String,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["open", "closed"]),
  pull_request: Schema.optional(Schema.Unknown),
});
type Issue = typeof Issue.Type;
const Issues = Schema.Array(Issue);
const publicationLock = Semaphore.makeUnsafe(1);
const fail = (message: string) => new ProjectIssuesError({ message });

/** Replace just our generated block, preserving notes people append to the issue. */
function managedBody(previous: string | null, marker: string, contents: string) {
  const end = marker.replace("<!-- ", "<!-- /");
  const block = `${marker}\n${contents}\n${end}`;
  if (!previous) return block;
  const start = previous.indexOf(marker);
  const finish = previous.indexOf(end, start + marker.length);
  if (start < 0 || finish < 0)
    throw new Error(
      "The published issue's managed block was edited; restore its markers before updating.",
    );
  return previous.slice(0, start) + block + previous.slice(finish + end.length);
}

/** Gitea remains the publication record, including recovery after a lost write response. */
export const make = Effect.fn("PlanPublicationService.make")(function* (
  ledger: RequestLedger,
  startTask?: PlanTaskLauncher,
) {
  const api = yield* GiteaApi.make;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const publish = Effect.fn("PlanPublicationService.publish")(function* (
    input: PlanPublicationInput,
  ) {
    const resolved = yield* ledger.resolveThread(input.threadId);
    if (!resolved) return yield* fail("The thread's project has no Gitea tracker repository.");
    const { target } = resolved;
    if (input.createThreads && !startTask)
      return yield* fail("Task thread creation is unavailable.");
    let markdown: string;
    let sourceKey: string;
    if (input.source.type === "markdown") {
      markdown = input.source.markdown;
      sourceKey = `markdown:${input.source.key}`;
    } else {
      const sourceInput = input.source;
      const source = yield* threads
        .getThreadRecords(input.source.threadId, ["plans"])
        .pipe(Effect.mapError(() => fail("Could not read the source plan.")));
      if (source.thread.projectId !== resolved.thread.projectId)
        return yield* fail("The plan must belong to this project.");
      const plan = source.plans.find((plan) => plan.id === sourceInput.planId);
      if (!plan || plan.kind !== "proposed_plan")
        return yield* fail("The proposed plan was not found.");
      if (plan.status === "superseded")
        return yield* fail("A superseded plan cannot be published.");
      markdown = plan.markdown;
      sourceKey = `plan:${input.source.threadId}:${input.source.planId}`;
    }
    const tasks = yield* Effect.try({
      try: () => parsePlanTasks(markdown, input.owner),
      catch: (error) => fail(String(error)),
    });
    const marker = publicationMarker(sourceKey);
    const repositoryPath = GiteaApi.repositoryPath(target.repository);
    const request = <S extends Schema.Top>(path: string, schema: S, body?: unknown) =>
      api
        .request(target.instance, path, schema, body)
        .pipe(Effect.mapError((error) => fail(error.detail)));
    const send = (path: string, body: unknown) =>
      api
        .send(target.instance, "PATCH", path, body)
        .pipe(Effect.mapError((error) => fail(error.detail)));
    const wantedMarkers = new Set([
      marker,
      ...tasks.map((task) => taskPublicationMarker(marker, task.key)),
    ]);
    const issues: Issue[] = [];
    // Read every page before deciding a publication is absent. Partial reads never permit writes.
    for (let page = 1; ; page++) {
      if (page > 1000) return yield* fail("The tracker is too large to publish safely.");
      const batch = yield* request(
        `${repositoryPath}/issues?state=all&type=issues&limit=100&page=${page}`,
        Issues,
      );
      issues.push(
        ...batch.filter(
          (issue) =>
            issue.pull_request == null &&
            issue.body?.split(/\r?\n/).some((line) => wantedMarkers.has(line)),
        ),
      );
      // The server may cap page size below our requested limit. Only an empty page proves the end.
      if (batch.length === 0) break;
    }
    const find = (wanted: string) => {
      const matches = issues.filter((issue) => issue.body?.split(/\r?\n/).includes(wanted));
      if (matches.length > 1)
        throw new Error(
          "Several issues carry the same publication marker; reconcile them before publishing.",
        );
      return matches[0];
    };
    // Check every identity and managed block before creating or updating anything.
    yield* Effect.try({
      try: () => {
        for (const wanted of [
          marker,
          ...tasks.map((task) => taskPublicationMarker(marker, task.key)),
        ]) {
          const existing = find(wanted);
          if (existing) managedBody(existing.body, wanted, "");
        }
      },
      catch: (error) => fail(String(error)),
    });
    const save = Effect.fnUntraced(function* (
      wanted: string,
      title: string,
      contents: string,
      kind: "epic" | "task",
    ) {
      const existing = yield* Effect.try({
        try: () => find(wanted),
        catch: (error) => fail(String(error)),
      });
      const body = yield* Effect.try({
        try: () => managedBody(existing?.body ?? null, wanted, contents),
        catch: (error) => fail(String(error)),
      });
      let issue: Issue;
      if (existing) {
        yield* send(`${repositoryPath}/issues/${existing.number}`, { title, body });
        issue = yield* request(`${repositoryPath}/issues/${existing.number}`, Issue);
      } else {
        issue = yield* request(`${repositoryPath}/issues`, Issue, { title, body });
      }
      const index = issues.findIndex((candidate) => candidate.number === issue.number);
      if (index < 0) issues.push(issue);
      else issues[index] = issue;
      yield* ledger.update({
        threadId: input.threadId,
        reference: `${target.repository}#${issue.number}`,
        kind,
      });
      return issue;
    });
    const epic = yield* save(marker, input.title, `Owner: ${input.owner}\n\n${markdown}`, "epic");
    const published: PlanPublicationResult["tasks"][number][] = [];
    for (const task of tasks) {
      const issue = yield* save(
        taskPublicationMarker(marker, task.key),
        task.title,
        `Part of #${epic.number}\nOwner: ${task.owner}\n\n${task.detail}`,
        "task",
      );
      const threadId =
        input.createThreads && issue.state !== "closed"
          ? yield* startTask!({
              parentThreadId: resolved.root.id,
              identity: `${target.host}/${target.repository}/${sourceKey}/${task.key}`,
              task,
              issue: `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${issue.number}`,
            })
          : undefined;
      published.push({
        ...(threadId === undefined ? {} : { threadId }),
        key: task.key,
        title: task.title,
        owner: task.owner,
        number: issue.number,
        url: `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${issue.number}`,
      });
    }
    const checklist = published
      .map(
        (task) =>
          `- [${issues.find((issue) => issue.number === task.number)?.state === "closed" ? "x" : " "}] #${task.number} ${task.title}`,
      )
      .join("\n");
    yield* save(
      marker,
      input.title,
      `Owner: ${input.owner}\n\n${markdown}\n\n## Tasks\n${checklist}`,
      "epic",
    );
    return {
      epic: {
        number: epic.number,
        url: `${target.instance.webOrigin.replace(/\/$/, "")}/${target.repository}/issues/${epic.number}`,
      },
      tasks: published,
    } satisfies PlanPublicationResult;
  }, publicationLock.withPermits(1));
  return { publish };
});
