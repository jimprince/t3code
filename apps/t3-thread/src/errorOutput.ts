/**
 * Formats a failure for the CLI's single stderr boundary.
 *
 * Remote decode and HTTP failures can carry a whole server payload in their
 * message — a shell snapshot is hundreds of kilobytes — which floods an
 * operator terminal and buries the part that names the failing field. Keep the
 * head of the message and say how much was dropped.
 */
export const CLI_ERROR_MESSAGE_LIMIT = 2_000;

export function formatCliError(error: unknown, limit: number = CLI_ERROR_MESSAGE_LIMIT): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.length <= limit) {
    return message;
  }
  const omitted = message.length - limit;
  return `${message.slice(0, limit)}\n… truncated ${omitted} more characters of error output.`;
}
