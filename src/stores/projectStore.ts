/**
 * The projects screen and search, held outside React.
 *
 * Kept separate from the chat store because they are separate concerns with
 * separate lifetimes: the projects list survives switching conversations, and
 * a chat does not care that a search is open.
 */

import { useSyncExternalStore } from "react";

import type { Hit, ProjectSummary, SessionRow } from "../ipc/bindings";
import * as ipc from "../ipc/commands";

/** A search hit with enough context to be worth clicking. */
export interface SearchResult extends Hit {
  title: string | null;
  harness: string;
  projectId: string;
  projectName: string;
}

export interface ProjectState {
  projects: ProjectSummary[];
  loading: boolean;
  /**
   * Each project's chats, archived ones included, once its section has been
   * opened in the sidebar. The open project's list is the chat store's,
   * mirrored here so the sidebar reads one place.
   */
  chats: Record<string, SessionRow[]>;
  /** Projects whose chats are shown in the sidebar. A per-viewer preference. */
  expanded: Record<string, boolean>;
  query: string;
  results: SearchResult[];
  searching: boolean;
  error: string | null;
}

function readExpanded(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem("kitty.expandedProjects") ?? "{}");
    return saved && typeof saved === "object" ? saved as Record<string, boolean> : {};
  } catch { return {}; }
}

const EMPTY: ProjectState = {
  projects: [],
  loading: false,
  chats: {},
  expanded: readExpanded(),
  query: "",
  results: [],
  searching: false,
  error: null,
};

let state: ProjectState = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<ProjectState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function useProjects(): ProjectState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "something went wrong";
}

export function snapshot(): ProjectState {
  return state;
}

export async function refresh(): Promise<void> {
  set({ loading: true, error: null });
  try {
    const projects = await ipc.listProjectSummaries();
    set({ projects, loading: false });
    // Sections left open last time show their chats straight away.
    for (const project of projects) {
      if (state.expanded[project.id] && !state.chats[project.id]) void loadChats(project.id);
    }
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

/** Reads one project's chats into the sidebar. */
export async function loadChats(projectId: string): Promise<void> {
  try {
    setChats(projectId, await ipc.listSessions(projectId));
  } catch {
    // The section shows what it had; opening the project retries.
  }
}

/** Replaces one project's chats, as the sidebar should show them. */
export function setChats(projectId: string, rows: SessionRow[]): void {
  if (state.chats[projectId] === rows) return;
  set({ chats: { ...state.chats, [projectId]: rows } });
}

/** Changes one chat in place, wherever it is listed. */
export function patchChat(projectId: string, id: string, update: (row: SessionRow) => SessionRow | null): void {
  const rows = state.chats[projectId];
  if (!rows) return;
  setChats(projectId, rows.flatMap(row => {
    if (row.id !== id) return [row];
    const next = update(row);
    return next ? [next] : [];
  }));
}

/** Changes one project in place, e.g. an optimistic rename. */
export function patchProject(id: string, update: (project: ProjectSummary) => ProjectSummary): void {
  set({ projects: state.projects.map(project => project.id === id ? update(project) : project) });
}

/** Drops a removed project from the list immediately. */
export function forgetProjectRow(id: string): void {
  const { [id]: _chats, ...chats } = state.chats;
  set({ projects: state.projects.filter(project => project.id !== id), chats });
}

/** Shows or hides a project's chats. */
export function setExpanded(projectId: string, open: boolean): void {
  if (Boolean(state.expanded[projectId]) === open) return;
  const expanded = { ...state.expanded, [projectId]: open };
  if (!open) delete expanded[projectId];
  set({ expanded });
  try { localStorage.setItem("kitty.expandedProjects", JSON.stringify(expanded)); } catch { /* Storage may be unavailable. */ }
  if (open && !state.chats[projectId]) void loadChats(projectId);
}


/** Saves a hand-dragged order. The list is already showing it. */
export async function reorder(ids: string[]): Promise<void> {
  try {
    await ipc.reorderProjects(ids);
    await refresh();
  } catch (error) {
    set({ error: message(error) });
  }
}

/**
 * Searches every conversation.
 *
 * Guarded by a token rather than debounced here: the caller types, each
 * keystroke starts a search, and only the newest one is allowed to land. A
 * slow query cannot overwrite a newer one's results.
 */
let token = 0;

export async function search(query: string): Promise<void> {
  const mine = ++token;
  set({ query, searching: query.trim().length > 0 });

  if (!query.trim()) {
    set({ results: [], searching: false });
    return;
  }

  try {
    const hits = await ipc.search(query);
    if (mine !== token) return;

    // A hit names a session, not a conversation anyone would recognise, so it
    // is joined to its session and project before being shown.
    const results = await decorate(hits);
    if (mine !== token) return;
    set({ results, searching: false });
  } catch (error) {
    if (mine === token) set({ error: message(error), searching: false });
  }
}

async function decorate(hits: Hit[]): Promise<SearchResult[]> {
  const projects = state.projects.length
    ? state.projects
    : await ipc.listProjectSummaries().catch(() => []);

  const sessions = new Map<string, SessionRow>();
  const names = new Map<string, string>();
  for (const project of projects) {
    names.set(project.id, project.name);
    const rows = await ipc.listSessions(project.id).catch(() => []);
    for (const row of rows) sessions.set(row.id, row);
  }

  return hits.flatMap((hit) => {
    const session = sessions.get(hit.sessionId);
    if (!session) return [];
    return [
      {
        ...hit,
        title: session.title,
        harness: session.harness,
        projectId: session.projectId,
        projectName: names.get(session.projectId) ?? "",
      },
    ];
  });
}

export function clearSearch(): void {
  token += 1;
  set({ query: "", results: [], searching: false });
}

// ---------------------------------------------------------------- hot reload

/**
 * This module is not hot-swappable, so an edit reloads the window.
 *
 * It holds live state and, more importantly, the transcript subscription
 * registered once at startup. Vite replaces the module on every edit, and
 * React Fast Refresh makes the components importing it self-accepting, so the
 * update is absorbed without a page reload: the components start reading a
 * fresh, empty copy while the subscription keeps writing into the old one.
 *
 * Nothing re-renders. A reply streams into a store nobody is looking at, the
 * blocks still reach the database, and clicking the conversation appears to
 * fix it because that path reloads from there. Which is a very convincing
 * impression of a broken transcript, and cost a lot of time to recognise.
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate();
  });
}
