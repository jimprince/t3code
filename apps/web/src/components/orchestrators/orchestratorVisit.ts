const KEY_PREFIX = "t3code:orchestrator:last-visit:";

export function orchestratorVisitKey(environmentId: string, threadId: string): string {
  return `${KEY_PREFIX}${environmentId}:${threadId}`;
}

export function readOrchestratorLastVisit(
  storage: Pick<Storage, "getItem"> | undefined,
  environmentId: string,
  threadId: string,
): string | null {
  const value = storage?.getItem(orchestratorVisitKey(environmentId, threadId)) ?? null;
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

export function recordOrchestratorVisit(
  storage: Pick<Storage, "setItem"> | undefined,
  environmentId: string,
  threadId: string,
  visitedAt: string,
): void {
  storage?.setItem(orchestratorVisitKey(environmentId, threadId), visitedAt);
}
