import { Command } from "commander";
import { describe, expect, it } from "vite-plus/test";
import { parseDays, registerAutomationCommands } from "../src/automations.js";

function harness(
  scripts: Array<{ id: string; name: string; projectId: string | null }> = [],
  automations: Array<Record<string, unknown>> = [],
) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const program = new Command().exitOverride();
  registerAutomationCommands(program, {
    client: async () => ({
      automationRpc: async <T>(method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === "automationScriptsList") return { scripts } as T;
        if (method === "automationsList") return { automations } as T;
        return {} as T;
      },
    }),
    print: () => {},
  });
  return {
    calls,
    run: (args: string[]) => program.parseAsync(["node", "t3-thread", ...args, "--env", "test"]),
  };
}

describe("automation operator commands", () => {
  it("adds a weekly prompt to an existing thread with a saved timezone, defaulting to act", async () => {
    const h = harness();
    await h.run([
      "automation",
      "add",
      "--project",
      "project-1",
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
    expect(h.calls).toEqual([
      {
        method: "automationsSave",
        input: expect.objectContaining({
          projectId: "project-1",
          name: "Digest",
          enabled: true,
          ownerThreadId: "root",
          triggers: [
            {
              type: "schedule",
              schedule: { kind: "weekly", day: 5, time: "08:15", timeZone: "America/Toronto" },
            },
          ],
          actions: [
            {
              type: "agent",
              prompt: "Summarize",
              resultMode: "act",
              target: { kind: "existing-thread", threadId: "root" },
            },
          ],
        }),
      },
    ]);
  });

  it("leaves a new-thread automation with no default result mode", async () => {
    const h = harness();
    await h.run([
      "automation",
      "add",
      "--project",
      "project-1",
      "--name",
      "Digest",
      "--prompt",
      "Summarize",
    ]);
    const [call] = h.calls;
    expect(call?.input.actions).toEqual([
      { type: "agent", prompt: "Summarize", target: { kind: "new-thread" } },
    ]);
  });

  it("honors an explicit --result-mode over the --thread default", async () => {
    const h = harness();
    await h.run([
      "automation",
      "add",
      "--project",
      "project-1",
      "--name",
      "Digest",
      "--prompt",
      "Summarize",
      "--thread",
      "root",
      "--result-mode",
      "review",
    ]);
    expect(h.calls[0]?.input).toMatchObject({
      actions: [{ type: "agent", prompt: "Summarize", resultMode: "review" }],
    });
  });

  it("schedules a saved script on weekdays", async () => {
    const h = harness();
    await h.run([
      "automation",
      "add",
      "--project",
      "project-1",
      "--name",
      "Standup",
      "--script",
      "review-prs",
      "--schedule",
      "weekdays",
      "--days",
      "mon-fri",
      "--timezone",
      "UTC",
    ]);
    expect(h.calls[0]?.input).toMatchObject({
      triggers: [
        {
          schedule: { kind: "weekdays", days: [1, 2, 3, 4, 5], time: "09:00", timeZone: "UTC" },
        },
      ],
      actions: [{ type: "agent", script: "review-prs", target: { kind: "new-thread" } }],
    });
  });

  it("adds an event trigger without a schedule", async () => {
    const h = harness();
    await h.run([
      "automation",
      "add",
      "--project",
      "p",
      "--name",
      "CI watch",
      "--script",
      "fix-ci",
      "--on",
      "ci.failed",
      "--repository",
      "brad/t3code-fork",
    ]);
    expect(h.calls[0]?.input).toMatchObject({
      triggers: [{ type: "event", event: "ci.failed", filter: { repository: "brad/t3code-fork" } }],
    });
    await expect(
      h.run([
        "automation",
        "add",
        "--project",
        "p",
        "--name",
        "x",
        "--prompt",
        "y",
        "--on",
        "push",
      ]),
    ).rejects.toThrow();
  });

  it("parses day lists and wrapping ranges", () => {
    expect(parseDays("mon,wed,fri")).toEqual([1, 3, 5]);
    expect(parseDays("fri-mon")).toEqual([0, 1, 5, 6]);
    expect(() => parseDays("funday")).toThrow();
  });

  it("changes an existing automation's result mode on every action", async () => {
    const existing = {
      id: "a1",
      projectId: "project-1",
      name: "Digest",
      enabled: true,
      triggers: [{ type: "schedule", schedule: { kind: "daily", time: "09:00", timeZone: "UTC" } }],
      actions: [
        {
          type: "agent",
          prompt: "Summarize",
          resultMode: "review",
          target: { kind: "new-thread" },
        },
      ],
      nextRunAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const h = harness([], [existing]);
    await h.run(["automation", "edit", "a1", "--result-mode", "act"]);
    expect(h.calls).toEqual([
      { method: "automationsList", input: {} },
      {
        method: "automationsSave",
        input: expect.objectContaining({
          id: "a1",
          projectId: "project-1",
          name: "Digest",
          actions: [
            {
              type: "agent",
              prompt: "Summarize",
              resultMode: "act",
              target: { kind: "new-thread" },
            },
          ],
        }),
      },
    ]);
  });

  it("re-owns an automation without touching its result modes", async () => {
    const existing = {
      id: "a1",
      projectId: "project-1",
      name: "Digest",
      enabled: true,
      ownerThreadId: "old-orchestrator",
      triggers: [{ type: "schedule", schedule: { kind: "daily", time: "09:00", timeZone: "UTC" } }],
      actions: [
        {
          type: "agent",
          prompt: "Summarize",
          resultMode: "review",
          target: { kind: "new-thread" },
        },
      ],
      nextRunAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const h = harness([], [existing]);
    await h.run(["automation", "edit", "a1", "--owner-thread", "new-orchestrator"]);
    expect(h.calls.at(-1)).toEqual({
      method: "automationsSave",
      input: expect.objectContaining({
        ownerThreadId: "new-orchestrator",
        actions: [expect.objectContaining({ resultMode: "review" })],
      }),
    });
    await expect(h.run(["automation", "edit", "a1"])).rejects.toThrow(/--owner-thread/);
  });

  it("rejects editing an automation that does not exist", async () => {
    const h = harness();
    await expect(h.run(["automation", "edit", "missing", "--result-mode", "act"])).rejects.toThrow(
      /No automation/,
    );
  });

  it.each([
    [["pause", "a1"], "automationsSetEnabled", { automationId: "a1", enabled: false }],
    [["resume", "a1"], "automationsSetEnabled", { automationId: "a1", enabled: true }],
    [["remove", "a1"], "automationsRemove", { automationId: "a1" }],
    [["run-now", "a1", "--dry-run"], "automationsRun", { automationId: "a1", dryRun: true }],
  ] as const)("%s maps to its server call", async (args, method, input) => {
    const h = harness();
    await h.run(["automation", ...args, "--project", "project-1"]);
    expect(h.calls).toEqual([{ method, input }]);
  });

  it.each([
    ["--time", "25:00"],
    ["--timezone", "Invalid/Zone"],
    ["--schedule", "events"],
    ["--cron", "* * *"],
  ])("rejects invalid %s before calling the server", async (flag, value) => {
    const h = harness();
    const schedule = flag === "--cron" ? ["--schedule", "cron"] : [];
    await expect(
      h.run([
        "automation",
        "add",
        "--project",
        "p",
        "--name",
        "Bad",
        "--prompt",
        "Prompt",
        ...schedule,
        flag,
        value,
      ]),
    ).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it("replaces a same-named script in the same scope instead of duplicating it", async () => {
    const h = harness([{ id: "s1", name: "review-prs", projectId: null }]);
    await h.run(["script", "add", "--global", "--name", "review-prs", "--prompt", "Review"]);
    expect(h.calls.at(-1)).toEqual({
      method: "automationScriptsSave",
      input: { id: "s1", projectId: null, name: "review-prs", prompt: "Review" },
    });
  });

  it("carries result modes on scripts and per run", async () => {
    const h = harness();
    await h.run([
      "script",
      "add",
      "--global",
      "--name",
      "audit",
      "--prompt",
      "Audit",
      "--result-mode",
      "file-only",
    ]);
    expect(h.calls.at(-1)?.input).toMatchObject({ resultMode: "file-only" });
    await h.run(["script", "run", "audit", "--project", "p", "--mode", "file-and-settle"]);
    expect(h.calls.at(-1)?.input).toMatchObject({ resultMode: "file-and-settle" });
    await expect(
      h.run([
        "script",
        "add",
        "--global",
        "--name",
        "x",
        "--prompt",
        "y",
        "--result-mode",
        "later",
      ]),
    ).rejects.toThrow();
  });

  it("runs a script in an existing thread", async () => {
    const h = harness();
    await h.run(["script", "run", "check-logs", "--project", "p", "--thread", "t1"]);
    expect(h.calls).toEqual([
      {
        method: "automationScriptsRun",
        input: {
          projectId: "p",
          script: "check-logs",
          target: { kind: "existing-thread", threadId: "t1" },
        },
      },
    ]);
  });
});
