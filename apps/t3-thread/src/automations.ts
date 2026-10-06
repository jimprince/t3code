import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import {
  AutomationDefinition,
  AutomationScriptDefinition,
  type Automation,
} from "@t3tools/contracts/automations";
import * as Schema from "effect/Schema";
import type { Command } from "commander";
import { RemoteEnvironmentClient } from "./client.js";
import { loadState, requireEnvironment } from "./state.js";

type AutomationClient = Pick<RemoteEnvironmentClient, "automationRpc">;
type Options = {
  env: string;
  project?: string;
  global?: boolean;
  name: string;
  prompt?: string;
  promptFile?: string;
  script?: string;
  description?: string;
  schedule?: string;
  on?: string;
  repository?: string;
  label?: string;
  forThread?: string;
  time: string;
  day: string;
  days?: string;
  cron?: string;
  timezone: string;
  thread?: string;
  newThread?: boolean;
  ownerThread?: string;
  paused?: boolean;
  dryRun?: boolean;
  limit?: string;
  resultMode?: string;
  mode?: string;
};

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const decodeDefinition = Schema.decodeUnknownSync(AutomationDefinition);
const decodeScript = Schema.decodeUnknownSync(AutomationScriptDefinition);

function day(value: string) {
  const index = DAYS.indexOf(value.trim().toLowerCase().slice(0, 3));
  if (index === -1) throw new Error(`Unknown day "${value}". Use sun, mon, ... sat.`);
  return index;
}

/** Parses `mon-fri`, `mon,wed,fri` or `sat-sun` into weekday numbers (0 = Sunday). */
export function parseDays(value: string): number[] {
  const days = new Set<number>();
  for (const part of value.split(",")) {
    const [from, to] = part.split("-");
    if (to === undefined) {
      days.add(day(from!));
      continue;
    }
    for (let index = day(from!); ; index = (index + 1) % 7) {
      days.add(index);
      if (index === day(to)) break;
    }
  }
  return [...days].sort((a, b) => a - b);
}

function schedule(options: Options) {
  const timeZone = options.timezone;
  switch (options.schedule ?? (options.on ? "manual" : "daily")) {
    case "manual":
      return null;
    case "hourly":
      return { kind: "hourly", timeZone };
    case "daily":
      return { kind: "daily", time: options.time, timeZone };
    case "weekly":
      return { kind: "weekly", time: options.time, day: day(options.day), timeZone };
    case "weekdays":
      return {
        kind: "weekdays",
        time: options.time,
        days: parseDays(options.days ?? "mon-fri"),
        timeZone,
      };
    case "cron":
      if (!options.cron) throw new Error("--schedule cron needs --cron '<expression>'.");
      return { kind: "cron", expression: options.cron, timeZone };
    default:
      throw new Error(`Unknown schedule "${options.schedule}".`);
  }
}

function prompt(options: Options) {
  return options.promptFile ? NodeFS.readFileSync(options.promptFile, "utf8") : options.prompt;
}

function definition(options: Options) {
  if (options.thread && options.newThread) throw new Error("Choose --thread or --new-thread.");
  const text = prompt(options);
  if ((text === undefined) === (options.script === undefined))
    throw new Error("Give exactly one of --prompt, --prompt-file or --script.");
  const timing = schedule(options);
  /** An existing-thread run is a turn in a thread Brad already uses; default it to acting rather
   * than the server's review fallback, which would tell it to change nothing. */
  const resultMode = options.resultMode ?? (options.thread ? "act" : undefined);
  return decodeDefinition({
    id: NodeCrypto.randomUUID(),
    projectId: options.project,
    name: options.name,
    enabled: !options.paused,
    ...(options.ownerThread ? { ownerThreadId: options.ownerThread } : {}),
    triggers: [
      ...(timing ? [{ type: "schedule", schedule: timing }] : []),
      ...(options.on
        ? [
            {
              type: "event",
              event: options.on,
              ...(options.repository || options.label || options.forThread
                ? {
                    filter: {
                      ...(options.repository ? { repository: options.repository } : {}),
                      ...(options.label ? { label: options.label } : {}),
                      ...(options.forThread ? { threadId: options.forThread } : {}),
                    },
                  }
                : {}),
            },
          ]
        : []),
    ],
    actions: [
      {
        type: "agent",
        ...(options.script ? { script: options.script } : { prompt: text }),
        ...(resultMode ? { resultMode } : {}),
        target: options.thread
          ? { kind: "existing-thread", threadId: options.thread }
          : { kind: "new-thread" },
      },
    ],
  });
}

/**
 * Registers `automation` (rules: schedule triggers -> agent actions) and `script` (named prompt
 * procedures) against the server's automations.* and automationScripts.* RPCs.
 */
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
  const call = async (
    env: string,
    method: Parameters<AutomationClient["automationRpc"]>[0],
    input: Record<string, unknown>,
  ) => print(await (await client(env)).automationRpc(method, input));

  const automation = program
    .command("automation")
    .description("Manage automation rules: schedule triggers that start agent turns");
  automation
    .command("list")
    .description("List automations, for one project or the whole environment")
    .requiredOption("--env <name>")
    .option("--project <id>")
    .action((options: Options) =>
      call(options.env, "automationsList", options.project ? { projectId: options.project } : {}),
    );
  automation
    .command("add")
    .requiredOption("--env <name>")
    .requiredOption("--project <id>")
    .requiredOption("--name <name>")
    .option("--prompt <text>", "inline prompt")
    .option("--prompt-file <path>", "read the prompt from a file")
    .option("--script <name>", "run a saved script (see `t3-thread script list`)")
    .option(
      "--schedule <kind>",
      "hourly, daily, weekly, weekdays, cron or manual (default daily, or none with --on)",
    )
    .option(
      "--on <event>",
      "pull-request.opened, ci.failed, issue.labeled (needs --owner-thread), worker.blocked or release.published (needs --repository)",
    )
    .option("--repository <owner/name>", "only events from this repository")
    .option("--label <label>", "issue.labeled: only this label")
    .option("--for-thread <id>", "only events from this thread")
    .option("--time <HH:MM>", "local time", "09:00")
    .option("--day <day>", "weekly day", "mon")
    .option("--days <days>", "weekdays schedule: mon-fri, mon,wed,fri", "mon-fri")
    .option("--cron <expression>", "five-field cron expression for --schedule cron")
    .option("--timezone <zone>", "IANA timezone", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .option("--thread <id>", "existing target thread")
    .option("--new-thread", "new thread each run (default)")
    .option("--owner-thread <id>", "orchestrator shown in Projects")
    .option("--paused", "create paused")
    .option(
      "--result-mode <mode>",
      "review (default: file nothing, thread stays open), file-only, file-and-settle, or act (no filing/settling instructions; default with --thread)",
    )
    .action((options: Options) => call(options.env, "automationsSave", definition(options)));
  automation
    .command("edit")
    .description("Change an existing automation's result mode")
    .argument("<id>", "automation id")
    .requiredOption("--env <name>")
    .option("--project <id>", "accepted for compatibility")
    .requiredOption(
      "--result-mode <mode>",
      "review, file-only, file-and-settle, or act, applied to every action",
    )
    .action(async (id: string, options: Options) => {
      const automations = (
        await (
          await client(options.env)
        ).automationRpc<{ automations: Automation[] }>("automationsList", {})
      ).automations;
      const current = automations.find((automation) => automation.id === id);
      if (!current) throw new Error(`No automation "${id}".`);
      await call(
        options.env,
        "automationsSave",
        decodeDefinition({
          id: current.id,
          projectId: current.projectId,
          name: current.name,
          enabled: current.enabled,
          ...(current.ownerThreadId ? { ownerThreadId: current.ownerThreadId } : {}),
          triggers: current.triggers,
          actions: current.actions.map((action) => ({
            ...action,
            resultMode: options.resultMode,
          })),
        }),
      );
    });
  for (const [name, enabled] of [
    ["pause", false],
    ["resume", true],
  ] as const) {
    automation
      .command(name)
      .argument("<id>", "automation id")
      .requiredOption("--env <name>")
      .option("--project <id>", "accepted for compatibility")
      .action((id: string, options: Options) =>
        call(options.env, "automationsSetEnabled", { automationId: id, enabled }),
      );
  }
  automation
    .command("remove")
    .argument("<id>", "automation id")
    .requiredOption("--env <name>")
    .option("--project <id>", "accepted for compatibility")
    .action((id: string, options: Options) =>
      call(options.env, "automationsRemove", { automationId: id }),
    );
  automation
    .command("run-now")
    .argument("<id>", "automation id")
    .requiredOption("--env <name>")
    .option("--project <id>", "accepted for compatibility")
    .option("--dry-run", "record what would run without starting anything")
    .action((id: string, options: Options) =>
      call(options.env, "automationsRun", {
        automationId: id,
        ...(options.dryRun ? { dryRun: true } : {}),
      }),
    );
  automation
    .command("runs")
    .description("Show the run log: trigger, each step, resulting thread")
    .argument("[id]", "automation id (all when omitted)")
    .requiredOption("--env <name>")
    .option("--project <id>")
    .option("--limit <n>", "newest runs to show", "20")
    .action((id: string | undefined, options: Options) =>
      call(options.env, "automationsRuns", {
        ...(id ? { automationId: id } : {}),
        ...(options.project ? { projectId: options.project } : {}),
        limit: Number(options.limit),
      }),
    );

  const script = program
    .command("script")
    .description("Manage scripts: named prompt procedures, per project or global");
  const scriptsIn = async (env: string, projectId: string | undefined) =>
    (
      await (
        await client(env)
      ).automationRpc<{ scripts: Array<{ id: string; name: string; projectId: string | null }> }>(
        "automationScriptsList",
        projectId ? { projectId } : {},
      )
    ).scripts;
  const scope = (options: Options) => {
    if (Boolean(options.project) === Boolean(options.global))
      throw new Error("Choose --project <id> or --global.");
    return options.project ?? null;
  };
  script
    .command("add")
    .description("Add a script, or replace the one with the same name in that scope")
    .requiredOption("--env <name>")
    .option("--project <id>")
    .option("--global", "available to every project")
    .requiredOption("--name <name>", "lowercase, digits, . _ -")
    .option("--prompt <text>")
    .option("--prompt-file <path>")
    .option("--description <text>")
    .option(
      "--result-mode <mode>",
      "review (default: file nothing, thread stays open), file-only, file-and-settle, or act (no filing/settling instructions)",
    )
    .action(async (options: Options) => {
      const projectId = scope(options);
      const text = prompt(options);
      if (text === undefined) throw new Error("Give --prompt or --prompt-file.");
      const existing = (await scriptsIn(options.env, projectId ?? undefined)).find(
        (entry) => entry.name === options.name && entry.projectId === projectId,
      );
      await call(
        options.env,
        "automationScriptsSave",
        decodeScript({
          id: existing?.id ?? NodeCrypto.randomUUID(),
          projectId,
          name: options.name,
          prompt: text,
          ...(options.description ? { description: options.description } : {}),
          ...(options.resultMode ? { resultMode: options.resultMode } : {}),
        }),
      );
    });
  script
    .command("list")
    .description("List a project's scripts plus global ones, or only global ones")
    .requiredOption("--env <name>")
    .option("--project <id>")
    .action((options: Options) =>
      call(
        options.env,
        "automationScriptsList",
        options.project ? { projectId: options.project } : {},
      ),
    );
  script
    .command("run")
    .description("Run a script now in a new thread, or as a turn in --thread")
    .argument("<name>", "script name")
    .requiredOption("--env <name>")
    .requiredOption("--project <id>")
    .option("--thread <id>", "existing target thread")
    .option("--owner-thread <id>", "nest the new thread under this orchestrator")
    .option("--mode <mode>", "result mode for this run, overriding the script's")
    .option("--dry-run", "record what would run without starting anything")
    .action((name: string, options: Options) =>
      call(options.env, "automationScriptsRun", {
        projectId: options.project,
        script: name,
        ...(options.thread
          ? { target: { kind: "existing-thread", threadId: options.thread } }
          : {}),
        ...(options.ownerThread ? { ownerThreadId: options.ownerThread } : {}),
        ...(options.mode ? { resultMode: options.mode } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      }),
    );
  script
    .command("remove")
    .argument("<name>", "script name")
    .requiredOption("--env <name>")
    .option("--project <id>")
    .option("--global")
    .action(async (name: string, options: Options) => {
      const projectId = scope(options);
      const match = (await scriptsIn(options.env, projectId ?? undefined)).find(
        (entry) => entry.name === name && entry.projectId === projectId,
      );
      if (!match) throw new Error(`No script "${name}" in that scope.`);
      await call(options.env, "automationScriptsRemove", { scriptId: match.id });
    });
}
