import { refreshAccessToken } from "./http.js";
import { loadState, updateState } from "./state.js";
import type { AuthSessionRefreshResult, SavedEnvironment } from "./types.js";

export const SESSION_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const warnedEnvironments = new Set<string>();

export function shouldRefreshEnvironmentSession(
  environment: SavedEnvironment,
  nowMs = Date.now(),
): boolean {
  const expiresAtMs = Date.parse(environment.expiresAt);
  return (
    Number.isFinite(expiresAtMs) &&
    expiresAtMs > nowMs &&
    expiresAtMs - nowMs < SESSION_REFRESH_WINDOW_MS
  );
}

export async function refreshSavedEnvironmentSession(
  environment: SavedEnvironment,
  options: {
    nowMs?: number;
    refresh?: (input: {
      httpBaseUrl: string;
      bearerToken: string;
    }) => Promise<AuthSessionRefreshResult>;
    warn?: (message: string) => void;
  } = {},
): Promise<SavedEnvironment> {
  const saved = (await loadState()).environments.find(
    (candidate) => candidate.name === environment.name,
  );
  const current = saved ?? environment;
  if (!shouldRefreshEnvironmentSession(current, options.nowMs)) {
    return current;
  }

  try {
    const refreshed = await (options.refresh ?? refreshAccessToken)({
      httpBaseUrl: current.httpBaseUrl,
      bearerToken: current.bearerToken,
    });
    const expiresAt = new Date(
      (options.nowMs ?? Date.now()) + Math.max(0, refreshed.expires_in) * 1000,
    ).toISOString();
    const replacement: SavedEnvironment = {
      ...current,
      bearerToken: refreshed.access_token,
      expiresAt,
    };

    const persisted = await updateState((state) => {
      const latest = state.environments.find((candidate) => candidate.name === current.name);
      if (!latest) {
        return { state, result: replacement };
      }
      if (latest.bearerToken !== current.bearerToken) {
        return { state, result: latest };
      }
      return {
        state: {
          ...state,
          environments: state.environments.map((candidate) =>
            candidate.name === current.name ? replacement : candidate,
          ),
        },
        result: replacement,
      };
    });
    warnedEnvironments.delete(current.name);
    return persisted;
  } catch (error) {
    if (!warnedEnvironments.has(current.name)) {
      warnedEnvironments.add(current.name);
      const detail = error instanceof Error ? error.message : String(error);
      (options.warn ?? console.error)(
        `Warning: could not refresh session for environment '${current.name}': ${detail} Continuing with the existing token.`,
      );
    }
    return current;
  }
}
