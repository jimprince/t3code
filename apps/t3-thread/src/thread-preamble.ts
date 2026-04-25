/**
 * Canonical preamble injected into the initial message of every
 * `t3-agent agent create` invocation (unless `--no-preamble` is passed).
 *
 * Purpose: make every T3 worker thread aware that it is a T3 worker and
 * point it at the canonical skill, without duplicating the skill body
 * into every brief. Updates to the skill file propagate automatically
 * because workers re-read it on demand.
 *
 * If you change this preamble, also review:
 *   - ~/.shared/skills/t3-threads/SKILL.md (Auto-Preamble section)
 *   - any tests that assert its shape
 */
export const THREAD_PREAMBLE = [
  "You are a T3 worker thread. Before acting on the brief below, read and follow:",
  "  ~/.shared/skills/t3-threads/SKILL.md",
  "If you need to coordinate with a parent thread, use `t3-agent agent send <name> ...`.",
  "",
  "--- BRIEF ---",
].join("\n");

/**
 * Wrap an initial worker-thread message with the canonical preamble.
 *
 * @param message - raw brief provided by the caller via `--message`
 * @returns preamble + brief, joined with a newline
 */
export function wrapWithPreamble(message: string): string {
  return `${THREAD_PREAMBLE}\n${message}`;
}
