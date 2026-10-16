import {
  ProviderInstanceId,
  type ModelSelection,
  type RuntimeMode,
  type Subhead,
  type SubheadRunRow,
  type SubheadTemplate,
  type ThreadId,
} from "@t3tools/contracts";
import { runtimeModeRank } from "@t3tools/shared/providerRuntimeMode";

/**
 * View logic for virtual subheads: a template that owns a name, never a live session. Rows group
 * under the head that owns them; each finished run keeps its own execution outcome and delivery
 * state, because a completed run can still be undelivered.
 */

export type SubheadState = "enabled" | "disabled" | "retired";
export type SubheadTone = "ok" | "error" | "warning" | "info" | "muted";

export const subheadState = (subhead: Pick<Subhead, "enabled" | "retiredAt">): SubheadState =>
  subhead.retiredAt !== null ? "retired" : subhead.enabled ? "enabled" : "disabled";

export const isOpenSubheadRun = (run: Pick<SubheadRunRow, "status">) =>
  run.status === "queued" || run.status === "running";

export interface SubheadRowView {
  /** Stable across polls: `<environmentId>:<name>`. */
  readonly key: string;
  readonly environmentId: string;
  readonly subhead: Subhead;
  readonly state: SubheadState;
  /** Queued and running runs, oldest first (the order the queue starts them). */
  readonly openRuns: ReadonlyArray<SubheadRunRow>;
  readonly running: number;
  readonly queued: number;
  readonly lastFinished: SubheadRunRow | null;
  /** "last ok", "last failed", "last skipped"; the time is the row's `lastFinished` time. */
  readonly lastText: string | null;
  readonly lastDetail: string | null;
  readonly lastTone: SubheadTone;
  /** Undelivered, held and still-retrying results among the loaded runs, however old. */
  readonly undelivered: number;
  readonly held: number;
  readonly retrying: number;
  /** "1 undelivered · 1 held": a result that did not arrive, or null when none is waiting. */
  readonly deliveryAlert: string | null;
  /** Finished runs that failed or whose delivery did not complete; `subheadNeedsAttention` ages them. */
  readonly troubleRuns: ReadonlyArray<SubheadRunRow>;
  /** "enabled · template, no live session". */
  readonly stateLine: string;
}

const lastOutcome = (run: SubheadRunRow | null) => {
  if (run === null) return { text: null, detail: null, tone: "muted" as const };
  if (run.status === "completed") {
    // The run worked; whether its result arrived is a separate fact the row must not hide.
    const delivery = run.delivery.status;
    if (delivery === "undelivered" || delivery === "held")
      return { text: `last ok, ${delivery}`, detail: null, tone: "warning" as const };
    if (delivery === "pending")
      return { text: "last ok, delivery retrying", detail: null, tone: "warning" as const };
    return { text: "last ok", detail: null, tone: "ok" as const };
  }
  if (run.status === "failed")
    return { text: "last failed", detail: run.terminationReason ?? null, tone: "error" as const };
  return { text: "last skipped", detail: null, tone: "muted" as const };
};

const isFinishedPendingDelivery = (run: SubheadRunRow) =>
  !isOpenSubheadRun(run) && run.delivery.status === "pending";

/** Newest first, by when the run was admitted. */
const newestFirst = (a: SubheadRunRow, b: SubheadRunRow) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

export function buildSubheadRows(input: {
  readonly environmentId: string;
  readonly subheads: ReadonlyArray<Subhead>;
  readonly runs: ReadonlyArray<SubheadRunRow>;
}): ReadonlyArray<SubheadRowView> {
  return input.subheads.map((subhead): SubheadRowView => {
    const own = input.runs.filter((run) => run.agentId === subhead.id);
    const openRuns = own.filter(isOpenSubheadRun).sort((a, b) => -newestFirst(a, b));
    const lastFinished = own.filter((run) => !isOpenSubheadRun(run)).sort(newestFirst)[0] ?? null;
    const last = lastOutcome(lastFinished);
    const state = subheadState(subhead);
    const undelivered = own.filter((run) => run.delivery.status === "undelivered").length;
    const held = own.filter((run) => run.delivery.status === "held").length;
    const retrying = own.filter(isFinishedPendingDelivery).length;
    return {
      key: `${input.environmentId}:${subhead.name}`,
      environmentId: input.environmentId,
      subhead,
      state,
      openRuns,
      running: openRuns.filter((run) => run.status === "running").length,
      queued: openRuns.filter((run) => run.status === "queued").length,
      lastFinished,
      lastText: last.text,
      lastDetail: last.detail,
      lastTone: last.tone,
      undelivered,
      held,
      retrying,
      deliveryAlert:
        [
          undelivered > 0 ? `${undelivered} undelivered` : null,
          held > 0 ? `${held} held` : null,
          retrying > 0 ? `${retrying} retrying` : null,
        ]
          .filter((part) => part !== null)
          .join(" · ") || null,
      troubleRuns: own.filter(
        (run) =>
          run.status === "failed" ||
          run.delivery.status === "undelivered" ||
          run.delivery.status === "held" ||
          isFinishedPendingDelivery(run),
      ),
      stateLine: `${state} · template, no live session`,
    };
  });
}

export interface SubheadGroup {
  /** Not retired: shown under the head. Open work first, then failures, then the rest. */
  readonly visible: ReadonlyArray<SubheadRowView>;
  /** Kept out of the list behind "Show N retired subheads". */
  readonly retired: ReadonlyArray<SubheadRowView>;
}

const attentionRank = (row: SubheadRowView) =>
  row.openRuns.length > 0
    ? 0
    : row.lastTone === "error" || row.deliveryAlert !== null
      ? 1
      : row.state === "enabled"
        ? 2
        : 3;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Whether the head owning this subhead moves to the active heads: open work, or a failure or lost
 * result from the last 24 hours. An old failure stays on the subhead row but never reorders the
 * heads, so it cannot keep a quiet head "active" for days.
 */
export function subheadNeedsAttention(row: SubheadRowView, now: number): boolean {
  return (
    row.openRuns.length > 0 ||
    row.troubleRuns.some(
      (run) => now - Date.parse(run.finishedAt ?? run.createdAt) <= DAY_MS,
    )
  );
}

/** Heads with no subheads get no entry, so the sidebar shows nothing for them. */
export function groupSubheadsByOwner(
  rows: ReadonlyArray<SubheadRowView>,
): ReadonlyMap<ThreadId, SubheadGroup> {
  const owners = new Map<ThreadId, SubheadRowView[]>();
  for (const row of rows) {
    const list = owners.get(row.subhead.ownerThreadId) ?? [];
    list.push(row);
    owners.set(row.subhead.ownerThreadId, list);
  }
  const byName = (a: SubheadRowView, b: SubheadRowView) =>
    a.subhead.name.localeCompare(b.subhead.name);
  const groups = new Map<ThreadId, SubheadGroup>();
  for (const [owner, list] of owners) {
    groups.set(owner, {
      visible: list
        .filter((row) => row.state !== "retired")
        .sort(
          (a, b) =>
            attentionRank(a) - attentionRank(b) ||
            b.openRuns.length - a.openRuns.length ||
            byName(a, b),
        ),
      retired: list.filter((row) => row.state === "retired").sort(byName),
    });
  }
  return groups;
}

/** "2 · 2 open · 1 failed", or "1 disabled" when nothing under the head can run. */
export function summarizeSubheadGroup(group: SubheadGroup): string {
  const { visible } = group;
  if (visible.length === 0) return "";
  const disabled = visible.filter((row) => row.state === "disabled").length;
  if (disabled === visible.length) return `${disabled} disabled`;
  const open = visible.reduce((total, row) => total + row.openRuns.length, 0);
  const failed = visible.filter((row) => row.lastTone === "error").length;
  const undelivered = visible.reduce((total, row) => total + row.undelivered, 0);
  const held = visible.reduce((total, row) => total + row.held, 0);
  return [
    `${visible.length}`,
    open > 0 ? `${open} open` : null,
    failed > 0 ? `${failed} failed` : null,
    undelivered > 0 ? `${undelivered} undelivered` : null,
    held > 0 ? `${held} held` : null,
    disabled > 0 ? `${disabled} off` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Position among the queued runs of one subhead, 1 = starts next. */
export function queuePositions(runs: ReadonlyArray<SubheadRunRow>): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  const bySubhead = new Map<string, SubheadRunRow[]>();
  for (const run of runs) {
    if (run.status !== "queued") continue;
    const list = bySubhead.get(run.agentId) ?? [];
    list.push(run);
    bySubhead.set(run.agentId, list);
  }
  for (const list of bySubhead.values()) {
    [...list]
      .sort((a, b) => -newestFirst(a, b))
      .forEach((run, index) => positions.set(run.runId, index + 1));
  }
  return positions;
}

/** The causes the handoff service records, in words; any other text is the server's own sentence. */
const DELIVERY_CAUSE: Readonly<Record<string, string>> = {
  SETTLED: "recipient thread is settled, sent when it resumes",
  ARCHIVED: "recipient thread archived",
  NOT_FOUND: "recipient thread not found",
  QUOTA_EXHAUSTED: "recipient provider quota used up, retrying",
  BUSY: "recipient is busy, retrying",
};
const deliveryCause = (error: string | null, fallback: string) =>
  error === null ? fallback : (DELIVERY_CAUSE[error] ?? error);

export type SubheadDeliveryState =
  | "queued"
  | "pending"
  | "retrying"
  | "delivered"
  | "pull-only"
  | "held"
  | "undelivered";

export interface SubheadRunView {
  readonly outcome: { readonly text: string; readonly tone: SubheadTone };
  readonly delivery: {
    readonly state: SubheadDeliveryState;
    readonly text: string;
    readonly tone: SubheadTone;
  };
  /** Short tail of the delivery id, for the "receipt" a person can quote. */
  readonly receipt: string | null;
  readonly sender: string;
}

/** A thread's title when the list knows it, else a short id (an archived thread has no title). */
export function subheadSenderLabel(
  run: SubheadRunRow,
  senderTitle: (threadId: ThreadId) => string | null,
): string {
  if (run.senderThreadId === null) return run.senderPrincipal;
  return senderTitle(run.senderThreadId) ?? `thread ${run.senderThreadId.slice(0, 8)}`;
}

/**
 * One history row: execution status and delivery are separate columns, so a finished run can
 * read "Completed" beside "Undelivered: recipient thread archived".
 */
export function describeSubheadRun(
  run: SubheadRunRow,
  context: {
    readonly concurrency: number;
    readonly queuePosition: number | null;
    readonly senderTitle: (threadId: ThreadId) => string | null;
    /** Formats an ISO time the way the page shows times. */
    readonly formatWhen: (iso: string) => string;
  },
): SubheadRunView {
  const outcome: SubheadRunView["outcome"] =
    run.status === "queued"
      ? {
          text:
            context.queuePosition === null ? "Queued" : `Queued, position ${context.queuePosition}`,
          tone: "warning",
        }
      : run.status === "running"
        ? { text: "Running", tone: "info" }
        : run.status === "completed"
          ? { text: "Completed", tone: "ok" }
          : run.status === "failed"
            ? {
                // The error text of an ordinary failure stays with the run thread and the sender.
                text: run.terminationReason ? `Failed: ${run.terminationReason}` : "Failed",
                tone: "error",
              }
            : { text: "Skipped", tone: "muted" };
  const failed = run.status === "failed";
  const delivery = ((): SubheadRunView["delivery"] => {
    if (run.status === "queued")
      return {
        state: "queued",
        text: run.blockedReason ?? `Waits for an open run (cap ${context.concurrency})`,
        tone: "muted",
      };
    switch (run.delivery.status) {
      case "pending": {
        // A finished run has its result; a pending delivery is then failing and being retried.
        if (run.status === "running")
          return { state: "pending", text: "Pending, result not ready", tone: "muted" };
        const cause = run.delivery.error === null ? null : deliveryCause(run.delivery.error, "");
        const next = run.delivery.nextAttemptAt
          ? ` · next ${context.formatWhen(run.delivery.nextAttemptAt)}`
          : "";
        return {
          state: "retrying",
          text: `Retrying delivery${cause ? `: ${cause}` : ""}${next}`,
          tone: "warning",
        };
      }
      case "delivered":
        return {
          state: "delivered",
          text: failed ? "Failure notice delivered" : "Delivered",
          tone: "ok",
        };
      case "pull-only":
        return {
          state: "pull-only",
          text: "Pull only, the sender reads it",
          tone: "muted",
        };
      case "held":
        return {
          state: "held",
          text: `Held: ${deliveryCause(run.delivery.error, "waiting to retry")}`,
          tone: "warning",
        };
      case "undelivered":
        return {
          state: "undelivered",
          text: `Undelivered: ${deliveryCause(run.delivery.error, "no reason recorded")}`,
          tone: "error",
        };
    }
  })();
  return {
    outcome,
    delivery,
    receipt: run.delivery.status === "delivered" ? run.delivery.id.slice(-6) : null,
    sender: subheadSenderLabel(run, context.senderTitle),
  };
}

export const RUNTIME_MODE_LABEL: Record<RuntimeMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function describeSubheadWorkspace(strategy: SubheadTemplate["workspaceStrategy"]): string {
  if (strategy === undefined) return "project default";
  switch (strategy.type) {
    case "root":
      return strategy.branch ? `project root on ${strategy.branch}` : "project root";
    case "existing_worktree":
      return `existing worktree ${strategy.worktreePath}`;
    case "worktree":
      return `new worktree from ${strategy.baseRef}`;
  }
}

export type SubheadWorkspaceType = "default" | "root" | "worktree" | "existing_worktree";

/** What the edit form holds: strings, so a half-typed field is never a type error. */
export interface SubheadDraft {
  readonly description: string;
  readonly prompt: string;
  readonly instanceId: string;
  readonly model: string;
  readonly runtimeMode: RuntimeMode;
  readonly concurrency: string;
  readonly workspaceType: SubheadWorkspaceType;
  /** Base ref for a new worktree, or the path of an existing one. */
  readonly workspaceRef: string;
  readonly workspaceBranch: string;
}

export function draftFromSubhead(subhead: Subhead): SubheadDraft {
  const strategy = subhead.workspaceStrategy;
  return {
    description: subhead.description,
    prompt: subhead.prompt,
    instanceId: subhead.modelSelection.instanceId,
    model: subhead.modelSelection.model,
    runtimeMode: subhead.runtimeMode,
    concurrency: String(subhead.concurrency),
    workspaceType: strategy?.type ?? "default",
    workspaceRef:
      strategy?.type === "worktree"
        ? strategy.baseRef
        : strategy?.type === "existing_worktree"
          ? strategy.worktreePath
          : "",
    workspaceBranch: strategy?.branch ?? "",
  };
}

export type SubheadTemplateResult =
  | { readonly ok: true; readonly template: SubheadTemplate }
  | { readonly ok: false; readonly errors: ReadonlyArray<string> };

/**
 * The template an edit sends. Name, project and owning head are copied from the stored subhead:
 * the server refuses a change to any of them, so the form never offers one.
 */
export function buildTemplateFromDraft(
  current: Subhead,
  draft: SubheadDraft,
): SubheadTemplateResult {
  const errors: string[] = [];
  const prompt = draft.prompt.trim();
  const model = draft.model.trim();
  const instanceId = draft.instanceId.trim();
  const concurrency = Number(draft.concurrency);
  if (prompt === "") errors.push("Prompt is required.");
  if (instanceId === "") errors.push("Provider is required.");
  if (model === "") errors.push("Model is required.");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
    errors.push("Concurrency must be 1 or 2.");
  const ref = draft.workspaceRef.trim();
  const branch = draft.workspaceBranch.trim();
  if (draft.workspaceType === "worktree" && ref === "") errors.push("Base ref is required.");
  if (draft.workspaceType === "existing_worktree" && ref === "")
    errors.push("Worktree path is required.");
  if (errors.length > 0) return { ok: false, errors };
  const unchangedModel =
    instanceId === current.modelSelection.instanceId && model === current.modelSelection.model;
  // Model options belong to the model they were chosen for.
  const modelSelection: ModelSelection = unchangedModel
    ? current.modelSelection
    : { instanceId: ProviderInstanceId.make(instanceId), model };
  const withBranch = branch === "" ? {} : { branch };
  const workspaceStrategy: SubheadTemplate["workspaceStrategy"] | undefined =
    draft.workspaceType === "default"
      ? undefined
      : draft.workspaceType === "root"
        ? { type: "root", ...withBranch }
        : draft.workspaceType === "worktree"
          ? { type: "worktree", baseRef: ref, ...withBranch }
          : { type: "existing_worktree", worktreePath: ref, ...withBranch };
  return {
    ok: true,
    template: {
      name: current.name,
      projectId: current.projectId,
      ownerThreadId: current.ownerThreadId,
      description: draft.description.trim(),
      prompt,
      modelSelection,
      runtimeMode: draft.runtimeMode,
      ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
      concurrency,
    },
  };
}

/** Changes that give future runs more reach; each needs a confirmation before saving. */
export function permissionChanges(current: Subhead, next: SubheadTemplate): ReadonlyArray<string> {
  const changes: string[] = [];
  if (runtimeModeRank(next.runtimeMode) > runtimeModeRank(current.runtimeMode))
    changes.push(`Runtime mode rises from ${current.runtimeMode} to ${next.runtimeMode}.`);
  if (next.concurrency > current.concurrency)
    changes.push(`Concurrency rises from ${current.concurrency} to ${next.concurrency}.`);
  if (next.modelSelection.instanceId !== current.modelSelection.instanceId)
    changes.push(
      `Provider changes from ${current.modelSelection.instanceId} to ${next.modelSelection.instanceId}.`,
    );
  if (next.modelSelection.model !== current.modelSelection.model)
    changes.push(
      `Model changes from ${current.modelSelection.model} to ${next.modelSelection.model}.`,
    );
  const wasIsolated =
    current.workspaceStrategy === undefined || current.workspaceStrategy.type === "worktree";
  if (
    wasIsolated &&
    next.workspaceStrategy !== undefined &&
    next.workspaceStrategy.type !== "worktree"
  )
    changes.push(
      `Workspace changes from ${describeSubheadWorkspace(current.workspaceStrategy)} to ${describeSubheadWorkspace(next.workspaceStrategy)}.`,
    );
  return changes;
}

/** "Template version conflict: expected 7, current 8." as numbers, or null for any other refusal. */
export function parseVersionConflict(
  message: string,
): { readonly expected: number; readonly current: number } | null {
  const match = /version conflict: expected (\d+), current (\d+)/i.exec(message);
  return match ? { expected: Number(match[1]), current: Number(match[2]) } : null;
}

/**
 * Limits the server applies to every subhead in this version. They are not template fields: the
 * values mirror admission in apps/server/src/forkThreads/SubheadRuns.ts and the 30 minute run
 * timeout in apps/server/src/automations/AgentGateway.ts, so the page can state them plainly.
 */
export const SUBHEAD_FIXED_LIMITS = {
  queued: 10,
  runsPerDay: 20,
  senderRequests: 3,
  senderWindowMinutes: 10,
  timeoutMinutes: 30,
} as const;

/** "claudeAgent · claude-sonnet-5-5", plus any selected options. */
export function describeSubheadModel(selection: ModelSelection): string {
  const options = (selection.options ?? [])
    .map((option) => `${option.id} ${String(option.value)}`)
    .join(" · ");
  return [selection.instanceId, selection.model, options].filter((part) => part !== "").join(" · ");
}

/**
 * Why this session cannot change the subhead, when the server says so (`callerMayChange`), so the
 * buttons can be disabled with a reason instead of offering a form that will be refused.
 */
export function subheadChangeNotice(subhead: Subhead): string | null {
  return subhead.callerMayChange === false
    ? `Only ${subhead.createdBy ?? "system"} or an administrator may change this subhead.`
    : null;
}
