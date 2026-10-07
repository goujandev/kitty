/**
 * Read a presentation preference, moving its previous-brand key once.
 * The installed application keeps its identity, so both keys share storage.
 * Existing Pantheon values always win; a failed write leaves the old value
 * available for the next startup rather than losing the preference.
 */
export function readPreference(name: string, separator: "." | ":" = "."): string | null {
  const key = `pantheon${separator}${name}`;
  const legacy = `kitty${separator}${name}`;
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const previous = localStorage.getItem(legacy);
  if (previous === null) return null;
  try {
    localStorage.setItem(key, previous);
    localStorage.removeItem(legacy);
  } catch { /* Keep using the saved preference if storage cannot be written. */ }
  return previous;
}
