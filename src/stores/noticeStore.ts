/**
 * Short confirmations and failures from list operations: "Chat archived ·
 * Undo", "Couldn't rename · Try again". One at a time, newest wins, gone after
 * a few seconds unless it is an error.
 */

import { useSyncExternalStore } from "react";

export interface Notice {
  id: number;
  message: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

let current: Notice | null = null;
let next = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(value: Notice | null): void {
  current = value;
  for (const listener of listeners) listener();
}

export function showNotice(notice: Omit<Notice, "id">): void {
  if (timer) clearTimeout(timer);
  const shown = { ...notice, id: next++ };
  publish(shown);
  // Errors wait to be read or acted on; confirmations step aside.
  if (notice.tone === "info") timer = setTimeout(() => { if (current?.id === shown.id) publish(null); }, 6000);
}

export function dismissNotice(): void {
  if (timer) clearTimeout(timer);
  publish(null);
}

export function useNotice(): Notice | null {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}
