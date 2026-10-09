import { expect, it } from "vite-plus/test";
import { Command } from "commander";
import type { RemoteEnvironmentClient } from "../src/client.js";
import { registerRecoveryCommands } from "../src/recoveryCommands.js";

it("validates recovery CLI targets and sends the exact supported RPCs", async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const outputs: unknown[] = [];
  const client = {
    recoveryRpc: async (method: string, input: unknown) => {
      calls.push({ method, input });
      return { receipt: method };
    },
  } as unknown as RemoteEnvironmentClient;
  const root = new Command().exitOverride();
  const agent = root.command("agent");
  const session = agent.command("session");
  registerRecoveryCommands(
    agent,
    session,
    async () => ({ agent: { threadId: "exact-thread", environment: "test" }, client }),
    async () => client,
    (value) => outputs.push(value),
  );
  for (const args of [
    ["agent", "session", "generation", "chief"],
    ["agent", "session", "stop-receipt", "chief", "--run-id", "original-run"],
    [
      "agent",
      "resume",
      "chief",
      "--expected-generation",
      "7",
      "--request-id",
      "resume-once",
      "--message",
      "Continue",
    ],
    ["agent", "human", "pending-list", "chief"],
    ["agent", "send-binding", "chief", "send-once"],
  ])
    await root.parseAsync(args, { from: "user" });
  expect(calls).toEqual([
    { method: "thread.session.generation", input: { threadId: "exact-thread" } },
    { method: "thread.stop.receipt", input: { threadId: "exact-thread", runId: "original-run" } },
    {
      method: "thread.resume",
      input: {
        threadId: "exact-thread",
        expectedGeneration: 7,
        requestId: "resume-once",
        message: "Continue",
      },
    },
    { method: "thread.human.pending.list", input: { threadId: "exact-thread" } },
    { method: "thread.send.binding", input: { threadId: "exact-thread", sendId: "send-once" } },
  ]);
  expect(outputs).toHaveLength(5);
  await expect(
    root.parseAsync(
      ["agent", "resume", "chief", "--expected-generation", "-1", "--request-id", "invalid"],
      { from: "user" },
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(5);
});
