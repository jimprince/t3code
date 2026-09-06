import { ChatAttachment, type ChatAttachment as Attachment } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
const decode = Schema.decodeUnknownOption(ChatAttachment);
export function decodeHistoricalAttachments(json: string | null): Attachment[] {
  let value: unknown;
  try {
    value = JSON.parse(json ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const result = decode(item);
    return Option.isSome(result) ? [result.value] : [];
  });
}
