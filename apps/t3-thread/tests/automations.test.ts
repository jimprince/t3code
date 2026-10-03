import { Command } from "commander";
import { describe, expect, it } from "vite-plus/test";
import { registerAutomationCommands } from "../src/automations.js";

function harness() {
  const commands: unknown[] = [];
  const output: unknown[] = [];
  const program = new Command().exitOverride();
  registerAutomationCommands(program, {
    client: async () => ({
      listAutomations: async () => [],
      dispatchAutomation: async (command) => {
        commands.push(command);
        return [];
      },
    }),
    print: (value) => {
      output.push(value);
    },
  });
  return {
    commands,
    output,
    run: (args: string[]) =>
      program.parseAsync([
        "node",
        "t3-thread",
        "automation",
        ...args,
        "--env",
        "test",
        "--project",
        "project-1",
      ]),
  };
}

describe("automation operator commands", () => {
  it("adds a weekly prompt to an existing thread with a saved timezone", async () => {
    const h = harness();
    await h.run([
      "add",
      "--name",
      "Digest",
      "--prompt",
      "Summarize",
      "--schedule",
      "weekly",
      "--time",
      "08:15",
      "--day",
      "fri",
      "--timezone",
      "America/Toronto",
      "--thread",
      "root",
      "--owner-thread",
      "root",
    ]);
    expect(h.commands).toEqual([
      expect.objectContaining({
        type: "project.automation.create",
        projectId: "project-1",
        automation: expect.objectContaining({
          name: "Digest",
          target: { kind: "existing-thread", threadId: "root" },
          ownerThreadId: "root",
          schedule: { kind: "weekly", day: 5, time: "08:15", timeZone: "America/Toronto" },
        }),
      }),
    ]);
  });
  it("lists server-owned definitions without dispatch", async () => {
    const h = harness();
    await h.run(["list"]);
    expect(h.commands).toEqual([]);
    expect(h.output).toEqual([[]]);
  });
  it.each([
    ["pause", "pause"],
    ["resume", "resume"],
    ["remove", "delete"],
    ["run-now", "run"],
  ])("%s uses the orchestration transition", async (action, type) => {
    const h = harness();
    await h.run([action, "automation-1"]);
    expect(h.commands).toEqual([
      expect.objectContaining({
        type: `project.automation.${type}`,
        automationId: "automation-1",
        projectId: "project-1",
      }),
    ]);
  });
  it.each([
    ["--time", "25:00"],
    ["--timezone", "Invalid/Zone"],
    ["--schedule", "events"],
  ])("rejects invalid %s before dispatch", async (flag, value) => {
    const h = harness();
    await expect(
      h.run(["add", "--name", "Bad", "--prompt", "Prompt", flag, value]),
    ).rejects.toThrow();
    expect(h.commands).toEqual([]);
  });
});
