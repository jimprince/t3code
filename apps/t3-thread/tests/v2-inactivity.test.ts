import { describe, expect, it } from "vite-plus/test";
import { threadDetail } from "../src/v2/reads.js";
import { observeInactivity } from "../src/inactivity.js";
import { threadQuotaBlock } from "../src/quota.js";
import type { SavedSubscription } from "../src/types.js";
import { at, item, projection, request } from "./v2-fixture.js";
const route = (): SavedSubscription => ({
  subscriberThreadId: "parent",
  sourceThreadId: "worker",
  subscriberEnvironment: "test",
  sourceEnvironment: "test",
  subscriberAgentName: null,
  sourceAgentName: null,
  createdAt: at(),
  updatedAt: at(),
  inactivityMinutes: 1,
});

describe("V2 inactivity", () => {
  it.each(["reasoning", "command_execution", "dynamic_tool"])(
    "rearms when the same %s item updates",
    (type) => {
      const subscription = route();
      const fields =
        type === "command_execution"
          ? { input: "work" }
          : type === "dynamic_tool"
            ? { toolName: "work", input: "work" }
            : {};
      const thread = threadDetail(projection({ turnItems: [item(type, at(), fields)] }));
      expect(observeInactivity(subscription, thread, at())).toBe(false);
      expect(observeInactivity(subscription, thread, at(1))).toBe(true);
      const updated = threadDetail(projection({ turnItems: [item(type, at(1), fields)] }));
      expect(observeInactivity(subscription, updated, at(1))).toBe(false);
      expect(observeInactivity(subscription, updated, at(2))).toBe(true);
    },
  );
  it("resets after a gap and a new run, and ignores shell polling timestamps", () => {
    const subscription = route();
    const native = projection();
    const thread = threadDetail(native);
    observeInactivity(subscription, thread, at());
    expect(observeInactivity(subscription, { ...thread, updatedAt: at(3) }, at(3))).toBe(false);
    expect(observeInactivity(subscription, thread, at(4))).toBe(true);
    const next = threadDetail({
      ...native,
      runs: [{ ...native.runs[0]!, id: "next" as (typeof native.runs)[0]["id"] }],
    });
    expect(observeInactivity(subscription, next, at(4))).toBe(false);
  });
  it.each(["user_input", "command"])("does not alert while %s is pending", (kind) => {
    const subscription = route();
    const thread = threadDetail(
      projection({ runtimeRequests: [request("pending", "pending", kind)] }),
    );
    expect(observeInactivity(subscription, thread, at())).toBe(false);
    expect(observeInactivity(subscription, thread, at(10))).toBe(false);
    expect(subscription.inactivityObservation).toBeNull();
  });
  it.each(["settled", "archived", "disabled", "none"])("excludes %s", (state) => {
    const subscription = route();
    const thread = threadDetail(projection());
    if (state === "settled") thread.settledOverride = "settled";
    if (state === "archived") thread.archivedAt = at();
    if (state === "disabled") subscription.inactivityMinutes = 0;
    if (state === "none") subscription.level = "none";
    expect(observeInactivity(subscription, thread, at(10))).toBe(false);
  });
  it("reads current-run structured quota failures and a usable reset", () => {
    const native = projection({
      turnItems: [
        item("error", at(), {
          failure: {
            class: "usage_limit",
            message: "Limit",
            code: null,
            retryable: true,
            resetAt: at(5),
          },
        }),
      ],
    });
    const thread = threadDetail({
      ...native,
      runs: [{ ...native.runs[0]!, status: "failed", completedAt: native.updatedAt }],
    });
    expect(threadQuotaBlock(thread)).toEqual({ resetsAt: Date.parse(at(5)) });
    expect(observeInactivity(route(), thread, at(10))).toBe(false);
    expect(threadQuotaBlock(threadDetail(projection()))).toBeNull();
  });
});
