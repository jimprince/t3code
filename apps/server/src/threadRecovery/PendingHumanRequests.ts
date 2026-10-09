import type { MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// S3 replaces this declaration with its live service at integration.
type ThreadRecoveryError = { readonly _tag: "ThreadRecoveryError"; readonly message: string };
export class PendingHumanRequests extends Context.Service<
  PendingHumanRequests,
  {
    readonly listPending: (input: { readonly threadId: ThreadId }) => Effect.Effect<
      ReadonlyArray<{
        readonly turnItemId: TurnItemId;
        readonly sourceMessageId: MessageId;
        readonly reason: "unanswered" | "failed" | "interrupted" | "queued";
      }>,
      ThreadRecoveryError
    >;
  }
>()("t3/threadRecovery/PendingHumanRequests") {}
