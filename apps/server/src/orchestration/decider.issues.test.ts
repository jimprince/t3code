import {
  OrchestrationCommand,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-10-03T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationCommand);

const link: ThreadIssueLink = {
  host: "git.bradleyprince.com",
  repository: "brad/t3code-fork",
  number: 73,
  url: "https://git.bradleyprince.com/brad/t3code-fork/issues/73",
  linkedAt: NOW,
  snapshot: { title: "Show linked issues", state: "open", syncedAt: NOW },
};

function readModel(issues: readonly ThreadIssueLink[] = []): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "T3 Code",
        workspaceRoot: "/repo",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Issue work",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        issues,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

function eventOf<Type extends OrchestrationEvent["type"]>(
  decided: Omit<OrchestrationEvent, "sequence"> | readonly Omit<OrchestrationEvent, "sequence">[],
  type: Type,
) {
  const event = Array.isArray(decided) ? decided[0] : decided;
  expect(event?.type).toBe(type);
  return event as Omit<Extract<OrchestrationEvent, { type: Type }>, "sequence">;
}

it.layer(NodeServices.layer)("thread issue links", (it) => {
  it.effect("links and unlinks through events and projection", () =>
    Effect.gen(function* () {
      let model = readModel();
      const linkCommand = yield* decodeCommand({
        type: "thread.issue.link",
        commandId: "link-issue",
        threadId: THREAD_ID,
        link,
      });
      const linked = eventOf(
        yield* decideOrchestrationCommand({ readModel: model, command: linkCommand }),
        "thread.issue-linked",
      );
      model = yield* projectEvent(model, { ...linked, sequence: 1 });
      expect(model.threads[0]?.issues).toEqual([link]);

      const syncedSnapshot = {
        title: "Updated issue title",
        state: "closed" as const,
        syncedAt: "2026-10-03T00:01:00.000Z",
      };
      const syncCommand = yield* decodeCommand({
        type: "thread.issue.sync",
        commandId: "sync-issue",
        threadId: THREAD_ID,
        host: link.host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        snapshot: syncedSnapshot,
      });
      const synced = eventOf(
        yield* decideOrchestrationCommand({ readModel: model, command: syncCommand }),
        "thread.issue-synced",
      );
      model = yield* projectEvent(model, { ...synced, sequence: 2 });
      expect(model.threads[0]?.issues).toEqual([{ ...link, snapshot: syncedSnapshot }]);

      const unlinkCommand = yield* decodeCommand({
        type: "thread.issue.unlink",
        commandId: "unlink-issue",
        threadId: THREAD_ID,
        host: link.host,
        repository: link.repository,
        number: link.number,
      });
      const unlinked = eventOf(
        yield* decideOrchestrationCommand({ readModel: model, command: unlinkCommand }),
        "thread.issue-unlinked",
      );
      model = yield* projectEvent(model, { ...unlinked, sequence: 3 });
      expect(model.threads[0]?.issues).toEqual([]);
    }),
  );

  it.effect("normalizes identity and rejects a duplicate", () =>
    Effect.gen(function* () {
      const command = yield* decodeCommand({
        type: "thread.issue.link",
        commandId: "duplicate",
        threadId: THREAD_ID,
        link: { ...link, host: link.host.toUpperCase(), repository: "BRAD/T3CODE-FORK" },
      });
      const error = yield* decideOrchestrationCommand({
        readModel: readModel([link]),
        command,
      }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
});
