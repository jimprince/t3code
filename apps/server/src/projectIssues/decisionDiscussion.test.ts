import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type GiteaInstanceConfig,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { DecisionsToolkitHandlersLive } from "../mcp/toolkits/decisions/handlers.ts";
import { DecisionsToolkit } from "../mcp/toolkits/decisions/tools.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadIssueService from "../orchestration/ThreadIssueService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ProjectIssuesService from "./ProjectIssuesService.ts";
import * as RequestLedger from "./RequestLedger.ts";

const NOW = "2026-10-06T00:00:00.000Z";
const REPO = "brad/t3code-fork";
const ISSUE_URL = (number: number) => `http://git.home:3000/${REPO}/issues/${number}`;
const instance: GiteaInstanceConfig = {
  id: "home",
  host: "git.home",
  sshAliases: [],
  sshPorts: [2222],
  webOrigin: "http://git.home:3000",
  apiOrigin: "http://git.home:3000",
  token: "",
};
const project = {
  id: "project",
  title: "t3code-fork",
  workspaceRoot: "/repo",
  repositoryIdentity: {
    provider: "gitea",
    canonicalKey: "git.home/brad/t3code-fork",
    locator: { remoteUrl: "ssh://git@git.home:2222/brad/t3code-fork.git" },
  },
};
const opus = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

interface ShellThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly parentThreadId: ThreadId | null;
  readonly archivedAt: string | null;
  readonly modelSelection?: typeof opus;
  readonly issues?: ReadonlyArray<{
    host: string;
    repository: string;
    number: number;
    url: string;
    linkedAt: string;
    snapshot: { title: string; state: string; syncedAt: string };
  }>;
}

const thread = (input: ShellThread) => ({
  projectId: "project",
  modelSelection: sol,
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: NOW,
  updatedAt: NOW,
  issues: [],
  ...input,
});

const ROOT = ThreadId.make("root");
const OWNER = ThreadId.make("owner");
const WORKER = ThreadId.make("worker");
const baseThreads = [
  thread({ id: ROOT, title: "T3 Orchestrator", parentThreadId: null, archivedAt: null }),
  thread({
    id: OWNER,
    title: "End Effector Orchestrator",
    parentThreadId: ROOT,
    archivedAt: null,
    modelSelection: opus,
  }),
  thread({
    id: WORKER,
    title: "Gripper worker",
    parentThreadId: ROOT,
    archivedAt: null,
    modelSelection: opus,
    issues: [
      {
        host: "git.home:3000",
        repository: REPO,
        number: 7,
        url: ISSUE_URL(7),
        linkedAt: NOW,
        snapshot: { title: "Plan the jaw rework", state: "open", syncedAt: NOW },
      },
    ],
  }),
];

const decisionBody = (waiting: string) =>
  [
    "12 V is decided. The orchestrator recommends spring pins on flat pads.",
    "",
    "```decision",
    `waiting: ${waiting}`,
    "options:",
    "- Spring pins to flat pads [recommended]",
    "- Magnetic pogo pairs instead",
    "```",
  ].join("\n");

/** Gitea issue #4 is a needs-brad decision; #7 is a Needs you item whose latest comment lists options. */
function giteaIssue(number: number, body: string) {
  return {
    number,
    title:
      number === 4
        ? "Tool changer: how should power and signals pass through?"
        : "Plan the jaw rework",
    body,
    state: "open",
    html_url: ISSUE_URL(number),
    labels: number === 4 ? [{ id: 9, name: "needs-brad" }] : [{ id: 3, name: "needs-review" }],
    comments: 1,
    created_at: NOW,
    updated_at: NOW,
  };
}

/** A recording fake of the Gitea API and the orchestration engine, over the real ledger. */
const makeHarness = (options: {
  readonly waiting?: string;
  readonly threads?: ReadonlyArray<ReturnType<typeof thread>>;
}) =>
  Effect.gen(function* () {
    const threads = options.threads ?? baseThreads;
    const issues = [giteaIssue(4, decisionBody(options.waiting ?? "owner")), giteaIssue(7, "")];
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const commands: OrchestrationCommand[] = [];
    let uuid = 0;
    const json = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0], value: unknown) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(value))));
    const http = HttpClient.make((request) => {
      const url = new URL(request.url);
      const path = url.pathname.replace("/api/v1", "");
      if (request.method !== "GET") {
        const body =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : null;
        writes.push({ method: request.method, path, body });
        return json(request, {});
      }
      if (path.endsWith("/labels")) return json(request, [{ id: 9, name: "needs-brad" }]);
      if (path.endsWith("/comments")) {
        return json(request, [
          {
            body: "Ready for your call.\nOption A: Rework the jaw now\nOption B: Wait for the scale test",
            created_at: NOW,
            user: { login: "agent" },
          },
        ]);
      }
      const single = /\/issues\/(\d+)$/.exec(path);
      if (single)
        return json(
          request,
          issues.find((issue) => issue.number === Number(single[1])),
        );
      if (path.endsWith("/issues")) {
        return json(request, url.searchParams.get("state") === "open" ? issues : []);
      }
      return json(request, []);
    });
    const services = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed({ threads, projects: [project] } as never),
        getThreadShellById: (id) =>
          Effect.succeed(
            Option.fromNullishOr(threads.find((candidate) => candidate.id === id)) as never,
          ),
        getProjectShellById: () => Effect.succeed(Option.some(project) as never),
      }),
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        dispatch: (command) => {
          commands.push(command);
          return Effect.succeed({ sequence: commands.length });
        },
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
      Layer.succeed(HttpClient.HttpClient, http),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(++uuid % 256),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
      ServerSettingsService.layerTest({ giteaInstances: [instance] }),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-decision-discuss-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    // Built into the test's scope, so the temporary state directory outlives each call.
    const context = yield* Layer.build(services);

    // Built as ws.ts builds it for a client connection.
    const ledger = yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return yield* RequestLedger.make({
        projectIssues: yield* ProjectIssuesService.make,
        threadIssues: yield* ThreadIssueService.make,
        dispatch: engine.dispatch,
      });
    }).pipe(Effect.provide(context));

    const toolkit = yield* DecisionsToolkit.pipe(
      Effect.provide(
        DecisionsToolkitHandlersLive.pipe(Layer.provide(Layer.succeedContext(context))),
      ),
    );
    const callTool = <Name extends keyof typeof DecisionsToolkit.tools>(
      name: Name,
      params: Parameters<typeof toolkit.handle<Name>>[1],
    ) =>
      toolkit.handle(name, params).pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map(
          (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof DecisionsToolkit.tools)[Name]>,
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment"),
          // The calling agent is the discussion thread, under the waiting thread.
          threadId: OWNER,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("claude"),
          capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests"]),
          issuedAt: 1,
        }),
        Effect.provide(context),
      );
    return { ledger, callTool, writes, commands };
  });

const turnStarts = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.turn.start"
      ? [{ threadId: command.threadId, text: command.message.text }]
      : [],
  );

describe("discussing a decision", () => {
  it.effect("opens a seeded thread nested under the waiting thread, with its model", () =>
    Effect.gen(function* () {
      const { ledger, commands, writes } = yield* makeHarness({});
      const result = yield* ledger.discuss({ threadId: ROOT, reference: `${REPO}#4` });

      expect(result.created).toBe(true);
      const [create, seed] = commands;
      expect(create).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        parentThreadId: OWNER,
        projectId: "project",
        modelSelection: opus,
        title: "Discuss #4: Tool changer: how should power and signals pass through?",
      });
      expect(seed).toMatchObject({ type: "thread.turn.start", threadId: result.threadId });
      const text = seed?.type === "thread.turn.start" ? seed.message.text : "";
      expect(text).toContain("Question: Tool changer: how should power and signals pass through?");
      expect(text).toContain("12 V is decided.");
      expect(text).toContain("- Spring pins to flat pads (recommended)");
      expect(text).toContain("- Magnetic pogo pairs instead\n");
      expect(text).toContain(ISSUE_URL(4));
      expect(text).toContain(`t3-thread decision answer root ${REPO}#4 --option`);
      // Opening a discussion answers nothing: the decision stays on the widget.
      expect(writes).toEqual([]);
    }),
  );

  it.effect("reuses a live discussion and starts a new one once it is archived", () =>
    Effect.gen(function* () {
      const discussion = (archivedAt: string | null) =>
        thread({
          id: ThreadId.make("discussion"),
          title: "Discuss #4: Tool changer: how should power and signals pass through?",
          parentThreadId: OWNER,
          archivedAt,
        });

      const live = yield* makeHarness({ threads: [...baseThreads, discussion(null)] });
      expect(yield* live.ledger.discuss({ threadId: ROOT, reference: "4" })).toEqual({
        threadId: "discussion",
        created: false,
      });
      expect(live.commands).toEqual([]);

      const archived = yield* makeHarness({ threads: [...baseThreads, discussion(NOW)] });
      const reopened = yield* archived.ledger.discuss({ threadId: ROOT, reference: "4" });
      expect(reopened.created).toBe(true);
      expect(reopened.threadId).not.toBe("discussion");
    }),
  );

  it.effect("falls back to the orchestrator when the waiting thread cannot be found", () =>
    Effect.gen(function* () {
      const { ledger, commands } = yield* makeHarness({ waiting: "someone-long-gone" });
      yield* ledger.discuss({ threadId: ROOT, reference: `${REPO}#4` });
      expect(commands[0]).toMatchObject({
        type: "thread.create",
        parentThreadId: ROOT,
        modelSelection: sol,
      });
    }),
  );

  it.effect("nests a Needs you item under the thread its decision would tell", () =>
    Effect.gen(function* () {
      const { ledger, commands } = yield* makeHarness({});
      yield* ledger.discuss({ threadId: ROOT, reference: `${REPO}#7` });
      expect(commands[0]).toMatchObject({ type: "thread.create", parentThreadId: WORKER });
      const [seed] = turnStarts(commands);
      expect(seed?.text).toContain("Option A: Rework the jaw now");
      expect(seed?.text).toContain(`t3-thread decision answer root ${REPO}#7 --approve`);
      expect(seed?.text).toContain(`t3-thread decision answer root ${REPO}#7 --not-yet`);
    }),
  );
});

describe("answering a decision as an agent", () => {
  it.effect("decision_answer leaves exactly the widget's comment, label change and message", () =>
    Effect.gen(function* () {
      const widget = yield* makeHarness({});
      yield* widget.ledger.decide({
        threadId: ROOT,
        reference: `${REPO}#4`,
        decision: "option",
        option: "Spring pins to flat pads",
        reason: "Cheapest to test first",
      });

      const agent = yield* makeHarness({});
      const result = yield* agent.callTool("decision_answer", {
        threadId: ROOT,
        reference: `${REPO}#4`,
        decision: "option",
        option: "Spring pins to flat pads",
        note: "Cheapest to test first",
      });

      expect(result).toEqual({ notifiedThreadId: OWNER });
      expect(agent.writes).toEqual([
        {
          method: "POST",
          path: `/repos/${REPO}/issues/4/comments`,
          body: { body: "Brad chose: Spring pins to flat pads\n\nCheapest to test first" },
        },
        { method: "DELETE", path: `/repos/${REPO}/issues/4/labels/9`, body: null },
      ]);
      expect(agent.writes).toEqual(widget.writes);
      expect(turnStarts(agent.commands)).toEqual(turnStarts(widget.commands));
      expect(turnStarts(agent.commands)[0]?.threadId).toBe(OWNER);
    }),
  );
});
