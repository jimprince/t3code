import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, SubheadInput } from "@t3tools/contracts";
import { useCallback } from "react";

import { subheadCommand } from "../../state/subheads";
import { useAtomCommand } from "../../state/use-atom-command";

export type SubheadCallResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * One `fork.subheads` call whose refusal comes back as plain text for the form to show, instead of
 * a toast: the server's own sentence ("Only the creating principal may edit this subhead.") is
 * the answer the person needs.
 */
export function useSubheadCall(environmentId: EnvironmentId) {
  const run = useAtomCommand(subheadCommand, { label: "Subhead", reportFailure: false });
  return useCallback(
    async (input: SubheadInput): Promise<SubheadCallResult> => {
      const result: AtomCommandResult<unknown, unknown> = await run({ environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        return {
          ok: false,
          message:
            failure instanceof Error && failure.message.trim() !== ""
              ? failure.message
              : String(failure),
        };
      }
      return { ok: true, value: result.value };
    },
    [environmentId, run],
  );
}
