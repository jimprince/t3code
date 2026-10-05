/** Dashboard | Issues | Roadmap: planning sits at the far right. */
export const PROJECT_TABS = [
  { id: "dashboard", title: "Dashboard" },
  { id: "issues", title: "Issues" },
  { id: "roadmap", title: "Roadmap" },
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number]["id"];

export const isProjectTab = (value: unknown): value is ProjectTab =>
  value === "dashboard" || value === "roadmap" || value === "issues";

/** The URL's tab wins; otherwise the tab this device last used for the project. */
export function resolveProjectTab(fromUrl: ProjectTab | null, remembered: unknown): ProjectTab {
  return fromUrl ?? (isProjectTab(remembered) ? remembered : "dashboard");
}
