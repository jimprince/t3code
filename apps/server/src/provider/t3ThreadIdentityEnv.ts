import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface T3ThreadIdentityInput {
  readonly threadId: ThreadId;
  readonly environmentId?: EnvironmentId;
  readonly environmentName?: string;
}

/**
 * The T3 identity a provider child process needs so tooling running inside the
 * session — notably the `t3-thread` CLI's `caller` resolution and its
 * completion-notification subscription — can tell which thread it is.
 *
 * `T3_ENVIRONMENT_ID`/`T3_ENVIRONMENT_NAME` are stamped process-wide on the
 * server by `applyT3EnvironmentMetadataToProcessEnv`, so they are only carried
 * here to let a caller override them. `T3_THREAD_ID` is per session and exists
 * nowhere else: every provider must stamp it at spawn time or the session sees
 * environment metadata with no thread id, which reads as a launcher/runtime
 * mismatch and silently disables completion routing.
 */
export function t3ThreadIdentityEnv(input: T3ThreadIdentityInput): NodeJS.ProcessEnv {
  const environmentId = input.environmentId ?? process.env.T3_ENVIRONMENT_ID;
  const environmentName = input.environmentName ?? process.env.T3_ENVIRONMENT_NAME;
  return {
    T3_THREAD_ID: String(input.threadId),
    ...(environmentId ? { T3_ENVIRONMENT_ID: String(environmentId) } : {}),
    ...(environmentName ? { T3_ENVIRONMENT_NAME: environmentName } : {}),
  };
}

/**
 * Overlays the T3 identity onto a base env. `base` stays undefined-tolerant so
 * spawn sites that rely on `extendEnv` inheritance can pass their optional
 * override through unchanged.
 */
export function withT3ThreadIdentityEnv(
  base: NodeJS.ProcessEnv | undefined,
  input: T3ThreadIdentityInput,
): NodeJS.ProcessEnv {
  return { ...base, ...t3ThreadIdentityEnv(input) };
}
