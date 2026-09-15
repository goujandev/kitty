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
  query: string;
  results: SearchResult[];
  searching: boolean;
  error: string | null;
}

const EMPTY: ProjectState = {
  projects: [],
  loading: false,
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

export async function refresh(): Promise<void> {
  set({ loading: true, error: null });
  try {
    set({ projects: await ipc.listProjectSummaries(), loading: false });
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

export async function remove(projectId: string): Promise<void> {
  try {
    await ipc.removeProject(projectId);
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
