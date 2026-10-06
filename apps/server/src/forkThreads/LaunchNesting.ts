import {
  CommandId,
  ForkThreadMetadataError,
  type ForkThreadMetadataUpdate,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * What a launch that files its new thread under a parent needs from the server. `check` fails
 * before anything exists, so a parent that is gone or archived leaves no thread behind. `afterClaim`
 * nests the new thread once it exists and before its first message is dispatched; a named-agent
 * project only accepts that message for a thread that is no longer a root. The receipt is keyed off
 * the launch command, so a retried launch replays it.
 */
export const launchNesting = <E, R, UE, UR>(
  nesting: {
    readonly update: (input: ForkThreadMetadataUpdate) => Effect.Effect<unknown, UE, UR>;
  },
  getParentShell: (id: ThreadId) => Effect.Effect<{ readonly archivedAt: unknown } | null, E, R>,
  launch: { readonly commandId: CommandId; readonly parentThreadId: ThreadId },
) => ({
  check: getParentShell(launch.parentThreadId).pipe(
    Effect.mapError((cause) => new ForkThreadMetadataError({ message: String(cause) })),
    Effect.flatMap((parent) =>
      parent === null || parent.archivedAt !== null
        ? Effect.fail(
            new ForkThreadMetadataError({ message: "Parent thread is missing or archived." }),
          )
        : Effect.void,
    ),
  ),
  afterClaim: (threadId: ThreadId) =>
    nesting
      .update({
        commandId: CommandId.make(`${launch.commandId}:parent`),
        threadId,
        parentThreadId: launch.parentThreadId,
        remoteParent: null,
      })
      .pipe(Effect.mapError((cause) => new ForkThreadMetadataError({ message: String(cause) }))),
});
