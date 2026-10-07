/**
 * The small decisions behind the projects sidebar, kept free of React and IPC
 * so they can be tested directly (scripts/sidebar.test.mjs).
 */

export interface ChatLike {
  id: string;
  archivedAt: number | null;
}

/** Chats in the list, and chats filed away, each in their saved order. */
export function splitChats<T extends ChatLike>(rows: readonly T[]): { open: T[]; archived: T[] } {
  return {
    open: rows.filter(row => !row.archivedAt),
    archived: rows.filter(row => Boolean(row.archivedAt)),
  };
}

/**
 * Where selection goes when a row leaves the list.
 *
 * The row that slides into its place -- the next one down -- or, if it was
 * the last, the one above. Null when nothing is left.
 */
export function nearbyAfterRemoval(ids: readonly string[], removed: string): string | null {
  const at = ids.indexOf(removed);
  if (at < 0) return ids[0] ?? null;
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

export type NameCheck = { ok: true; value: string } | { ok: false; message: string };

/** The same rules the store applies, so a refusal is shown before it is sent. */
export function checkName(text: string, what: "chat" | "project"): NameCheck {
  const value = text.split(/\s+/).filter(Boolean).join(" ");
  if (!value) return { ok: false, message: `A ${what} name can't be empty` };
  return { ok: true, value: [...value].slice(0, 120).join("") };
}

export interface Box { left: number; top: number; width: number; height: number }

/**
 * Where a menu opens so it stays inside the window.
 *
 * Under the trigger, right edges aligned, as a "⋯" menu conventionally hangs;
 * above it when there is no room below. A context menu opens at the pointer
 * instead. Either way it is clamped to the window with a margin.
 */
export function placeMenu(
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
  anchor: Box | { x: number; y: number },
  margin = 8,
): { left: number; top: number } {
  let left: number;
  let top: number;
  if ("x" in anchor) {
    left = anchor.x;
    top = anchor.y;
    if (top + menu.height > viewport.height - margin) top = anchor.y - menu.height;
  } else {
    left = anchor.left + anchor.width - menu.width;
    top = anchor.top + anchor.height + 4;
    if (top + menu.height > viewport.height - margin) top = anchor.top - menu.height - 4;
  }
  return {
    left: Math.max(margin, Math.min(left, viewport.width - menu.width - margin)),
    top: Math.max(margin, Math.min(top, viewport.height - menu.height - margin)),
  };
}

/** Which item a typed letter moves to, after the current one. */
export function typeahead(labels: readonly string[], current: number, key: string): number {
  const letter = key.toLowerCase();
  for (let step = 1; step <= labels.length; step += 1) {
    const index = (current + step) % labels.length;
    if (labels[index]?.toLowerCase().startsWith(letter)) return index;
  }
  return current;
}
