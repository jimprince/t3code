import { isPageAgentThreadId } from "@t3tools/contracts";
import { Stream } from "effect";

import type { ShellApplicationEvent } from "../orchestration-v2/ShellStream.ts";

/**
 * Page-agent threads are ordinary V2 threads that stay out of the public
 * shell, search and relay surfaces. Only those presentation reads filter;
 * stores, reactors and the by-id thread detail still see them.
 */
export const isPageAgentShellEvent = (event: ShellApplicationEvent): boolean =>
  "event" in event && isPageAgentThreadId(event.event.threadId);

export const withoutPageAgentShellEvents = <E, R>(
  stream: Stream.Stream<ShellApplicationEvent, E, R>,
): Stream.Stream<ShellApplicationEvent, E, R> =>
  stream.pipe(Stream.filter((event) => !isPageAgentShellEvent(event)));

export const withoutPageAgentMatches = <
  TResult extends { readonly matches: ReadonlyArray<{ readonly threadId: string }> },
>(
  result: TResult,
): TResult =>
  result.matches.some((match) => isPageAgentThreadId(match.threadId))
    ? { ...result, matches: result.matches.filter((match) => !isPageAgentThreadId(match.threadId)) }
    : result;
