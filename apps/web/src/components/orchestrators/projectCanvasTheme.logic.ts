/**
 * The theme variables a canvas page can use. The host copies their current
 * values into the page's `:root`, so a canvas follows the app theme, light or
 * dark, with the same names the app uses.
 */
const CANVAS_THEME_VARIABLES = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--primary",
  "--primary-foreground",
  "--success",
  "--warning",
  "--error",
  "--info",
] as const;

/** The `<style>` the host adds to a canvas document, or null when no variable resolved. */
export function canvasThemeStyle(
  read: (name: string) => string,
  appearance: "light" | "dark",
): string | null {
  const declarations = CANVAS_THEME_VARIABLES.flatMap((name) => {
    // Values come from the app's own stylesheet; refuse anything that could close the tag.
    const value = read(name).trim();
    return value && !value.includes("<") ? [`${name}:${value}`] : [];
  });
  if (declarations.length === 0) return null;
  return `<style>:root{color-scheme:${appearance};${declarations.join(";")}}</style>`;
}

/**
 * Inserts the theme style at the top of the document's head, so the page's own
 * styles still win. It goes after the doctype when there is no head, because
 * anything before a doctype switches the page into quirks mode.
 */
export function withCanvasTheme(html: string, style: string | null): string {
  if (style === null) return html;
  for (const opening of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = opening.exec(html);
    if (match) {
      const end = match.index + match[0].length;
      return `${html.slice(0, end)}${style}${html.slice(end)}`;
    }
  }
  return `${style}${html}`;
}
