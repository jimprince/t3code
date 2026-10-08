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

const OPENED = "open:";
const CLOSED = "closed:";

/**
 * A group the user may open or close whatever its default: the stored list holds
 * `open:<key>` / `closed:<key>` for each choice made, and a group with none follows
 * `byDefault`, so a default that changes with live counts never reverses a choice.
 */
export function groupOpen(stored: ReadonlyArray<string>, key: string, byDefault: boolean): boolean {
  if (stored.includes(OPENED + key)) return true;
  if (stored.includes(CLOSED + key)) return false;
  return byDefault;
}

export function setGroupOpen(
  stored: ReadonlyArray<string>,
  key: string,
  open: boolean,
): ReadonlyArray<string> {
  return [
    ...stored.filter((entry) => entry !== OPENED + key && entry !== CLOSED + key),
    (open ? OPENED : CLOSED) + key,
  ];
}
