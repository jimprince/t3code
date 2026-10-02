import { readMessageOrigin } from "@t3tools/shared/messageOrigin";

/**
 * Brad view: an orchestrator thread's worker traffic folds out of the way.
 *
 * A turn started by a worker notification, or by a `t3-thread send` from one of
 * the thread's own descendants, is background traffic. Consecutive settled
 * background turns fold into one run. A background turn stays visible when it
 * raised an approval or question, or when its final message ends with
 * `T3_NOTIFY: attention`; because this is derived from current state, a folded
 * turn that later gains either surfaces on its own. Sends from a parent, a peer
 * or a person never fold.
 */

export interface BackgroundTurnMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
  readonly turnId?: string | null | undefined;
  readonly createdAt: string;
  readonly streaming?: boolean | undefined;
}

export interface BackgroundRun {
  /** Stable while the run's first turn stays first. */
  readonly id: string;
  /** First message of the run; clients place the fold row here. */
  readonly anchorMessageId: string;
  readonly messageIds: ReadonlySet<string>;
  readonly turnIds: ReadonlySet<string>;
  readonly turnCount: number;
  readonly senderLabels: ReadonlyArray<string>;
  /** First line of the run's latest reply, for the fold row. */
  readonly lastLine: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface BackgroundTraffic {
  readonly runs: ReadonlyArray<BackgroundRun>;
  /** Background turns that ask for the user, since the user's last message. */
  readonly attentionCount: number;
  readonly hasBackgroundTraffic: boolean;
}

export interface DeriveBackgroundTrafficInput {
  /** Chronological thread messages. */
  readonly messages: ReadonlyArray<BackgroundTurnMessage>;
  /** Descendants of this thread; their sends count as background traffic. */
  readonly workerThreadIds: ReadonlySet<string>;
  /** Turns that raised an approval or user-input request. */
  readonly attentionTurnIds: ReadonlySet<string>;
  /** The running or not yet settled turn, which never folds. */
  readonly liveTurnId: string | null;
  /** Display name for a sending thread, when the client knows one. */
  readonly labelForThread?: ((threadId: string) => string | undefined) | undefined;
}

const ATTENTION_MARKER = /(?:^|\n)T3_NOTIFY: attention\s*$/;
const NOTIFY_MARKER = /(?:^|\n)T3_NOTIFY: (?:quiet|attention)\s*$/;
const LAST_LINE_MAX_CHARS = 160;

interface TurnUnit {
  readonly trigger: BackgroundTurnMessage | null;
  readonly background: boolean;
  /** A person typed the trigger: no origin record and no notification prefix. */
  readonly fromPerson: boolean;
  readonly senderLabel: string | null;
  readonly messages: BackgroundTurnMessage[];
}

function firstLine(text: string): string | null {
  const line = text
    .replace(NOTIFY_MARKER, "")
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  if (!line) return null;
  return line.length > LAST_LINE_MAX_CHARS ? `${line.slice(0, LAST_LINE_MAX_CHARS - 1)}…` : line;
}

function splitTurnUnits(input: DeriveBackgroundTrafficInput): TurnUnit[] {
  const units: TurnUnit[] = [];
  let current: TurnUnit | null = null;
  for (const message of input.messages) {
    if (message.role === "user") {
      const origin = readMessageOrigin(message);
      const background =
        origin !== null &&
        (origin.source === "worker-notification" ||
          (origin.fromThreadId !== undefined && input.workerThreadIds.has(origin.fromThreadId)));
      const senderLabel =
        origin === null
          ? null
          : (origin.fromName ??
            (origin.fromThreadId
              ? (input.labelForThread?.(origin.fromThreadId) ?? origin.fromThreadId.slice(0, 8))
              : null));
      current = {
        trigger: message,
        background,
        fromPerson: origin === null,
        senderLabel,
        messages: [message],
      };
      units.push(current);
      continue;
    }
    if (current === null) {
      current = {
        trigger: null,
        background: false,
        fromPerson: false,
        senderLabel: null,
        messages: [],
      };
      units.push(current);
    }
    current.messages.push(message);
  }
  return units;
}

function unitTurnIds(unit: TurnUnit): Set<string> {
  const turnIds = new Set<string>();
  for (const message of unit.messages) {
    if (message.turnId) turnIds.add(message.turnId);
  }
  return turnIds;
}

function unitNeedsAttention(
  unit: TurnUnit,
  turnIds: ReadonlySet<string>,
  input: DeriveBackgroundTrafficInput,
) {
  for (const turnId of turnIds) {
    if (input.attentionTurnIds.has(turnId)) return true;
  }
  const reply = unit.messages.findLast((message) => message.role === "assistant");
  return reply !== undefined && ATTENTION_MARKER.test(reply.text.trimEnd());
}

export function deriveBackgroundTraffic(input: DeriveBackgroundTrafficInput): BackgroundTraffic {
  const units = splitTurnUnits(input);
  const runs: BackgroundRun[] = [];
  let open: TurnUnit[] = [];
  let attentionCount = 0;
  let hasBackgroundTraffic = false;

  const closeRun = () => {
    if (open.length === 0) return;
    const messageIds = new Set<string>();
    const turnIds = new Set<string>();
    const senderLabels: string[] = [];
    for (const unit of open) {
      for (const message of unit.messages) messageIds.add(message.id);
      for (const turnId of unitTurnIds(unit)) turnIds.add(turnId);
      if (unit.senderLabel && !senderLabels.includes(unit.senderLabel)) {
        senderLabels.push(unit.senderLabel);
      }
    }
    const first = open[0]!.messages[0]!;
    const lastUnit = open.at(-1)!;
    const reply = lastUnit.messages.findLast((message) => message.role === "assistant");
    runs.push({
      id: `background:${first.id}`,
      anchorMessageId: first.id,
      messageIds,
      turnIds,
      turnCount: open.length,
      senderLabels,
      lastLine: reply ? firstLine(reply.text) : null,
      startedAt: first.createdAt,
      endedAt: lastUnit.messages.at(-1)!.createdAt,
    });
    open = [];
  };

  for (const unit of units) {
    if (!unit.background) {
      closeRun();
      if (unit.fromPerson) attentionCount = 0;
      continue;
    }
    hasBackgroundTraffic = true;
    const turnIds = unitTurnIds(unit);
    const live =
      (input.liveTurnId !== null && turnIds.has(input.liveTurnId)) ||
      unit.messages.some((message) => message.streaming === true);
    const answered = unit.messages.some((message) => message.role === "assistant");
    if (unitNeedsAttention(unit, turnIds, input)) {
      attentionCount += 1;
      closeRun();
      continue;
    }
    if (live || !answered) {
      closeRun();
      continue;
    }
    open.push(unit);
  }
  closeRun();
  return { runs, attentionCount, hasBackgroundTraffic };
}

function sameRun(a: BackgroundRun, b: BackgroundRun): boolean {
  if (
    a.id !== b.id ||
    a.turnCount !== b.turnCount ||
    a.lastLine !== b.lastLine ||
    a.endedAt !== b.endedAt ||
    a.messageIds.size !== b.messageIds.size ||
    a.senderLabels.length !== b.senderLabels.length
  ) {
    return false;
  }
  for (const id of a.messageIds) if (!b.messageIds.has(id)) return false;
  return a.senderLabels.every((label, index) => label === b.senderLabels[index]);
}

/**
 * Reuses the previous result's objects where nothing changed. Streaming replies
 * re-derive traffic on every delta, and a stable result keeps the timeline on its
 * streaming fast path instead of rebuilding every row.
 */
export function stabilizeBackgroundTraffic(
  previous: BackgroundTraffic | null,
  next: BackgroundTraffic,
): BackgroundTraffic {
  if (previous === null) return next;
  const previousById = new Map(previous.runs.map((run) => [run.id, run]));
  let reusedAll = previous.runs.length === next.runs.length;
  const runs = next.runs.map((run, index) => {
    const prior = previousById.get(run.id);
    if (prior && sameRun(prior, run)) {
      if (previous.runs[index] !== prior) reusedAll = false;
      return prior;
    }
    reusedAll = false;
    return run;
  });
  const stableRuns = reusedAll ? previous.runs : runs;
  if (
    stableRuns === previous.runs &&
    previous.attentionCount === next.attentionCount &&
    previous.hasBackgroundTraffic === next.hasBackgroundTraffic
  ) {
    return previous;
  }
  return { ...next, runs: stableRuns };
}

export interface BackgroundFolds {
  readonly runByAnchorMessageId: ReadonlyMap<string, BackgroundRun>;
  /** Messages and turns of collapsed runs. The anchor message is hidden too. */
  readonly hiddenMessageIds: ReadonlySet<string>;
  readonly hiddenTurnIds: ReadonlySet<string>;
}

/** What a client hides for the runs the user has not expanded. */
export function resolveBackgroundFolds(
  runs: ReadonlyArray<BackgroundRun>,
  expandedRunIds: ReadonlySet<string>,
): BackgroundFolds {
  const runByAnchorMessageId = new Map<string, BackgroundRun>();
  const hiddenMessageIds = new Set<string>();
  const hiddenTurnIds = new Set<string>();
  for (const run of runs) {
    runByAnchorMessageId.set(run.anchorMessageId, run);
    if (expandedRunIds.has(run.id)) continue;
    for (const messageId of run.messageIds) hiddenMessageIds.add(messageId);
    for (const turnId of run.turnIds) hiddenTurnIds.add(turnId);
  }
  return { runByAnchorMessageId, hiddenMessageIds, hiddenTurnIds };
}

/** Thread ids below `rootThreadId` in the nesting tree. */
export function collectDescendantThreadIds(
  rootThreadId: string,
  threads: ReadonlyArray<{
    readonly id: string;
    readonly parentThreadId?: string | null | undefined;
  }>,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const siblings = childrenByParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread.id);
    else childrenByParent.set(thread.parentThreadId, [thread.id]);
  }
  const descendants = new Set<string>();
  const pending = [rootThreadId];
  while (pending.length > 0) {
    for (const child of childrenByParent.get(pending.pop()!) ?? []) {
      if (descendants.has(child) || child === rootThreadId) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}
