import { describe, expect, it } from "vite-plus/test";

import {
  orchestratorVisitKey,
  readOrchestratorLastVisit,
  recordOrchestratorVisit,
} from "./orchestratorVisit";

describe("orchestrator visit state", () => {
  it("round-trips a valid per-device visit and ignores corrupt state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    const key = orchestratorVisitKey("env", "root");
    values.set(key, "not-a-date");
    expect(readOrchestratorLastVisit(storage, "env", "root")).toBeNull();
    recordOrchestratorVisit(storage, "env", "root", "2026-10-03T08:00:00.000Z");
    expect(readOrchestratorLastVisit(storage, "env", "root")).toBe("2026-10-03T08:00:00.000Z");
  });
});
