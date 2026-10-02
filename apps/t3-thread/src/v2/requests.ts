import type { OrchestrationThread } from "../types.js";

/** Responses use durable V2 request ids, never the provider's transient native id. */
export function pendingRequests(thread: OrchestrationThread) {
  return (thread.runtimeRequests ?? [])
    .filter((request) => request.status === "pending")
    .map((request) => ({
      ...request,
      detail: thread.projection?.turnItems.filter(
        (item) => "requestId" in item && item.requestId === request.id,
      ),
    }));
}
export function requirePendingRequest(thread: OrchestrationThread, requestId: string) {
  const request = pendingRequests(thread).find((request) => request.id === requestId);
  if (!request)
    throw new Error(`No pending runtime request '${requestId}' on thread '${thread.id}'.`);
  if (request.responseCapability.type === "not_resumable")
    throw new Error(request.responseCapability.reason);
  return request;
}
