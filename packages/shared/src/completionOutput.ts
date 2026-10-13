/** Only these entire final replies are silent, after trimming surrounding whitespace.
 * Case, markdown punctuation, internal whitespace and any additional text remain meaningful.
 */
export function isNoChangeReply(text: string | null | undefined): boolean {
  const reply = text?.trim();
  return reply === "No change." || reply === "Nothing new for you.";
}
