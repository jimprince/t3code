import { beforeEach, afterEach, vi, describe, expect, it } from "vite-plus/test";
import { Command } from "commander";
import type { RemoteEnvironmentClient } from "../src/client.js";
import {
  registerRequestOrderCommands,
  filingPlace,
  epicNumber,
} from "../src/requestOrderCommands.js";
function cli(supported = true) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const client = {
    describe: async () => ({ capabilities: { projectRequestOrder: supported } }),
    projectRequest: async (method: string, input: unknown) => {
      calls.push({ method, input });
      return input;
    },
  } as unknown as RemoteEnvironmentClient;
  const root = new Command().exitOverride();
  const request = root.command("request");
  registerRequestOrderCommands(
    request,
    async () => ({ agent: { threadId: "head" }, client }),
    () => undefined,
  );
  return {
    calls,
    parse: (args: string[]) => root.parseAsync(["request", ...args], { from: "user" }),
  };
}
describe("request ordering CLI", () => {
  beforeEach(() => vi.stubEnv("T3_THREAD_ID", "actual-caller"));
  afterEach(() => vi.unstubAllEnvs());
  it("parses placements, queue filters, next and clearing the epic", async () => {
    const app = cli();
    await app.parse(["order", "head", "12", "--after", "#11"]);
    await app.parse(["rank", "head", "12", "--none"]);
    await app.parse(["queue", "head", "--epic", "#300", "--all"]);
    await app.parse(["next", "head", "--epic", "300"]);
    await app.parse(["epic", "head", "12", "none"]);
    expect(app.calls).toEqual([
      {
        method: "projectRequestsOrder",
        input: {
          threadId: "head",
          actorThreadId: "actual-caller",
          reference: "12",
          place: { to: "after", reference: "#11" },
        },
      },
      {
        method: "projectRequestsOrder",
        input: {
          threadId: "head",
          actorThreadId: "actual-caller",
          reference: "12",
          place: { to: "none" },
        },
      },
      { method: "projectRequestsQueue", input: { threadId: "head", epic: 300, all: true } },
      { method: "projectRequestsNext", input: { threadId: "head", epic: 300 } },
      {
        method: "projectRequestsUpdate",
        input: { threadId: "head", reference: "12", partOf: null },
      },
    ]);
  });
  it("rejects ambiguous placement and unsupported servers without a write", async () => {
    const app = cli();
    await expect(app.parse(["order", "head", "12", "--top", "--bottom"])).rejects.toThrow(
      "exactly one",
    );
    expect(app.calls).toEqual([]);
    const old = cli(false);
    await expect(old.parse(["order", "head", "12", "--top"])).rejects.toThrow(
      "projectRequestOrder",
    );
    expect(old.calls).toEqual([]);
  });
  it("places agent filings when specified and leaves them new only without placement", () => {
    expect(filingPlace({ next: true })).toEqual({ to: "top" });
    expect(filingPlace({ last: true })).toEqual({ to: "bottom" });
    expect(filingPlace({ after: "#12" })).toEqual({ to: "after", reference: "#12" });
    expect(filingPlace({})).toBeUndefined();
    expect(() => filingPlace({ next: true, last: true })).toThrow("Choose one placement");
    expect(epicNumber("#300")).toBe(300);
    expect(() => epicNumber("0")).toThrow("positive issue number");
  });
});
