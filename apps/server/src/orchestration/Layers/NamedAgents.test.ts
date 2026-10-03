import {
  NamedAgentName,
  type NamedAgentError,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationCommandInvariantError, type OrchestrationDispatchError } from "../Errors.ts";
import { NamedAgents } from "../Services/NamedAgents.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { NamedAgentsLive } from "./NamedAgents.ts";

const NOW = "2026-10-03T00:00:00.000Z";
const PROJECT = ProjectId.make("agent-printer");

/** A temporary agent folder with a charter and briefing, as Effect FileSystem writes it. */
const makeFolder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "named-agent-" });
  yield* fs.writeFileString(
    `${folder}/AGENT.md`,
    "---\nname: printer\nscope: The K1 printer and its print queue\nenvironment: dev-vm\n---\nOne bounded print action at a time.\n",
  );
  yield* fs.writeFileString(`${folder}/BRIEFING.md`, "Nozzle swapped to 0.6 mm.\n");
  return folder;
});

function snapshot(folder: string, threads: OrchestrationThreadShell[]): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT,
        title: "printer",
        workspaceRoot: folder,
        defaultModelSelection: null,
        scripts: [],
        permanentAgent: { name: NamedAgentName.make("printer") },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    threads,
    updatedAt: NOW,
  };
}

const liveThread = (id: string) =>
  ({
    id: ThreadId.make(id),
    projectId: PROJECT,
    archivedAt: null,
    parentThreadId: null,
  }) as unknown as OrchestrationThreadShell;

function harness(input: {
  readonly folder: string;
  readonly threads: () => OrchestrationThreadShell[];
  readonly onCreate?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, OrchestrationDispatchError>;
}) {
  const dispatched: OrchestrationCommand[] = [];
  const layer = NamedAgentsLive.pipe(
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.sync(() => snapshot(input.folder, input.threads())),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type === "thread.create" && input.onCreate) yield* input.onCreate(command);
            dispatched.push(command);
            return { sequence: dispatched.length };
          }),
      }),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(NodeServices.layer),
  );
  return { dispatched, layer };
}

/** Run `body` against a fresh agent folder and a NamedAgents layer over fakes. */
const withAgents = (
  options: Omit<Parameters<typeof harness>[0], "folder">,
  body: (context: {
    readonly folder: string;
    readonly dispatched: OrchestrationCommand[];
  }) => Effect.Effect<void, NamedAgentError, NamedAgents>,
) =>
  Effect.gen(function* () {
    const folder = yield* makeFolder;
    const { dispatched, layer } = harness({ folder, ...options });
    yield* body({ folder, dispatched }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("lists agents with their charter scope and live incarnation", () =>
  withAgents({ threads: () => [liveThread("printer-1")] }, ({ folder }) =>
    Effect.gen(function* () {
      const { agents } = yield* (yield* NamedAgents).list();
      expect(agents).toEqual([
        {
          name: "printer",
          projectId: PROJECT,
          workspaceRoot: folder,
          scope: "The K1 printer and its print queue",
          liveThreadId: "printer-1",
        },
      ]);
    }),
  ),
);

it.effect("starts a dormant agent with its charter, briefing and the request", () =>
  withAgents({ threads: () => [] }, ({ dispatched }) =>
    Effect.gen(function* () {
      const result = yield* (yield* NamedAgents).resolve({
        name: NamedAgentName.make("printer"),
        message: "Print bracket v3.",
      });
      expect(result.started).toBe(true);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.turn.start",
      ]);
      const first = dispatched[1] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
      expect(first.threadId).toBe(result.threadId);
      expect(first.message.text).toContain("One bounded print action at a time.");
      expect(first.message.text).toContain("Nozzle swapped to 0.6 mm.");
      expect(first.message.text).toContain("## Request\nPrint bracket v3.");
    }),
  ),
);

it.effect("routes to the live incarnation without starting another", () =>
  withAgents({ threads: () => [liveThread("printer-1")] }, ({ dispatched }) =>
    Effect.gen(function* () {
      const result = yield* (yield* NamedAgents).resolve({
        name: NamedAgentName.make("printer"),
        message: "Status?",
      });
      expect(result).toEqual({ threadId: "printer-1", started: false });
      expect(dispatched).toEqual([]);
    }),
  ),
);

it.effect("returns the winner when another caller started the agent first", () => {
  let threads: OrchestrationThreadShell[] = [];
  return withAgents(
    {
      threads: () => threads,
      onCreate: () => {
        threads = [liveThread("printer-winner")];
        return Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: "thread.create",
            detail: "Named agent 'printer' already has a live thread (printer-winner).",
          }),
        );
      },
    },
    () =>
      Effect.gen(function* () {
        const result = yield* (yield* NamedAgents).resolve({
          name: NamedAgentName.make("printer"),
        });
        expect(result).toEqual({ threadId: "printer-winner", started: false });
      }),
  );
});

it.effect("hands over from the live incarnation in one create command", () =>
  withAgents({ threads: () => [liveThread("printer-1")] }, ({ dispatched }) =>
    Effect.gen(function* () {
      const result = yield* (yield* NamedAgents).handOver({ name: NamedAgentName.make("printer") });
      expect(result.started).toBe(true);
      expect(dispatched[0]).toMatchObject({
        type: "thread.create",
        handoverFromThreadId: "printer-1",
      });
    }),
  ),
);

it.effect("names unknown agents in the error", () =>
  withAgents({ threads: () => [] }, () =>
    Effect.gen(function* () {
      const error = yield* (yield* NamedAgents)
        .resolve({ name: NamedAgentName.make("deploy") })
        .pipe(Effect.flip, Effect.orDie);
      expect(error.message).toBe("No named agent 'deploy' on this server.");
    }),
  ),
);
