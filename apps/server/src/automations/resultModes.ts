import type { AutomationResultMode } from "@t3tools/contracts";

const FILE = [
  "File each finding worth acting on as its own request, one per command:",
  '`t3-thread request add "$T3_THREAD_ID" "<short title>" --kind <bug|feature|maintenance|change|test|question> --detail "<evidence and suggested action>"`.',
  "Skip findings that duplicate an open request. End with a numbered summary of what you filed and what you left out, and why.",
];

const INSTRUCTIONS: Record<AutomationResultMode, readonly string[]> = {
  review: [
    "File nothing and change nothing. End with your findings as a numbered list, most important first, each with its evidence and a suggested action.",
    "Leave this thread open: Brad reads it and tells you which findings to follow up or file.",
  ],
  "file-only": [...FILE, "Leave this thread open."],
  "file-and-settle": [
    ...FILE,
    'Then, as your very last action, settle this thread: `t3-thread settle "$T3_THREAD_ID" --self`.',
  ],
};

/** Appends the run's result mode and what it requires, so the agent can read it from its prompt. */
export function withResultMode(prompt: string, mode: AutomationResultMode | undefined): string {
  if (mode === undefined) return prompt;
  return `${prompt}\n\n---\nResult mode: ${mode}\n${INSTRUCTIONS[mode].join("\n")}`;
}
