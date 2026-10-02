import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";
import { describe, expect, it } from "vite-plus/test";

import {
  collectDescendantThreadIds,
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
  stabilizeBackgroundTraffic,
  type BackgroundTurnMessage,
  type DeriveBackgroundTrafficInput,
} from "./backgroundTurns.ts";

let clock = 0;
function at() {
  clock += 1;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `2026-10-02T12:${pad(Math.floor(clock / 60))}:${pad(clock % 60)}.000Z`;
}

function person(id: string, text = "do the thing"): BackgroundTurnMessage {
  return { id, role: "user", text, createdAt: at() };
}

function notification(id: string, worker = "arm-calib"): BackgroundTurnMessage {
  return {
    id,
    role: "user",
    text: `T3 orchestrator notification: ${worker} completed a turn. State: completed.`,
    context: makeMessageOriginContext({ source: "worker-notification", fromName: worker }),
    createdAt: at(),
  };
}

function legacyNotification(id: string): BackgroundTurnMessage {
  return {
    id,
    role: "user",
    text: "HomeNetwork orchestrator notification: ci-repair needs attention. State: error.",
    createdAt: at(),
  };
}

function sendFrom(id: string, fromThreadId: string): BackgroundTurnMessage {
  return {
    id,
    role: "user",
    text: "result: done",
    context: makeMessageOriginContext({ source: "thread-send", fromThreadId }),
    createdAt: at(),
  };
}

function reply(id: string, turnId: string, text = "Relayed it."): BackgroundTurnMessage {
  return { id, role: "assistant", text, turnId, createdAt: at() };
}

function traffic(
  messages: BackgroundTurnMessage[],
  overrides: Partial<DeriveBackgroundTrafficInput> = {},
) {
  return deriveBackgroundTraffic({
    messages,
    workerThreadIds: new Set(["worker-1"]),
    attentionTurnIds: new Set(),
    liveTurnId: null,
    ...overrides,
  });
}

describe("deriveBackgroundTraffic", () => {
  it("folds consecutive worker turns into one run between the user's own turns", () => {
    const result = traffic([
      person("u1"),
      reply("a1", "t1"),
      notification("n1"),
      reply("a2", "t2"),
      legacyNotification("n2"),
      reply("a3", "t3", "Settled ci-repair.\nT3_NOTIFY: quiet"),
      person("u2"),
      reply("a4", "t4"),
    ]);

    expect(result.hasBackgroundTraffic).toBe(true);
    expect(result.runs).toHaveLength(1);
    const run = result.runs[0]!;
    expect(run.anchorMessageId).toBe("n1");
    expect(run.turnCount).toBe(2);
    expect([...run.messageIds]).toEqual(["n1", "a2", "n2", "a3"]);
    expect([...run.turnIds]).toEqual(["t2", "t3"]);
    expect(run.senderLabels).toEqual(["arm-calib", "ci-repair"]);
    expect(run.lastLine).toBe("Settled ci-repair.");
  });

  it("folds sends only from the thread's own workers", () => {
    const fromWorker = traffic([sendFrom("s1", "worker-1"), reply("a1", "t1")]);
    const fromParent = traffic([sendFrom("s1", "parent-thread"), reply("a1", "t1")]);

    expect(fromWorker.runs).toHaveLength(1);
    expect(fromParent.runs).toHaveLength(0);
    expect(fromParent.hasBackgroundTraffic).toBe(false);
  });

  it("keeps turns that ask for the user visible and counts them since the user spoke", () => {
    const messages = [
      notification("n1"),
      reply("a1", "t1", "Design is ready for you.\nT3_NOTIFY: attention"),
      notification("n2"),
      reply("a2", "t2", "Asked Brad to approve J3 homing."),
      notification("n3"),
      reply("a3", "t3"),
    ];
    const result = traffic(messages, { attentionTurnIds: new Set(["t2"]) });

    expect(result.runs.map((run) => [...run.messageIds])).toEqual([["n3", "a3"]]);
    expect(result.attentionCount).toBe(2);
    expect(traffic([...messages, person("u1")]).attentionCount).toBe(0);
  });

  it("surfaces a folded turn once it later raises a request", () => {
    const messages = [notification("n1"), reply("a1", "t1")];

    expect(traffic(messages).runs).toHaveLength(1);
    expect(traffic(messages, { attentionTurnIds: new Set(["t1"]) }).runs).toHaveLength(0);
  });

  it("never folds a live, streaming or unanswered worker turn", () => {
    expect(traffic([notification("n1"), reply("a1", "t1")], { liveTurnId: "t1" }).runs).toEqual([]);
    expect(traffic([notification("n1"), { ...reply("a1", "t1"), streaming: true }]).runs).toEqual(
      [],
    );
    expect(traffic([notification("n1")]).runs).toEqual([]);
  });
});

describe("stabilizeBackgroundTraffic", () => {
  it("keeps the previous result while only a live reply streams", () => {
    const settled = [notification("n1"), reply("a1", "t1"), person("u1")];
    const first = traffic([...settled, { ...reply("a2", "t2", "Wor"), streaming: true }]);
    const second = traffic([
      ...settled,
      { ...reply("a2", "t2", "Working on it"), streaming: true },
    ]);

    expect(second).not.toBe(first);
    expect(stabilizeBackgroundTraffic(first, second)).toBe(first);
  });

  it("replaces only the run that changed", () => {
    const head = [notification("n1"), reply("a1", "t1"), person("u1")];
    const first = traffic([...head, notification("n2"), reply("a2", "t2")]);
    const next = traffic([
      ...head,
      notification("n2"),
      reply("a2", "t2"),
      notification("n3"),
      reply("a3", "t3"),
    ]);

    const stable = stabilizeBackgroundTraffic(first, next);
    expect(stable.runs[0]).toBe(first.runs[0]);
    expect(stable.runs[1]).not.toBe(first.runs[1]);
    expect(stable.runs[1]!.turnCount).toBe(2);
  });
});

describe("resolveBackgroundFolds", () => {
  it("hides collapsed runs and keeps expanded ones as anchors only", () => {
    const { runs } = traffic([notification("n1"), reply("a1", "t1")]);
    const collapsed = resolveBackgroundFolds(runs, new Set());
    const expanded = resolveBackgroundFolds(runs, new Set([runs[0]!.id]));

    expect([...collapsed.hiddenMessageIds]).toEqual(["n1", "a1"]);
    expect([...collapsed.hiddenTurnIds]).toEqual(["t1"]);
    expect(expanded.hiddenMessageIds.size).toBe(0);
    expect(expanded.runByAnchorMessageId.get("n1")?.id).toBe(runs[0]!.id);
  });
});

describe("collectDescendantThreadIds", () => {
  it("walks every depth and ignores cycles", () => {
    const threads = [
      { id: "root" },
      { id: "child", parentThreadId: "root" },
      { id: "grandchild", parentThreadId: "child" },
      { id: "other", parentThreadId: null },
      { id: "loop", parentThreadId: "grandchild" },
      { id: "root", parentThreadId: "loop" },
    ];

    expect([...collectDescendantThreadIds("root", threads)].toSorted()).toEqual([
      "child",
      "grandchild",
      "loop",
    ]);
  });
});
