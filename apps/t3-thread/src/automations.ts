import * as NodeCrypto from "node:crypto";

import type { Command } from "commander";
import { RemoteEnvironmentClient } from "./client.js";
import { loadState, requireEnvironment } from "./state.js";

type AutomationClient = Pick<RemoteEnvironmentClient, "listAutomations" | "dispatchAutomation">;
type Options = {
  env: string;
  project: string;
  name: string;
  prompt: string;
  schedule: string;
  time: string;
  day: string;
  timezone: string;
  thread?: string;
  newThread?: boolean;
  ownerThread?: string;
  paused?: boolean;
};

function definition(options: Options) {
  if (options.thread && options.newThread) throw new Error("Choose --thread or --new-thread.");
  if (!["hourly", "daily", "weekly"].includes(options.schedule))
    throw new Error("Choose an hourly, daily, or weekly schedule.");
  if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(options.time))
    throw new Error("Time must be HH:MM in the 24-hour clock.");
  // Intl validates IANA zones using the same runtime that interprets the schedule.
  new Intl.DateTimeFormat("en", { timeZone: options.timezone });
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const day = days.indexOf(options.day.toLowerCase().slice(0, 3));
  if (options.schedule === "weekly" && day < 0) throw new Error("Invalid weekly day.");
  const schedule =
    options.schedule === "hourly"
      ? { kind: "hourly", timeZone: options.timezone }
      : options.schedule === "daily"
        ? { kind: "daily", time: options.time, timeZone: options.timezone }
        : { kind: options.schedule, time: options.time, day, timeZone: options.timezone };
  return {
    id: NodeCrypto.randomUUID(),
    name: options.name,
    prompt: options.prompt,
    schedule,
    target: options.thread
      ? { kind: "existing-thread", threadId: options.thread }
      : { kind: "new-thread" },
    enabled: !options.paused,
    ...(options.ownerThread ? { ownerThreadId: options.ownerThread } : {}),
  };
}

/** Registers project automation operations against the same server commands as the clients. */
export function registerAutomationCommands(
  program: Command,
  dependencies?: {
    client: (environment: string) => Promise<AutomationClient>;
    print: (value: unknown) => void;
  },
) {
  const client =
    dependencies?.client ??
    (async (name: string) =>
      new RemoteEnvironmentClient(requireEnvironment(await loadState(), name)));
  const print =
    dependencies?.print ??
    ((value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
  const automation = program.command("automation").description("Manage timed project automations");
  automation
    .command("list")
    .requiredOption("--env <name>")
    .requiredOption("--project <id>")
    .action(async (options: Options) =>
      print(await (await client(options.env)).listAutomations(options.project)),
    );
  automation
    .command("add")
    .requiredOption("--env <name>")
    .requiredOption("--project <id>")
    .requiredOption("--name <name>")
    .requiredOption("--prompt <text>")
    .option("--schedule <kind>", "daily, hourly, weekly", "daily")
    .option("--time <HH:MM>", "local time", "09:00")
    .option("--day <day>", "weekly day", "mon")
    .option("--timezone <zone>", "IANA timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .option("--thread <id>", "existing target thread")
    .option("--new-thread", "new thread each run (default)")
    .option("--owner-thread <id>", "orchestrator shown in Projects")
    .option("--paused", "create paused")
    .action(async (options: Options) => {
      const automation = definition(options);
      print(
        await (
          await client(options.env)
        ).dispatchAutomation({
          type: "project.automation.create",
          commandId: NodeCrypto.randomUUID(),
          projectId: options.project,
          automation,
        }),
      );
    });
  for (const [name, type] of [
    ["pause", "pause"],
    ["resume", "resume"],
    ["remove", "delete"],
    ["run-now", "run"],
  ] as const) {
    automation
      .command(name)
      .argument("<id>", "automation id")
      .requiredOption("--env <name>")
      .requiredOption("--project <id>")
      .action(async (id: string, options: Options) =>
        print(
          await (
            await client(options.env)
          ).dispatchAutomation({
            type: `project.automation.${type}`,
            commandId: NodeCrypto.randomUUID(),
            projectId: options.project,
            automationId: id,
          }),
        ),
      );
  }
}
