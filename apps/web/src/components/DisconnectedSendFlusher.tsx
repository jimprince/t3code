import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect } from "react";

import { flushHeldSends, useDisconnectedFlushRequests } from "../state/disconnectedSends";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Delivers the messages the composer held while a server was down: when that server connects,
 * when a message is held while it is connected, and when the user resends, discards or retries.
 * Mounted with the shell so delivery does not depend on which page is open.
 */
export function DisconnectedSendFlusher() {
  const { environments } = useEnvironments();
  const startTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const flushRequests = useDisconnectedFlushRequests();
  const connected = environments
    .filter((environment) => environment.connection.phase === "connected")
    .map((environment) => environment.environmentId)
    .join("\n");

  useEffect(() => {
    void flushRequests;
    const environmentIds = connected.split("\n").filter((entry) => entry.length > 0) as Array<
      (typeof environments)[number]["environmentId"]
    >;
    void flushHeldSends(environmentIds, async (environmentId, input) => {
      const result = await startTurn({ environmentId, input });
      // Only an acknowledged send leaves the queue. The failure itself is thrown so the queue can
      // tell a server refusal (terminal, Resend or Discard) from a transport failure (Retry).
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result;
    });
    // Runs on connect, new held send, Resend, Discard and Retry, never on a failure alone, so a
    // message the server refused waits for the user instead of looping.
  }, [connected, flushRequests, startTurn]);

  return null;
}
