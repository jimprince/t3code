/** First message of a named agent's incarnation, built from its folder. */

const FILE_MAX_CHARS = 40_000;

function clip(text: string): string {
  return text.length > FILE_MAX_CHARS
    ? `${text.slice(0, FILE_MAX_CHARS)}\n[Truncated at ${FILE_MAX_CHARS} characters]`
    : text;
}

/** `scope:` from AGENT.md frontmatter, the agent's one-line description. */
export function readAgentScope(agentMarkdown: string | null): string | null {
  const frontmatter = agentMarkdown?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const scope = frontmatter?.match(/^scope:\s*(.+)$/m)?.[1]?.trim();
  return scope ? scope.replace(/^(["'])(.*)\1$/, "$2") : null;
}

export function buildIncarnationMessage(input: {
  readonly name: string;
  readonly folder: string;
  readonly agentMarkdown: string | null;
  readonly briefingMarkdown: string | null;
  readonly request: string | undefined;
}): string {
  const request = input.request?.trim();
  return [
    `You are the named agent "${input.name}". You alone operate what your charter owns: other threads send their requests to you by name, and you settle conflicts between them yourself. Sub-agents you start may research and prepare, but only you act on the resource.`,
    `Your folder is ${input.folder}. AGENT.md is your charter. BRIEFING.md is your running state: keep it current, and rewrite it before a handover, because nothing survives in this conversation alone.`,
    "",
    "## AGENT.md",
    input.agentMarkdown === null ? "(missing)" : clip(input.agentMarkdown.trim()),
    "",
    "## BRIEFING.md",
    input.briefingMarkdown === null || input.briefingMarkdown.trim() === ""
      ? "(empty)"
      : clip(input.briefingMarkdown.trim()),
    "",
    "## Request",
    request && request.length > 0
      ? request
      : "No request yet. Read your briefing and report your current state in a few lines.",
  ].join("\n");
}
