/** A tab of the project layout, addressed by its id (in the URL as ?tab=). */
export type ProjectTab = string;

/** A string that can be a layout tab id; the layout decides whether it exists. */
export const isProjectTab = (value: unknown): value is ProjectTab =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

/** The URL's tab wins, then the tab this device last used, then the layout's first tab. */
export function resolveProjectTab(
  fromUrl: ProjectTab | null,
  remembered: unknown,
  tabIds: ReadonlyArray<string>,
): ProjectTab {
  if (fromUrl !== null && tabIds.includes(fromUrl)) return fromUrl;
  if (isProjectTab(remembered) && tabIds.includes(remembered)) return remembered;
  return tabIds[0] ?? "dashboard";
}
