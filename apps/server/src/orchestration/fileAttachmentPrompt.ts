/**
 * fileAttachmentPrompt - renders file-attachment paths into provider input.
 *
 * File attachments are handed to the agent as absolute paths appended to the
 * user message text, so every provider adapter (Codex, Claude, Cursor, Grok,
 * OpenCode) supports them without changes; the attachments themselves never
 * enter ProviderSendTurnInput.attachments.
 *
 * @module fileAttachmentPrompt
 */
import type { ChatFileHandoffAttachment } from "@t3tools/contracts";

export function formatFileAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Append one `[Attached file: …]` line per file attachment to the provider
 * message text. Returns the text unchanged when there are no file attachments.
 */
export function appendFileAttachmentPromptLines(
  text: string,
  fileAttachments: ReadonlyArray<ChatFileHandoffAttachment> | undefined,
): string {
  if (fileAttachments === undefined || fileAttachments.length === 0) return text;
  const lines = fileAttachments.map(
    (attachment) =>
      `[Attached file: ${attachment.path} (${attachment.mimeType}, ${formatFileAttachmentSize(attachment.sizeBytes)})]`,
  );
  const block = lines.join("\n");
  return text.length === 0 ? block : `${text}\n\n${block}`;
}
