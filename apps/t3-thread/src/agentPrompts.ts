export type FollowUpKind = "clarify" | "revise" | "complete";

export function buildFollowUpMessage(kind: FollowUpKind, message?: string): string {
  const trimmed = message?.trim() ?? "";
  if (kind === "clarify") {
    return trimmed
      ? `Clarification request: ${trimmed}`
      : "Clarification request: explain the current blocker or ambiguous point briefly and concretely.";
  }

  if (kind === "revise") {
    return trimmed
      ? `Revision request: ${trimmed}`
      : "Revision request: revise the current approach and correct the problems in the previous result.";
  }

  return trimmed
    ? `Completion request: ${trimmed}`
    : "Completion request: continue from the current state and finish the task. Do not repeat prior context unless needed.";
}
