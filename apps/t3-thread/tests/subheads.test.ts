import { Command } from "commander";
import { describe, expect, it } from "vite-plus/test";
import { registerSubheadCommands } from "../src/subheads.js";

describe("subhead commands", () => {
  it("keeps a supplied retry id and never sends a caller identity in request text", async () => {
    const calls: unknown[] = [];
    const program = new Command().exitOverride();
    registerSubheadCommands(program, {
      call: async (env, operation, input) => {
        calls.push({ env, operation, input });
        return {};
      },
      print: () => {},
    });
    await program.parseAsync([
      "node",
      "t3-thread",
      "subhead",
      "send",
      "review",
      "Review this",
      "--env",
      "test",
      "--request-id",
      "retry-1",
    ]);
    expect(calls).toEqual([
      {
        env: "test",
        operation: "send",
        input: { name: "review", request: "Review this", requestId: "retry-1" },
      },
    ]);
  });
  it("pulls a durable result by run id", async () => {
    const calls: unknown[] = [];
    const program = new Command().exitOverride();
    registerSubheadCommands(program, {
      call: async (env, operation, input) => {
        calls.push({ env, operation, input });
        return {};
      },
      print: () => {},
    });
    await program.parseAsync(["node", "t3-thread", "subhead", "result", "run-1", "--env", "test"]);
    expect(calls).toEqual([{ env: "test", operation: "result", input: { runId: "run-1" } }]);
  });
});
