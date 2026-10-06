import * as Schema from "effect/Schema";

/** Item types the ledger tracks; each has its own lifecycle on the project page. */
const REQUEST_KINDS = ["question", "task", "epic"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

const REQUEST_ITEMS_PROMPT = `You extract the requests a person made in one chat message to their AI agents, so each request can be tracked until the person settles it.

Return one item per distinct thing they asked for. Classify each:
- question: they want information back and nothing changes ("what is...", "can we connect X to Y?", "why did Z fail?").
- task: they want something done, even when phrased "can you / can we...?": a fix, a new capability, an adjustment, a deploy or merge, a test run, upkeep, a draft, research or a document to look at.
- epic: too big for one worker turn: a plan, a port, anything with phases or milestones.
Set bug to true only for a task about something broken or behaving wrongly that they want fixed; otherwise false.

Return no items when the message only acknowledges, approves, continues, nudges, answers the agent's own question, gives feedback without a new ask, or asks for status ("do it", "continue", "yes", "looks good", "how is it going?", "where are we?", "did it work?", "check again").

title: a short deliverable title for a project board, under 70 characters, not the person's words (those are kept separately). A task is an imperative naming what gets delivered ("Troubleshoot the T3 orchestrator's stalled workers", "Add a dark mode toggle to settings"); an epic names the plan the same way; a question is a crisp question ("Why did the nightly deploy fail?"). Never start with "Can you", "Could you", "Please", "I want", "Let's", a greeting or a filler word, and give a task no trailing period or question mark.
excerpt: the exact sentence or sentences of the message that make this request.
existing: when open issues are listed below, the number of the one this request continues, refines, follows up on or repeats (most messages in an ongoing conversation continue its current issue), or null only for a genuinely new piece of work none of them covers.
Never invent requests or split one request into its steps.`;

/** An open issue a message may continue, offered to the model by number and title. */
export interface RequestCandidate {
  readonly number: number;
  readonly title: string;
  /** Linked to the conversation the message was sent in. */
  readonly inThread: boolean;
}

export function buildRequestItemsPrompt(input: {
  message: string;
  threadTitle?: string | undefined;
  candidates?: ReadonlyArray<RequestCandidate> | undefined;
}) {
  const message = input.message.length > 8_000 ? input.message.slice(0, 8_000) : input.message;
  const context = input.threadTitle ? `\n\nConversation title: ${input.threadTitle}` : "";
  const candidates = input.candidates ?? [];
  const open =
    candidates.length === 0
      ? "\n\nOpen issues: none."
      : `\n\nOpen issues:\n${candidates
          .map(
            (candidate) =>
              `#${candidate.number}${candidate.inThread ? " (this conversation)" : ""}: ${candidate.title.replace(/\s+/g, " ").slice(0, 120)}`,
          )
          .join("\n")}`;
  return {
    prompt: `${REQUEST_ITEMS_PROMPT}${context}${open}\n\nMessage:\n${message}`,
    outputSchema: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          kind: Schema.Literals(REQUEST_KINDS),
          bug: Schema.Boolean,
          excerpt: Schema.String,
          existing: Schema.NullOr(Schema.Number),
        }),
      ),
    }),
  };
}
