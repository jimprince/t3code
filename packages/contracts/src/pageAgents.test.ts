import { describe, expect, it } from "vite-plus/test";

import {
  isPageAgentThreadId,
  makePageAgentThreadId,
  withoutPageAgentThreads,
} from "./pageAgents.ts";

describe("page agent thread ids", () => {
  it("reserves a namespace that client thread lists drop", () => {
    const pageAgent = makePageAgentThreadId("status-board", "4c1e");
    expect(isPageAgentThreadId(pageAgent)).toBe(true);
    expect(isPageAgentThreadId("4c1e-status-board")).toBe(false);

    const snapshot = { snapshotSequence: 3, threads: [{ id: "thread-1" }, { id: pageAgent }] };
    expect(withoutPageAgentThreads(snapshot)).toEqual({
      snapshotSequence: 3,
      threads: [{ id: "thread-1" }],
    });
    const visible = { threads: [{ id: "thread-1" }] };
    expect(withoutPageAgentThreads(visible)).toBe(visible);
  });
});
