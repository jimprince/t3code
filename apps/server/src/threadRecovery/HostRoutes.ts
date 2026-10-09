import {
  ThreadRecoveryError,
  type HandoverRoutesInput,
  HandoverHostReceipt,
  type HandoverItemReceipt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const rows = (state: RecordValue, key: string) => {
  const value = state[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((row) => !record(row)))
    throw new ThreadRecoveryError({
      code: "storage",
      message: `Invalid routing ${key}; no transfer performed.`,
    });
  return value.filter(record);
};
const conflict = (message: string): never => {
  throw new ThreadRecoveryError({ code: "conflict", message });
};

/** Runs under the existing host routing-state lock; preserves opaque watcher settings and delivery keys. */
export function transferHostRoutes(
  state: RecordValue,
  input: HandoverRoutesInput,
  principal: string,
  environment: string,
  now: string,
) {
  if (input.oldThreadId === input.successorThreadId) conflict("Source and successor must differ.");
  const redirects = rows(state, "handoverRedirects");
  const history = rows(state, "handoverReceipts");
  const key = `${environment}:${principal}:${input.requestId}`;
  const fingerprint = JSON.stringify(input);
  const existing = history.find((row) => row.key === key);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      conflict("Request ID was already used with different transfer parameters.");
    return { state, receipt: Schema.decodeUnknownSync(HandoverHostReceipt)(existing.receipt) };
  }
  const generations = record(state.handoverGenerations) ? state.handoverGenerations : {};
  const generationKey = `${input.targetEnvironment}:${input.oldThreadId}`;
  const current = generations[generationKey] ?? 0;
  if (current !== input.expectedGeneration)
    conflict("Host route generation changed; inventory again before transferring.");
  const items: HandoverItemReceipt[] = [];
  const move = (
    kind: HandoverItemReceipt["kind"],
    id: string,
    before: RecordValue,
    after: RecordValue,
  ) => {
    items.push({ kind, id, before, after, principal });
    return after;
  };
  const subscriptions = rows(state, "subscriptions");
  const successors = subscriptions.filter(
    (r) =>
      r.subscriberThreadId === input.successorThreadId &&
      r.subscriberEnvironment === input.targetEnvironment,
  );
  const migrated = subscriptions.map((r) => {
    if (
      r.subscriberThreadId !== input.oldThreadId ||
      r.subscriberEnvironment !== input.targetEnvironment
    )
      return r;
    if (
      r.sourceThreadId === input.successorThreadId &&
      r.sourceEnvironment === input.targetEnvironment
    )
      conflict("Transfer would create a self subscription; resolve it explicitly.");
    if (
      successors.some(
        (s) => s.sourceThreadId === r.sourceThreadId && s.sourceEnvironment === r.sourceEnvironment,
      )
    )
      conflict(
        "Successor already has a subscription for this source; merge explicitly before transfer.",
      );
    return move("subscription", `${r.sourceEnvironment}:${r.sourceThreadId}`, r, {
      ...r,
      subscriberThreadId: input.successorThreadId,
      updatedAt: now,
    });
  });
  const terminal = new Set([
    "delivered",
    "superseded",
    "undeliverable",
    "cancelled",
    "completed",
    "failed",
    "dispatched",
  ]);
  const notifications = rows(state, "notifications").map((r) =>
    r.subscriberThreadId === input.oldThreadId &&
    r.subscriberEnvironment === input.targetEnvironment &&
    !terminal.has(String(r.status))
      ? r.deliveryClaimId || ["uncertain", "delivering"].includes(String(r.status))
        ? conflict("A notification delivery is claimed; retry after its receipt.")
        : move("notification", String(r.id ?? r.notificationId ?? r.eventKey), r, {
            ...r,
            subscriberThreadId: input.successorThreadId,
            updatedAt: now,
          })
      : r,
  );
  const queuedSends = rows(state, "queuedSends").map((r) =>
    r.threadId === input.oldThreadId &&
    r.environment === input.targetEnvironment &&
    !terminal.has(String(r.status))
      ? r.dispatchClaimId || ["uncertain", "dispatching"].includes(String(r.status))
        ? conflict("A send is claimed or uncertain; reconcile before transfer.")
        : move("queued-send", String(r.id ?? r.sendId), r, {
            ...r,
            threadId: input.successorThreadId,
            updatedAt: now,
          })
      : r,
  );
  const agents = rows(state, "agents").map((r) =>
    r.threadId === input.oldThreadId && r.environment === input.targetEnvironment
      ? move("alias", String(r.name), r, {
          ...r,
          threadId: input.successorThreadId,
          updatedAt: now,
        })
      : r,
  );
  const receipt: HandoverHostReceipt = {
    transferId: input.transferId,
    environment,
    oldThreadId: input.oldThreadId,
    successorThreadId: input.successorThreadId,
    oldGeneration: input.expectedGeneration,
    newGeneration: input.expectedGeneration + 1,
    items,
    principal,
    digest: "",
  };
  return {
    state: {
      ...state,
      subscriptions: migrated,
      notifications,
      queuedSends,
      agents,
      handoverRedirects: [
        ...redirects,
        {
          oldThreadId: input.oldThreadId,
          successorThreadId: input.successorThreadId,
          targetEnvironment: input.targetEnvironment,
          transferId: input.transferId,
        },
      ],
      handoverGenerations: { ...generations, [generationKey]: receipt.newGeneration },
    },
    receipt,
    key,
    fingerprint,
    history,
  };
}
