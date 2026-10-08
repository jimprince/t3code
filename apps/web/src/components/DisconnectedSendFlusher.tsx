import { useEffect } from "react";

import { flushHeldSends, useDisconnectedFlushRequests } from "../state/disconnectedSends";
import { useEnvironments } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Delivers the messages the composer held while a server was down: when that server connects,
 * when a message is held while it is connected, and when the user asks to retry. Mounted with
 * the shell so delivery does not depend on which page is open.
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
      // Only an acknowledged send leaves the queue; a refusal keeps it for Retry.
      if (result._tag === "Failure") throw new Error("The held message was not accepted.");
      return result;
    });
    // Runs on connect, new held send and Retry, never on a refusal alone, so a message the
    // server keeps refusing waits for the user instead of looping.
  }, [connected, flushRequests, startTurn]);

  return null;
}
