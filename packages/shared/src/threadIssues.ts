import type { ThreadIssueKey } from "@t3tools/contracts";

export function normalizeThreadIssueKey(input: ThreadIssueKey): ThreadIssueKey {
  return {
    host: input.host.toLowerCase(),
    repository: input.repository.toLowerCase(),
    number: input.number,
  };
}

export function threadIssueKeysEqual(left: ThreadIssueKey, right: ThreadIssueKey): boolean {
  const normalizedLeft = normalizeThreadIssueKey(left);
  const normalizedRight = normalizeThreadIssueKey(right);
  return (
    normalizedLeft.host === normalizedRight.host &&
    normalizedLeft.repository === normalizedRight.repository &&
    normalizedLeft.number === normalizedRight.number
  );
}
