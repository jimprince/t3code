import { describe, expect, it } from "vite-plus/test";
import { deriveBackgroundTraffic } from "./backgroundTurns.ts";
import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";

const context = makeMessageOriginContext({ source: "thread-send", fromThreadId: "child" });
const messages = [
  { id: "u", role: "user", text: "update", context, runId: "run", createdAt: "1" },
  { id: "a", role: "assistant", text: "done", runId: "run", createdAt: "2" },
];
const input = {
  messages,
  workerThreadIds: new Set(["child"]),
  attentionTurnIds: new Set<string>(),
  liveTurnId: null,
};
describe("V2 worker traffic", () => {
  it("folds own descendants but keeps parent instructions and user turns", () => {
    expect(deriveBackgroundTraffic(input).runs[0]?.messageIds.size).toBe(2);
    expect(deriveBackgroundTraffic({ ...input, workerThreadIds: new Set() }).runs).toEqual([]);
    expect(
      deriveBackgroundTraffic({
        ...input,
        messages: messages.map((m) => ({ ...m, context: undefined })),
      }).runs,
    ).toEqual([]);
  });
  it("surfaces live, streaming, unanswered and pending-attention work", () => {
    expect(deriveBackgroundTraffic({ ...input, liveTurnId: "run" }).runs).toEqual([]);
    expect(
      deriveBackgroundTraffic({ ...input, attentionTurnIds: new Set(["run"]) }).attentionCount,
    ).toBe(1);
    expect(deriveBackgroundTraffic({ ...input, messages: [messages[0]!] }).runs).toEqual([]);
    expect(
      deriveBackgroundTraffic({
        ...input,
        messages: [messages[0]!, { ...messages[1]!, streaming: true }],
      }).runs,
    ).toEqual([]);
    expect(
      deriveBackgroundTraffic({
        ...input,
        messages: [messages[0]!, { ...messages[1]!, text: "Done\nT3_NOTIFY: attention" }],
      }).runs,
    ).toEqual([]);
  });
  it("uses native sender attribution and legacy notification names", () => {
    expect(
      deriveBackgroundTraffic({
        ...input,
        messages: [{ ...messages[0]!, context: undefined, senderThreadId: "child" }, messages[1]!],
      }).runs,
    ).toHaveLength(1);
    expect(
      deriveBackgroundTraffic({
        ...input,
        labelForThread: () => "worker",
        messages: [
          {
            ...messages[0]!,
            context: undefined,
            text: "T3 orchestrator notification: worker completed",
          },
          messages[1]!,
        ],
      }).runs,
    ).toHaveLength(1);
  });
});
