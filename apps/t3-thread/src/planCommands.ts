import * as NodeFSP from "node:fs/promises";
import { type Command } from "commander";
import { PlanId, ThreadId, PlanPublicationInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type RemoteEnvironmentClient } from "./client.js";

export interface PublishPlanOptions {
  readonly title: string;
  readonly owner: string;
  readonly file?: string;
  readonly key?: string;
  readonly planId?: string;
  readonly threads?: boolean;
}

const decodePublicationInput = Schema.decodeUnknownSync(PlanPublicationInput);

/** Validate explicit source identity before opening a write-capable connection. */
export async function publicationInput(threadId: string, options: PublishPlanOptions) {
  if (Boolean(options.file) === Boolean(options.planId))
    throw new Error("Choose exactly one source: --file <markdown> or --plan-id <id>.");
  if (options.file && !options.key)
    throw new Error(
      "Publishing a markdown file requires --key <stable-plan-name> for safe reruns.",
    );
  if (options.planId && options.key)
    throw new Error("--key is only for markdown files; proposed plans already have stable IDs.");
  let source: (typeof PlanPublicationInput.Type)["source"];
  if (options.file) {
    if ((await NodeFSP.stat(options.file)).size > 480000)
      throw new Error("The plan file is too large (maximum 120000 characters).");
    source = {
      type: "markdown",
      key: options.key!,
      markdown: await NodeFSP.readFile(options.file, "utf8"),
    };
  } else {
    source = {
      type: "proposed_plan",
      threadId: ThreadId.make(threadId),
      planId: PlanId.make(options.planId!),
    };
  }
  return decodePublicationInput({
    threadId,
    title: options.title,
    owner: options.owner,
    source,
    ...(options.threads ? { createThreads: true } : {}),
  });
}

export function registerPlanCommands(
  agent: Command,
  withAgent: (
    reference: string,
  ) => Promise<{ agent: { threadId: string }; client: RemoteEnvironmentClient }>,
  print: (value: unknown) => void,
) {
  agent
    .command("plan")
    .description("Publish an approved plan as an owned workstream")
    .command("publish")
    .argument("<thread>", "saved agent or raw thread UUID in the tracker project")
    .requiredOption("--title <title>", "workstream epic title")
    .requiredOption("--owner <owner>", "accountable owner (default owner for each task)")
    .option("--file <path>", "approved markdown file with a top-level task list")
    .option("--key <name>", "stable publication identity for a markdown file")
    .option("--plan-id <id>", "approved T3 proposed-plan artifact in this thread")
    .option("--threads", "start a nested, issue-linked worker for each task")
    .action(async (reference: string, options: PublishPlanOptions) => {
      const { agent: target, client } = await withAgent(reference);
      const input = await publicationInput(target.threadId, options);
      print(await client.publishPlan(input));
    });
}
