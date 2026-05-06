import { useAtomValue } from "@effect/atom-react";
import {
  type GitStatusClient,
  type GitStatusState,
  type GitStatusTarget,
  EMPTY_GIT_STATUS_ATOM,
  EMPTY_GIT_STATUS_STATE,
  createGitStatusManager,
  getGitStatusTargetKey,
  gitStatusStateAtom,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export type { GitStatusState, GitStatusTarget };

const manager = createGitStatusManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.client.vcs : null;
  },
  getClientIdentity: (environmentId) => {
    const connection = readEnvironmentConnection(environmentId as EnvironmentId);
    return connection ? connection.environmentId : null;
  },
  subscribeClientChanges: subscribeEnvironmentConnections,
});

export function getGitStatusSnapshot(target: GitStatusTarget): GitStatusState {
  return manager.getSnapshot(target);
}

export function watchGitStatus(target: GitStatusTarget, client?: GitStatusClient): () => void {
  return manager.watch(target, client);
}

export function refreshGitStatus(target: GitStatusTarget, client?: GitStatusClient) {
  return manager.refresh(target, client);
}

export function resetGitStatusStateForTests(): void {
  manager.reset();
}

export function useGitStatus(target: GitStatusTarget): GitStatusState {
  const targetKey = getGitStatusTargetKey(target);
  useEffect(
    () => manager.watch({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? gitStatusStateAtom(targetKey) : EMPTY_GIT_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_STATUS_STATE : state;
}
