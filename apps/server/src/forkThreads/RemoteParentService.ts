import { ForkThreadMetadataError, type ForkThreadMetadataUpdate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
/** The child host owns remote links. Validation must never traverse or mutate remote descendants. */
export const validateRemoteParent = (environmentId: string, input: ForkThreadMetadataUpdate) =>
  input.remoteParent?.environmentId === environmentId
    ? Effect.fail(
        new ForkThreadMetadataError({ message: "Use a local parent for this environment." }),
      )
    : Effect.void;
