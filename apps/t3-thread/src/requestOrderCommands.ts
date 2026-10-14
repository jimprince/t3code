import type { Command } from "commander";
import type { RemoteEnvironmentClient } from "./client.js";

export function epicNumber(value: string) {
  const n = Number(value.replace(/^#/, ""));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Epic must be a positive issue number.");
  return n;
}
export function filingPlace(options: { next?: boolean; last?: boolean; after?: string }) {
  if ([options.next, options.last, options.after !== undefined].filter(Boolean).length > 1)
    throw new Error("Choose one placement: --next, --last or --after.");
  return options.next
    ? { to: "top" }
    : options.last
      ? { to: "bottom" }
      : options.after !== undefined
        ? { to: "after", reference: options.after }
        : undefined;
}
export function registerRequestOrderCommands(
  request: Command,
  withAgent: (
    reference: string,
  ) => Promise<{ agent: { threadId: string }; client: RemoteEnvironmentClient }>,
  printJson: (value: unknown) => void,
) {
  async function orderedAgent(reference: string) {
    const result = await withAgent(reference);
    if (!(await result.client.describe()).capabilities.projectRequestOrder)
      throw new Error(
        "This server does not support projectRequestOrder; upgrade it to use request order, queue, next or epic.",
      );
    return result;
  }
  request
    .command("order")
    .alias("rank")
    .description("Move an item within its workstream, or an epic among workstreams")
    .argument("<thread>")
    .argument("<request>")
    .option("--top")
    .option("--bottom")
    .option("--before <number>")
    .option("--after <number>")
    .option("--none", "return to New")
    .action(
      async (
        reference,
        requestReference,
        options: {
          top?: boolean;
          bottom?: boolean;
          before?: string;
          after?: string;
          none?: boolean;
        },
      ) => {
        const chosen = [
          options.top,
          options.bottom,
          options.before !== undefined,
          options.after !== undefined,
          options.none,
        ].filter(Boolean);
        if (chosen.length !== 1)
          throw new Error("Choose exactly one of --top, --bottom, --before, --after or --none.");
        const place = options.top
          ? { to: "top" }
          : options.bottom
            ? { to: "bottom" }
            : options.none
              ? { to: "none" }
              : options.before !== undefined
                ? { to: "before", reference: options.before }
                : { to: "after", reference: options.after };
        const { agent: target, client } = await orderedAgent(reference);
        printJson(
          await client.projectRequest("projectRequestsOrder", {
            threadId: target.threadId,
            reference: requestReference,
            place,
            ...(process.env.T3_THREAD_ID ? { actorThreadId: process.env.T3_THREAD_ID } : {}),
          }),
        );
      },
    );
  for (const verb of ["queue", "next"] as const) {
    const command = request
      .command(verb)
      .argument("<thread>")
      .option("--epic <number>", "only this workstream");
    if (verb === "queue") command.option("--all", "include Later items");
    command.action(async (reference, options: { epic?: string; all?: boolean }) => {
      const { agent: target, client } = await orderedAgent(reference);
      printJson(
        await client.projectRequest(
          verb === "queue" ? "projectRequestsQueue" : "projectRequestsNext",
          {
            threadId: target.threadId,
            ...(options.epic === undefined ? {} : { epic: epicNumber(options.epic) }),
            ...(options.all ? { all: true } : {}),
          },
        ),
      );
    });
  }
  request
    .command("epic")
    .argument("<thread>")
    .argument("<request>")
    .argument("<epic>", "#N or none")
    .action(async (reference, requestReference, epic) => {
      const { agent: target, client } = await orderedAgent(reference);
      printJson(
        await client.projectRequest("projectRequestsUpdate", {
          threadId: target.threadId,
          reference: requestReference,
          partOf: epic === "none" ? null : epicNumber(epic),
        }),
      );
    });
}
