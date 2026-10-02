interface MessageOrigin { source: string; fromThreadId?: string; fromName?: string | null; }

export interface ThreadIdentity {
  threadId: string;
  name: string | null;
  environment: string;
  title?: string;
}

export function threadSendCommand(identity: ThreadIdentity): string {
  const target = identity.name ?? identity.threadId;
  const quoted = /^[a-zA-Z0-9_.:/-]+$/.test(target)
    ? target
    : `'${target.replaceAll("'", "'\"'\"'")}'`;
  return `t3-thread send ${quoted} ...`;
}

export function senderHeader(identity: ThreadIdentity): string {
  return `thread_id: ${JSON.stringify(identity.threadId)}; saved_name: ${JSON.stringify(identity.name)}; environment: ${JSON.stringify(identity.environment)}; reply: ${JSON.stringify(threadSendCommand(identity))}`;
}

/** Queue records already carry this text; replay must preserve a single header. */
export function withSenderHeader(
  text: string,
  origin: MessageOrigin | null | undefined,
  environment: string,
): string {
  if (
    origin?.source !== "thread-send" ||
    !origin.fromThreadId ||
    text.startsWith("T3 thread message: ")
  )
    return text;
  return `T3 thread message: ${senderHeader({ threadId: origin.fromThreadId, name: origin.fromName ?? null, environment })}\n${text}`;
}
