import type { Subhead, SubheadRunRow } from "@t3tools/contracts";
import { NamedAgentName, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSubheadRows,
  buildTemplateFromDraft,
  describeSubheadRun,
  draftFromSubhead,
  groupSubheadsByOwner,
  parseVersionConflict,
  permissionChanges,
  subheadChangeNotice,
  subheadNeedsAttention,
  summarizeSubheadGroup,
} from "./subheadsView.ts";

const head = ThreadId.make("head-platform");
const subhead = (overrides: Omit<Partial<Subhead>, "name"> & { name: string }): Subhead => ({
  id: `id-${overrides.name}`,
  kind: "virtual",
  version: 7,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-10-10T10:00:00.000Z",
  updatedAt: "2026-10-10T10:00:00.000Z",
  projectId: ProjectId.make("web-app"),
  ownerThreadId: head,
  description: "Reviews one diff",
  prompt: "Review exactly one diff.",
  modelSelection: {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  },
  runtimeMode: "approval-required",
  concurrency: 1,
  ...overrides,
  name: NamedAgentName.make(overrides.name),
});
let n = 0;
const run = (
  overrides: Omit<Partial<SubheadRunRow>, "subheadName"> & { subheadName: string },
): SubheadRunRow => {
  n += 1;
  return {
    runId: `run-${n}`,
    agentId: `id-${overrides.subheadName}`,
    requestId: `req-${n}`,
    requestSummary: `Review diff ${n}`,
    senderPrincipal: "owner",
    senderThreadId: null,
    templateVersion: 7,
    status: "completed",
    threadId: ThreadId.make(`thread-${n}`),
    delivery: { id: `d-${n}`, status: "delivered", messageId: "m", attempts: 1, error: null },
    blockedReason: null,
    terminationReason: null,
    createdAt: "2026-10-15T13:00:00.000Z",
    finishedAt: "2026-10-15T13:04:00.000Z",
    ...overrides,
    subheadName: NamedAgentName.make(overrides.subheadName),
  };
};

describe("buildSubheadRows", () => {
  const review = subhead({ name: "code-review" });
  const triage = subhead({ name: "dep-triage" });
  const retired = subhead({ name: "old-notes", retiredAt: "2026-10-12T00:00:00.000Z" });
  const off = subhead({
    name: "release-notes",
    enabled: false,
    ownerThreadId: ThreadId.make("docs"),
  });
  const runs = [
    run({
      subheadName: "code-review",
      status: "running",
      createdAt: "2026-10-15T13:38:00.000Z",
      finishedAt: null,
    }),
    run({
      subheadName: "code-review",
      status: "queued",
      createdAt: "2026-10-15T13:40:00.000Z",
      finishedAt: null,
    }),
    run({
      subheadName: "code-review",
      createdAt: "2026-10-15T13:20:00.000Z",
      finishedAt: "2026-10-15T13:22:00.000Z",
    }),
    run({
      subheadName: "dep-triage",
      status: "failed",
      terminationReason: "timeout 30m",
      createdAt: "2026-10-15T12:00:00.000Z",
      finishedAt: "2026-10-15T12:48:00.000Z",
    }),
  ];
  const rows = buildSubheadRows({
    environmentId: "env",
    subheads: [review, triage, retired, off],
    runs,
  });
  const byName = (name: string) => rows.find((row) => row.subhead.name === name)!;

  it("derives enabled, disabled and retired state", () => {
    expect(byName("code-review").state).toBe("enabled");
    expect(byName("release-notes").state).toBe("disabled");
    expect(byName("old-notes").state).toBe("retired");
  });

  it("counts open runs oldest first and reports the newest finished outcome", () => {
    const row = byName("code-review");
    expect(row.openRuns.map((open) => open.status)).toEqual(["running", "queued"]);
    expect(row.running).toBe(1);
    expect(row.queued).toBe(1);
    expect(row.lastFinished?.finishedAt).toBe("2026-10-15T13:22:00.000Z");
    expect(row.lastTone).toBe("ok");
    expect(row.lastText).toBe("last ok");
    expect(byName("dep-triage")).toMatchObject({
      lastText: "last failed",
      lastDetail: "timeout 30m",
      lastTone: "error",
    });
    expect(byName("release-notes")).toMatchObject({ lastText: null, openRuns: [] });
  });

  it("never calls a template a live agent", () => {
    for (const row of rows) {
      expect(row.stateLine).toContain("template, no live session");
      expect(JSON.stringify(row)).not.toMatch(/live agent/i);
    }
    expect(byName("code-review").stateLine).toBe("enabled · template, no live session");
    expect(byName("release-notes").stateLine).toBe("disabled · template, no live session");
  });

  it("groups under the owning head, hides retired ones, and omits heads with none", () => {
    const groups = groupSubheadsByOwner(rows);
    expect([...groups.keys()].sort()).toEqual(["docs", "head-platform"]);
    const platform = groups.get(head)!;
    // Open work first, then the failed one; retired stays out of the visible list.
    expect(platform.visible.map((row) => row.subhead.name)).toEqual(["code-review", "dep-triage"]);
    expect(platform.retired.map((row) => row.subhead.name)).toEqual(["old-notes"]);
    expect(summarizeSubheadGroup(platform)).toBe("2 · 2 open · 1 failed");
    expect(summarizeSubheadGroup(groups.get(ThreadId.make("docs"))!)).toBe("1 disabled");
  });

  it("does not attach runs of one subhead or environment to another", () => {
    const other = buildSubheadRows({ environmentId: "env", subheads: [triage], runs });
    expect(other[0]!.openRuns).toEqual([]);
  });
});

describe("describeSubheadRun", () => {
  const context = {
    concurrency: 1,
    queuePosition: null,
    senderTitle: () => null,
    formatWhen: (iso: string) => `at ${iso.slice(11, 16)}`,
  };
  const delivery = (state: SubheadRunRow["delivery"]["status"], error: string | null = null) => ({
    id: "d-abcdef",
    status: state,
    messageId: "m-1",
    attempts: 1,
    error,
  });

  it("names every delivery state in plain words", () => {
    const states = [
      describeSubheadRun(
        run({
          subheadName: "a",
          status: "queued",
          finishedAt: null,
          delivery: delivery("pending"),
        }),
        { ...context, queuePosition: 2 },
      ),
      describeSubheadRun(
        run({
          subheadName: "a",
          status: "running",
          finishedAt: null,
          delivery: delivery("pending"),
        }),
        context,
      ),
      describeSubheadRun(run({ subheadName: "a", delivery: delivery("delivered") }), context),
      describeSubheadRun(run({ subheadName: "a", delivery: delivery("pull-only") }), context),
      describeSubheadRun(
        run({ subheadName: "a", delivery: delivery("held", "recipient settled") }),
        context,
      ),
      describeSubheadRun(
        run({ subheadName: "a", delivery: delivery("undelivered", "recipient thread archived") }),
        context,
      ),
      describeSubheadRun(
        run({
          subheadName: "a",
          status: "failed",
          terminationReason: "timeout 30m",
          delivery: delivery("delivered"),
        }),
        context,
      ),
    ];
    expect(states.map((state) => state.delivery.state)).toEqual([
      "queued",
      "pending",
      "delivered",
      "pull-only",
      "held",
      "undelivered",
      "delivered",
    ]);
    expect(states[0]!.delivery.text).toBe("Waits for an open run (cap 1)");
    expect(states[0]!.outcome.text).toBe("Queued, position 2");
    expect(states[1]!.outcome.text).toBe("Running");
    expect(states[3]!.delivery.text).toBe("Pull only, the sender reads it");
    // Pull-only is how every CLI sender works, not a warning.
    expect(states[3]!.delivery.tone).toBe("muted");
    expect(states[4]!.delivery.text).toBe("Held: recipient settled");
    expect(states[5]).toMatchObject({
      delivery: { text: "Undelivered: recipient thread archived", tone: "error" },
    });
    expect(states[6]).toMatchObject({
      outcome: { text: "Failed: timeout 30m", tone: "error" },
      delivery: { text: "Failure notice delivered" },
    });
  });

  it("keeps the error text of an ordinary failure out of the list", () => {
    const failed = describeSubheadRun(run({ subheadName: "a", status: "failed" }), context);
    expect(failed.outcome).toEqual({ text: "Failed", tone: "error" });
  });

  it("turns the server's delivery cause codes into plain words", () => {
    const text = (status: SubheadRunRow["delivery"]["status"], error: string) =>
      describeSubheadRun(
        run({ subheadName: "a", delivery: { ...delivery(status), error } }),
        context,
      ).delivery.text;
    expect(text("held", "SETTLED")).toBe("Held: recipient thread is settled, sent when it resumes");
    expect(text("undelivered", "ARCHIVED")).toBe("Undelivered: recipient thread archived");
    expect(text("undelivered", "NOT_FOUND")).toBe("Undelivered: recipient thread not found");
    expect(text("held", "QUOTA_EXHAUSTED")).toBe(
      "Held: recipient provider quota used up, retrying",
    );
    expect(text("held", "BUSY")).toBe("Held: recipient is busy, retrying");
    // Anything else is the server's own sentence and shown as written.
    expect(text("undelivered", "recipient gone")).toBe("Undelivered: recipient gone");
  });

  it("labels the sender by its thread title when it has one", () => {
    const fromThread = run({ subheadName: "a", senderThreadId: ThreadId.make("alex") });
    expect(
      describeSubheadRun(fromThread, { ...context, senderTitle: () => "Alex (UI)" }).sender,
    ).toBe("Alex (UI)");
    // An archived thread has no title: a short id, never the raw principal string.
    expect(describeSubheadRun(fromThread, context).sender).toBe("thread alex");
    expect(describeSubheadRun(run({ subheadName: "a" }), context).sender).toBe("owner");
  });
});

describe("editing a template", () => {
  const current = subhead({ name: "code-review", concurrency: 1 });

  it("round trips a draft without touching the immutable fields", () => {
    const draft = draftFromSubhead(current);
    const built = buildTemplateFromDraft(current, draft);
    expect(built).toEqual({
      ok: true,
      template: {
        name: "code-review",
        projectId: "web-app",
        ownerThreadId: head,
        description: "Reviews one diff",
        prompt: "Review exactly one diff.",
        modelSelection: current.modelSelection,
        runtimeMode: "approval-required",
        concurrency: 1,
      },
    });
  });

  it("validates the fields the server would refuse", () => {
    const draft = draftFromSubhead(current);
    const bad = buildTemplateFromDraft(current, {
      ...draft,
      prompt: "  ",
      concurrency: "3",
      model: "",
    });
    expect(bad).toEqual({
      ok: false,
      errors: ["Prompt is required.", "Model is required.", "Concurrency must be 1 or 2."],
    });
  });

  it("keeps a workspace strategy and writes edits to it", () => {
    const withWorktree = subhead({
      name: "code-review",
      workspaceStrategy: { type: "worktree", baseRef: "main" },
    });
    const draft = draftFromSubhead(withWorktree);
    expect(draft).toMatchObject({ workspaceType: "worktree", workspaceRef: "main" });
    const built = buildTemplateFromDraft(withWorktree, { ...draft, workspaceRef: "release" });
    expect(built.ok && built.template.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "release",
    });
    const unset = buildTemplateFromDraft(withWorktree, { ...draft, workspaceType: "default" });
    expect(unset.ok && "workspaceStrategy" in unset.template).toBe(false);
  });

  it("asks for confirmation only when permissions broaden", () => {
    const base = draftFromSubhead(current);
    const next = (patch: Partial<typeof base>) => {
      const built = buildTemplateFromDraft(current, { ...base, ...patch });
      if (!built.ok) throw new Error("invalid");
      return permissionChanges(current, built.template);
    };
    expect(next({})).toEqual([]);
    expect(next({ runtimeMode: "full-access" })).toEqual([
      "Runtime mode rises from approval-required to full-access.",
    ]);
    expect(next({ concurrency: "2" })).toEqual(["Concurrency rises from 1 to 2."]);
    // Narrowing needs no confirmation.
    const wide = subhead({ name: "code-review", runtimeMode: "full-access", concurrency: 2 });
    const narrowed = buildTemplateFromDraft(wide, {
      ...draftFromSubhead(wide),
      runtimeMode: "approval-required",
      concurrency: "1",
    });
    expect(narrowed.ok && permissionChanges(wide, narrowed.template)).toEqual([]);
  });
});

describe("parseVersionConflict", () => {
  it("reads the server's expected and current versions", () => {
    expect(parseVersionConflict("Template version conflict: expected 7, current 8.")).toEqual({
      expected: 7,
      current: 8,
    });
    expect(parseVersionConflict("Subhead is retired.")).toBeNull();
  });
});

describe("delivery that needs a look", () => {
  const review = subhead({ name: "code-review" });
  const lost = run({
    subheadName: "code-review",
    createdAt: "2026-10-10T09:00:00.000Z",
    finishedAt: "2026-10-10T09:05:00.000Z",
    delivery: { id: "d-1", status: "undelivered", messageId: null, attempts: 1, error: "ARCHIVED" },
  });
  const held = run({
    subheadName: "code-review",
    createdAt: "2026-10-11T09:00:00.000Z",
    finishedAt: "2026-10-11T09:05:00.000Z",
    delivery: { id: "d-2", status: "held", messageId: null, attempts: 1, error: "SETTLED" },
  });
  const fine = run({
    subheadName: "code-review",
    createdAt: "2026-10-15T09:00:00.000Z",
    finishedAt: "2026-10-15T09:05:00.000Z",
  });
  const rowOf = (runs: ReadonlyArray<SubheadRunRow>) =>
    buildSubheadRows({ environmentId: "env", subheads: [review], runs })[0]!;

  it("keeps an older undelivered or held result on the row after a newer one was delivered", () => {
    const row = rowOf([lost, held, fine]);
    expect(row.undelivered).toBe(1);
    expect(row.held).toBe(1);
    expect(row.deliveryAlert).toBe("1 undelivered · 1 held");
    // The newest finished run was delivered, and the row still says something needs a look.
    expect(row.lastText).toBe("last ok");
    expect(rowOf([fine]).deliveryAlert).toBeNull();
  });

  it("calls a completed but undelivered newest run 'last ok, undelivered' in warning tone", () => {
    expect(rowOf([lost])).toMatchObject({ lastText: "last ok, undelivered", lastTone: "warning" });
    expect(rowOf([held])).toMatchObject({ lastText: "last ok, held", lastTone: "warning" });
  });

  it("never shows a delivery code as the reason a run failed", () => {
    const failed = run({
      subheadName: "code-review",
      status: "failed",
      delivery: { id: "d-3", status: "held", messageId: null, attempts: 1, error: "SETTLED" },
    });
    expect(rowOf([failed])).toMatchObject({ lastText: "last failed", lastDetail: null });
  });

  it("ranks undelivered rows with failures, ahead of quiet ones, and counts them in the heading", () => {
    const quiet = subhead({ name: "audits" });
    const rows = buildSubheadRows({
      environmentId: "env",
      subheads: [quiet, review],
      runs: [lost, run({ subheadName: "audits" })],
    });
    const group = groupSubheadsByOwner(rows).get(head)!;
    expect(group.visible.map((row) => row.subhead.name)).toEqual(["code-review", "audits"]);
    expect(summarizeSubheadGroup(group)).toBe("2 · 1 undelivered");
  });

  it("promotes a head only for open runs or trouble from the last 24 hours", () => {
    const now = Date.parse("2026-10-16T09:00:00.000Z");
    const staleFailure = run({
      subheadName: "code-review",
      status: "failed",
      createdAt: "2026-10-10T09:00:00.000Z",
      finishedAt: "2026-10-10T09:05:00.000Z",
    });
    const freshFailure = run({
      subheadName: "code-review",
      status: "failed",
      createdAt: "2026-10-16T08:00:00.000Z",
      finishedAt: "2026-10-16T08:05:00.000Z",
    });
    const open = run({ subheadName: "code-review", status: "running", finishedAt: null, createdAt: "2026-10-10T09:00:00.000Z" });
    // The row itself still shows the old failure; only the head's bucket ignores it.
    expect(rowOf([staleFailure]).lastTone).toBe("error");
    expect(subheadNeedsAttention(rowOf([staleFailure, lost, held]), now)).toBe(false);
    expect(subheadNeedsAttention(rowOf([freshFailure]), now)).toBe(true);
    expect(subheadNeedsAttention(rowOf([open]), now)).toBe(true);
    expect(subheadNeedsAttention(rowOf([fine]), now)).toBe(false);
    const freshLost = { ...lost, createdAt: "2026-10-16T08:00:00.000Z", finishedAt: "2026-10-16T08:05:00.000Z" };
    expect(subheadNeedsAttention(rowOf([freshLost]), now)).toBe(true);
  });
});

describe("delivery still retrying", () => {
  it("says so for a finished run, and keeps 'result not ready' for runs that are not finished", () => {
    const context = {
      concurrency: 1,
      queuePosition: null,
      senderTitle: () => null,
      formatWhen: (iso: string) => `at ${iso.slice(11, 16)}`,
    };
    const pending = {
      id: "d-9",
      status: "pending" as const,
      messageId: null,
      attempts: 3,
      error: "BUSY",
      nextAttemptAt: "2026-10-16T09:31:00.000Z",
    };
    const finished = describeSubheadRun(run({ subheadName: "a", delivery: pending }), context);
    expect(finished.delivery).toEqual({
      state: "retrying",
      text: "Retrying delivery: recipient is busy, retrying · next at 09:31",
      tone: "warning",
    });
    expect(
      describeSubheadRun(run({ subheadName: "a", delivery: { id: "d-9", status: "pending", messageId: null, attempts: 3, error: null } }), context).delivery.text,
    ).toBe("Retrying delivery");
    const running = describeSubheadRun(
      run({ subheadName: "a", status: "running", finishedAt: null, delivery: pending }),
      context,
    );
    expect(running.delivery).toMatchObject({ state: "pending", text: "Pending, result not ready" });
  });
});

describe("who may change a subhead", () => {
  it("names the creator when the server says this session may not change it", () => {
    const entry = subhead({ name: "code-review", createdBy: "one-time-token" });
    expect(subheadChangeNotice({ ...entry, callerMayChange: false })).toBe(
      "Only one-time-token or an administrator may change this subhead.",
    );
    expect(subheadChangeNotice({ ...entry, callerMayChange: true })).toBeNull();
    // An older server does not say; the server still decides.
    expect(subheadChangeNotice(entry)).toBeNull();
  });
});

describe("provider and model changes", () => {
  it("need a confirmation line like any other broader change", () => {
    const current = subhead({ name: "code-review" });
    const draft = draftFromSubhead(current);
    const changes = (patch: Partial<typeof draft>) => {
      const built = buildTemplateFromDraft(current, { ...draft, ...patch });
      if (!built.ok) throw new Error("invalid");
      return permissionChanges(current, built.template);
    };
    expect(changes({ model: "claude-opus-5-5" })).toEqual([
      "Model changes from claude-sonnet-5-5 to claude-opus-5-5.",
    ]);
    expect(changes({ instanceId: "codex_gmail" })).toEqual([
      "Provider changes from claudeAgent to codex_gmail.",
    ]);
  });
});
