import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ProjectSummary, SessionRow } from "../ipc/bindings";
import * as ipc from "../ipc/commands";
import { removeSession, reorderSessions, snapshot, useChat } from "../stores/chatStore";
import { useProjects } from "../stores/projectStore";

export interface IndexedThread {
  session: SessionRow;
  project: ProjectSummary;
}

/** A small read model for the global library and the combined projects rail. */
export function useThreadIndex(): {
  threads: IndexedThread[];
  sessionsByProject: Record<string, SessionRow[]>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  deleteThread: (session: SessionRow) => Promise<boolean>;
  reorderThreads: (projectId: string, ids: string[]) => Promise<void>;
} {
  const { projects } = useProjects();
  const chat = useChat();
  const [sessionsByProject, setSessions] = useState<Record<string, SessionRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++request.current;
    setLoading(true);
    const results = await Promise.allSettled(
      projects.map((project) => ipc.listSessions(project.id)),
    );
    if (mine !== request.current) return;
    setSessions((previous) => {
      const next: Record<string, SessionRow[]> = {};
      results.forEach((result, index) => {
        const project = projects[index];
        if (!project) return;
        if (result.status === "fulfilled") next[project.id] = result.value;
        else {
          next[project.id] = previous[project.id] ?? [];
        }
      });
      return next;
    });
    // Record failures outside the updater; React may schedule that updater later.
    const failures = results.flatMap((result, index) =>
      result.status === "rejected" ? [projects[index]?.name ?? "project"] : [],
    );
    setError(failures.length ? `Could not load threads for ${failures.join(", ")}.` : null);
    setLoading(false);
  }, [projects]);

  useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh, chat.sessions]);

  const threads = useMemo(() => projects.flatMap((project) =>
    (sessionsByProject[project.id] ?? []).map((session) => ({ project, session })),
  ), [projects, sessionsByProject]);

  const deleteThread = useCallback(async (session: SessionRow) => {
    setError(null);
    try {
      if (session.projectId === chat.project?.id) {
        if (!await removeSession(session.id)) {
          setError(snapshot().error ?? "Could not delete this thread.");
          return false;
        }
      } else await ipc.deleteSession(session.id);
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [chat.project?.id, refresh]);

  const reorderThreads = useCallback(async (projectId: string, ids: string[]) => {
    setError(null);
    try {
      if (projectId === chat.project?.id) await reorderSessions(ids);
      else await ipc.reorderSessions(ids);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [chat.project?.id, refresh]);

  return { threads, sessionsByProject, loading, error, refresh, deleteThread, reorderThreads };
}
