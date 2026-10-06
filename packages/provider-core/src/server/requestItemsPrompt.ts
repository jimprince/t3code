import * as Schema from "effect/Schema";

/** Request kinds the ledger tracks; each has its own lifecycle on the project page. */
const REQUEST_KINDS = ["question", "deliverable", "plan", "change", "test"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

const REQUEST_ITEMS_PROMPT = `You extract the requests a person made in one chat message to their AI agents, so each request can be tracked until the person settles it.

Return one item per distinct thing they asked for. Classify each:
- question: they want an answer or an explanation ("can we connect X to Y?", "why did Z fail?").
- deliverable: they want something produced to look at: a draft, ideas, a mock-up, a document, research.
- plan: they want something scoped or planned before it is done.
- change: they want something built, fixed, configured, deployed or merged.
- test: they want something tried, run or verified.

Return no items when the message only acknowledges, approves, continues, nudges, answers the agent's own question, gives feedback without a new ask, or asks for status ("do it", "continue", "yes", "looks good", "how is it going?", "where are we?").

title: the request in the person's own words, at most 90 characters; keep a question as a question.
excerpt: the exact sentence or sentences of the message that make this request.
Never invent requests or split one request into its steps.`;

export function buildRequestItemsPrompt(input: {
  message: string;
  threadTitle?: string | undefined;
}) {
  const message = input.message.length > 8_000 ? input.message.slice(0, 8_000) : input.message;
  const context = input.threadTitle ? `\n\nConversation title: ${input.threadTitle}` : "";
  return {
    prompt: `${REQUEST_ITEMS_PROMPT}${context}\n\nMessage:\n${message}`,
    outputSchema: Schema.Struct({
      items: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          kind: Schema.Literals(REQUEST_KINDS),
          excerpt: Schema.String,
        }),
      ),
    }),
  };
}
