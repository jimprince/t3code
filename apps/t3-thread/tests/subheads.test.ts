import { Command } from "commander";
import { describe, expect, it, vi } from "vite-plus/test";
import { registerSubheadCommands } from "../src/subheads.js";

describe("subhead commands", () => {
  it("prints a generated retry ID before transport failure", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let announced = "";
    try {
      const program = new Command().exitOverride();
      registerSubheadCommands(program, {
        print: () => {},
        call: async (_env, _op, input) => {
          announced = stderr.mock.calls.map(([v]) => String(v)).join("");
          expect(announced).toContain(String(input.requestId));
          throw new Error("transport timeout");
        },
      });
      await expect(
        program.parseAsync(["node", "t3", "subhead", "send", "review", "Work", "--env", "test"]),
      ).rejects.toThrow("transport timeout");
      expect(announced).toMatch(/request-id/);
    } finally {
      stderr.mockRestore();
    }
  });
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
