import * as Schema from "effect/Schema";

/** How a group list is stored: the keys the user flipped from the default. */
export const openKeysSchema = Schema.Array(Schema.String);
export const NO_OPEN_KEYS: ReadonlyArray<string> = [];

/**
 * Collapsible dashboard groups are closed by default, so the remembered state is
 * the list of keys the user opened. Toggling adds the key or removes it.
 */
export function toggleKey(open: ReadonlyArray<string>, key: string): ReadonlyArray<string> {
  return open.includes(key) ? open.filter((entry) => entry !== key) : [...open, key];
}
