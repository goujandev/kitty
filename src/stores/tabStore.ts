import { readPreference } from "./localPreferences";
/**
 * Which chats are open as tabs, per project.
 *
 * A per-viewer convenience, like a browser's open tabs: kept in local storage
 * and never authoritative. Closing a tab only stops showing it; the chat and
 * its history are untouched. `DRAFT` stands for the unsent new chat, of which
 * there is at most one.
 *
 * The rules live in plain functions (`reveal`, `close`, `prune`) so they can
 * be tested without React (scripts/tabs.test.mjs).
 */

import { useSyncExternalStore } from "react";

export const DRAFT = "draft";

export interface Tabs {
  ids: string[];
  active: string | null;
}

const EMPTY: Tabs = { ids: [], active: null };

/**
 * Makes `id` the active tab, opening it if needed. A chat that was just made
 * from the draft takes the draft's place; anything else opens beside the
 * current tab, the way a browser opens a link.
 */
export function reveal(tabs: Tabs, id: string): Tabs {
  if (tabs.ids.includes(id)) return { ids: tabs.ids, active: id };
  const at = tabs.active === null ? -1 : tabs.ids.indexOf(tabs.active);
  if (at >= 0 && tabs.active === DRAFT && id !== DRAFT) {
    const ids = [...tabs.ids];
    ids[at] = id;
    return { ids, active: id };
  }
  const ids = [...tabs.ids];
  ids.splice(at + 1, 0, id);
  return { ids, active: id };
}

/** Closes a tab. If it was active, its neighbour becomes active. */
export function close(tabs: Tabs, id: string): Tabs {
  const at = tabs.ids.indexOf(id);
  if (at < 0) return tabs;
  const ids = tabs.ids.filter(tab => tab !== id);
  if (tabs.active !== id) return { ids, active: tabs.active };
  return { ids, active: ids[at] ?? ids[at - 1] ?? null };
}

/** Drops tabs for chats that no longer exist or were archived. */
export function prune(tabs: Tabs, valid: ReadonlySet<string>): Tabs {
  const ids = tabs.ids.filter(id => id === DRAFT || valid.has(id));
  if (ids.length === tabs.ids.length) return tabs;
  const active = tabs.active && ids.includes(tabs.active) ? tabs.active : ids[0] ?? null;
  return { ids, active };
}

/** The tab `step` places along from the active one, wrapping around. */
export function cycle(tabs: Tabs, step: number): string | null {
  if (!tabs.ids.length) return null;
  const at = Math.max(0, tabs.active ? tabs.ids.indexOf(tabs.active) : 0);
  return tabs.ids[(at + step + tabs.ids.length) % tabs.ids.length] ?? null;
}

// ------------------------------------------------------------------ store

const KEY = "pantheon.tabs";
let byProject: Record<string, Tabs> = read();
const listeners = new Set<() => void>();

function read(): Record<string, Tabs> {
  try {
    const saved: unknown = JSON.parse(readPreference("tabs") ?? "{}");
    return saved && typeof saved === "object" ? saved as Record<string, Tabs> : {};
  } catch { return {}; }
}

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(byProject)); } catch { /* Storage may be unavailable. */ }
}

export function tabsFor(projectId: string | null): Tabs {
  return projectId ? byProject[projectId] ?? EMPTY : EMPTY;
}

export function updateTabs(projectId: string, change: (tabs: Tabs) => Tabs): void {
  const before = tabsFor(projectId);
  const after = change(before);
  if (after === before || (after.active === before.active && after.ids.join() === before.ids.join())) return;
  byProject = { ...byProject, [projectId]: after };
  save();
  for (const listener of listeners) listener();
}

export function forgetProjectTabs(projectId: string): void {
  if (!(projectId in byProject)) return;
  const { [projectId]: _gone, ...rest } = byProject;
  byProject = rest;
  save();
  for (const listener of listeners) listener();
}

export function useTabs(projectId: string | null): Tabs {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => tabsFor(projectId),
  );
}
