import type { GiteaInstanceConfig } from "@t3tools/contracts";

/** The server's file of per-project dashboard settings. */
export interface DashboardFile {
  readonly version: 1;
  /** Widget order per orchestrator (root) thread. */
  readonly dashboards: Readonly<Record<string, { readonly widgets: ReadonlyArray<string> }>>;
  /** Gitea tracker repository per T3 project, when the git remote is not on Gitea. */
  readonly trackers: Readonly<Record<string, string>>;
  /**
   * Page layout per orchestrator (root) thread: its saved revisions, oldest first,
   * the last one current. Raw JSON; the layout service decodes it.
   */
  readonly layouts: Readonly<Record<string, { readonly history: ReadonlyArray<unknown> }>>;
}

export const EMPTY_DASHBOARD_FILE: DashboardFile = {
  version: 1,
  dashboards: {},
  trackers: {},
  layouts: {},
};

export function parseDashboardFile(contents: string | null): DashboardFile {
  if (!contents) return EMPTY_DASHBOARD_FILE;
  try {
    const value = JSON.parse(contents) as Partial<DashboardFile>;
    if (value?.version !== 1) return EMPTY_DASHBOARD_FILE;
    return {
      version: 1,
      dashboards: value.dashboards && typeof value.dashboards === "object" ? value.dashboards : {},
      trackers: value.trackers && typeof value.trackers === "object" ? value.trackers : {},
      layouts: value.layouts && typeof value.layouts === "object" ? value.layouts : {},
    };
  } catch {
    return EMPTY_DASHBOARD_FILE;
  }
}

/** Trimmed, de-duplicated widget ids in their given order. */
export function normalizeWidgets(widgets: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const widget of widgets) {
    const id = widget.trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

/**
 * Reads a tracker setting: `owner/repo` on the first configured Gitea instance,
 * or a repository URL (`https://git.example/owner/repo`, optionally `.git`) on
 * the instance with that web origin. Null when it names no configured instance.
 */
export function resolveTrackerSetting(
  setting: string,
  instances: ReadonlyArray<GiteaInstanceConfig>,
): { instance: GiteaInstanceConfig; repository: string } | null {
  const trimmed = setting.trim();
  const short = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(trimmed);
  if (short) {
    const instance = instances[0];
    return instance ? { instance, repository: `${short[1]}/${short[2]}`.toLowerCase() } : null;
  }
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  const path = /^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.pathname);
  const instance = instances.find(
    (candidate) => new URL(candidate.webOrigin).host.toLowerCase() === url.host.toLowerCase(),
  );
  return path && instance ? { instance, repository: `${path[1]}/${path[2]}`.toLowerCase() } : null;
}
