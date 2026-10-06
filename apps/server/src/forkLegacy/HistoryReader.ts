import {
  LegacyHistoryError,
  type LegacyHistoryInput,
  type LegacyHistoryResult,
  type LegacyHistorySection,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import {
  initializeTransferHistory,
  readTransferHistory,
} from "../forkThreads/TransferHistoryStore.ts";

type Sections = Record<LegacyHistorySection, Array<Record<string, unknown>>>;
const historicalPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const records = (value: unknown) => (Array.isArray(value) ? value.filter(Predicate.isObject) : []);
/** Historical identities are preserved here; none enter V2's restore/checkpoint stores. */
export function historySections(raw: Record<string, unknown>): Sections {
  const sections: Sections = {
    thread: records(raw.legacyThreads),
    messages: records(raw.legacyMessages),
    turns: [
      ...records(raw.legacyTurns),
      ...records(raw.legacyThreadCheckpoints),
      ...records(raw.legacyCheckpoints),
    ],
    diffs: records(raw.legacyDiffs),
    tools: records(raw.legacyActivities),
    plans: records(raw.legacyPlans),
    goals: records(raw.legacyGoals),
    events: records(raw.legacyEvents),
    provenance: [],
  };
  for (const thread of sections.thread) {
    if (thread.goal_json !== undefined && thread.goal_json !== null)
      sections.goals.push({ threadId: thread.thread_id, goalJson: thread.goal_json });
  }
  for (const activity of sections.tools) {
    if (activity.kind === "thread.forked") {
      const decoded =
        typeof activity.payload_json === "string"
          ? historicalPayload(activity.payload_json)
          : Option.none();
      sections.provenance.push({
        activityId: activity.activity_id,
        kind: activity.kind,
        payload: Option.isSome(decoded) ? decoded.value : activity.payload_json,
      });
    }
  }
  if (Predicate.isObject(raw.legacyBundle)) {
    const thread = raw.legacyBundle.thread;
    if (Predicate.isObject(thread)) {
      sections.thread.push(thread);
      sections.messages.push(...records(thread.messages));
      sections.turns.push(...records(thread.checkpoints));
      sections.tools.push(...records(thread.activities));
      sections.plans.push(...records(thread.proposedPlans));
      if (thread.goal !== undefined && thread.goal !== null)
        sections.goals.push({ goal: thread.goal });
      sections.provenance.push({
        legacyBundleVersion: raw.legacyBundle.version,
        sourceProjectId: raw.legacyBundle.sourceProjectId,
        sourceWorkspaceRoot: raw.legacyBundle.sourceWorkspaceRoot,
        providerSession: raw.legacyBundle.providerSession,
      });
    }
  }
  appendTransferEvidence(sections, raw);
  for (const prior of records(raw.previousTransfers)) appendTransferEvidence(sections, prior);
  return sections;
}
function appendTransferEvidence(sections: Sections, raw: Record<string, unknown>): void {
  if (Predicate.isObject(raw.nativeProjection)) {
    const projection = raw.nativeProjection;
    if (Predicate.isObject(projection.thread)) sections.thread.push(projection.thread);
    sections.messages.push(...records(projection.messages));
    sections.turns.push(...records(projection.checkpoints));
    sections.tools.push(...records(projection.turnItems));
    sections.plans.push(...records(projection.plans));
    sections.provenance.push({
      sourceThread: projection.thread,
      contextTransfers: projection.contextTransfers,
    });
  }
  if (raw.sourceMetadata !== undefined) sections.provenance.push({ metadata: raw.sourceMetadata });
  if (raw.attachmentMap !== undefined)
    sections.provenance.push({ attachmentMap: raw.attachmentMap });
}
export class HistoryReader extends Context.Service<
  HistoryReader,
  {
    readonly get: (
      input: LegacyHistoryInput,
    ) => Effect.Effect<LegacyHistoryResult, LegacyHistoryError>;
  }
>()("t3/forkLegacy/HistoryReader") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* Projections.ProjectionStoreV2;
  const legacyHistory = yield* Threads.LegacyHistoryAccess;
  const get = Effect.fn("HistoryReader.get")(function* (input: LegacyHistoryInput) {
    yield* initializeTransferHistory(sql);
    let sourceThreadId = input.threadId;
    const seen = new Set<ThreadId>();
    let sections: Sections;
    while (true) {
      if (seen.has(sourceThreadId))
        return yield* new LegacyHistoryError({
          threadId: input.threadId,
          cause: "Historical lineage contains a cycle.",
        });
      seen.add(sourceThreadId);
      const shell = yield* projections.getThreadShell(sourceThreadId);
      if (shell === null)
        return yield* new LegacyHistoryError({
          threadId: input.threadId,
          cause: "Thread is missing.",
        });
      const transferred = yield* readTransferHistory(sql, sourceThreadId);
      const legacy = yield* legacyHistory.read(sourceThreadId);
      sections = historySections({ ...transferred, ...legacy });
      if (
        Object.values(sections).some((rows) => rows.length > 0) ||
        shell.lineage.relationshipToParent !== "fork" ||
        shell.lineage.parentThreadId === null
      )
        break;
      sourceThreadId = shell.lineage.parentThreadId;
    }
    const section = input.section ?? "thread";
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    const rows = sections[section];
    return {
      threadId: input.threadId,
      sourceThreadId,
      readOnly: true as const,
      restoreAllowed: false as const,
      sections: (Object.keys(sections) as Array<LegacyHistorySection>).filter(
        (key) => sections[key].length > 0,
      ),
      section,
      records: rows.slice(offset, offset + limit),
      nextOffset: offset + limit < rows.length ? offset + limit : null,
    };
  });
  return HistoryReader.of({
    get: (input) =>
      get(input).pipe(
        Effect.mapError((cause) => new LegacyHistoryError({ threadId: input.threadId, cause })),
      ),
  });
});
export const layer = Layer.effect(HistoryReader, make);
