/** The earlier request kind an older server files each current item type under. */
const OLDER_SERVER_KIND = { question: "question", task: "change", epic: "plan" } as const;

type CurrentKind = keyof typeof OLDER_SERVER_KIND;

/**
 * What to send for a new request. A server without the projectItemTypes capability
 * only knows the earlier kinds, so a task goes as `change` (`bug` when tagged one)
 * and an epic as `plan`, and the separate bug tag is dropped because the kind carries it.
 */
export function requestKindPayload(
  kind: CurrentKind,
  bug: boolean,
  serverHasItemTypes: boolean,
): { kind: string; bug?: true } {
  if (serverHasItemTypes) {
    return bug ? { kind, bug: true } : { kind };
  }
  return { kind: bug && kind === "task" ? "bug" : OLDER_SERVER_KIND[kind] };
}
