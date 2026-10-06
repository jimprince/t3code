import * as Schema from "effect/Schema";

/** Request kinds the ledger tracks; each has its own lifecycle on the project page. */
const REQUEST_KINDS = [
  "bug",
  "feature",
  "question",
  "deliverable",
  "plan",
  "change",
  "test",
  "maintenance",
] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

const REQUEST_ITEMS_PROMPT = `You extract the requests a person made in one chat message to their AI agents, so each request can be tracked until the person settles it.

Return one item per distinct thing they asked for. Classify each:
- bug: something is broken or behaves wrongly and they want it fixed.
- feature: they want a new capability that does not exist yet.
- question: they want an answer or an explanation ("can we connect X to Y?", "why did Z fail?").
- deliverable: they want something produced to look at: a draft, ideas, a mock-up, a document, research.
- plan: they want something scoped or planned before it is done.
- change: they want something that exists adjusted, configured, deployed or merged.
- test: they want something tried, run or verified.
- maintenance: upkeep with no new behavior: dependency or upstream syncs, CI repair, cleanup, migrations, releases.

Return no items when the message only acknowledges, approves, continues, nudges, answers the agent's own question, gives feedback without a new ask, or asks for status ("do it", "continue", "yes", "looks good", "how is it going?", "where are we?", "did it work?", "check again").

title: the request in the person's own words, at most 90 characters; keep a question as a question.
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
          excerpt: Schema.String,
          existing: Schema.NullOr(Schema.Number),
        }),
      ),
    }),
  };
}
