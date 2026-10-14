import type {
  ProjectRequestCreateInput,
  ThreadId,
  UploadedAttachmentRef,
} from "@t3tools/contracts";

/** What the request line files: a task, a task tagged bug, or an epic (a workstream). */
export type LineKind = "task" | "bug" | "epic";
/** Enter files an item last in its workstream; Cmd or Ctrl with Enter files it next. */
export type LinePlacement = "next" | "last";

/**
 * The placement a key press asks for, or null when the key files nothing. Shift+Enter is a new
 * line, and Enter during IME composition belongs to the composition.
 */
export function placementOf(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean | undefined;
}): LinePlacement | null {
  if (event.key !== "Enter" || event.isComposing || event.shiftKey || event.altKey) return null;
  return event.metaKey || event.ctrlKey ? "next" : "last";
}

/** "Bug:" or "Fix " at the start of the words selects Bug; the words are kept as typed. */
export function kindFromText(text: string): "bug" | null {
  return /^\s*(bug:|fix\s)/i.test(text) ? "bug" : null;
}

/** The key chord that files an item next on this platform. */
export const nextKeyHint = (platform: string) =>
  /mac|iphone|ipad/i.test(platform) ? "⌘Enter" : "Ctrl+Enter";

/** The title of a filing that is only pasted images, as the old request box named it. */
export const IMAGE_ONLY_TITLE = "Request with images";

/**
 * The epic the workstream field starts on: the one last filed into when it is still a workstream
 * of the project, else none.
 */
export function defaultEpic(
  epics: ReadonlyArray<number>,
  lastFiledInto: number | null | undefined,
): number | null {
  return lastFiledInto != null && epics.includes(lastFiledInto) ? lastFiledInto : null;
}

/**
 * The typed filing for the request line. The title is the first line and the full words travel
 * as the detail, so the issue keeps them verbatim under "Brad's words". The message id makes a
 * retry of the same filing land on the issue it already made. Uploaded images travel as
 * `attachments`; images alone are a filing too.
 */
export function filingInput(input: {
  readonly threadId: ThreadId;
  readonly text: string;
  readonly kind: LineKind;
  readonly epic: number | null;
  readonly placement: LinePlacement;
  readonly messageId: string;
  readonly attachments?: ReadonlyArray<UploadedAttachmentRef>;
}): ProjectRequestCreateInput {
  const words = input.text.trim();
  const title =
    (words.split(/\r?\n/).find((line) => line.trim()) ?? words).trim().slice(0, 200) ||
    IMAGE_ONLY_TITLE;
  return {
    threadId: input.threadId,
    title,
    kind: input.kind === "epic" ? "epic" : "task",
    ...(input.kind === "bug" ? { bug: true } : {}),
    ...(words !== "" && words !== title ? { detail: words } : {}),
    ...(input.kind !== "epic" && input.epic !== null ? { partOf: input.epic } : {}),
    place: { to: input.placement === "next" ? "top" : "bottom" },
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
    actor: "brad",
    messageId: input.messageId,
  };
}
