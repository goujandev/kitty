import type { TranscriptEvent } from "../ipc/bindings";

export type ProjectActivityStatus = "working" | "approval" | "completed" | "failed" | "stopped";
type Outcome = Exclude<ProjectActivityStatus, "working" | "approval">;

export interface ProjectActivity {
  status: ProjectActivityStatus;
  unread: boolean;
  /** Conversations in the project with a turn in flight. */
  runningCount: number;
}

interface SessionActivity {
  projectId: string;
  status: ProjectActivityStatus | "idle";
  approvals: Set<string>;
}

interface ProjectRun {
  outcome: Outcome | null;
  unread: boolean;
}

/** Events that change whether a conversation is working, waiting or done. */
export function isActivityEvent(event: TranscriptEvent): boolean {
  return event.kind === "turnEnded" || event.kind === "failed" || event.kind === "approvalRequested"
    || event.kind === "approvalResolved" || (event.kind === "blockAppended" && event.blockKind === "user");
}

function active(status: SessionActivity["status"]): status is "working" | "approval" {
  return status === "working" || status === "approval";
}

const severity: Record<Outcome, number> = { completed: 0, stopped: 1, failed: 2 };

/**
 * Per-project badges for the sidebar: which projects have a conversation
 * working or waiting for permission, and which finished while you were
 * elsewhere. A disposable UI projection; only Rust transcript events feed it.
 */
export class ProjectActivityTracker {
  private sessions = new Map<string, SessionActivity>();
  private projects = new Map<string, ProjectRun>();
  private viewed: string | null = null;

  constructor(saved?: unknown) {
    // Persist only observed, unread results. Never restore a stale running flag.
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;
    for (const [id, outcome] of Object.entries(saved)) {
      if (outcome === "completed" || outcome === "failed" || outcome === "stopped") {
        this.projects.set(id, { outcome, unread: true });
      }
    }
  }

  projectFor(sessionId: string): string | undefined { return this.sessions.get(sessionId)?.projectId; }

  register(sessionId: string, projectId: string): void {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { projectId, status: "idle", approvals: new Set() });
  }

  view(projectId: string | null): void {
    this.viewed = projectId;
    const project = projectId ? this.projects.get(projectId) : undefined;
    if (project) project.unread = false;
  }

  private project(id: string): ProjectRun {
    let project = this.projects.get(id);
    if (!project) {
      project = { outcome: null, unread: false };
      this.projects.set(id, project);
    }
    return project;
  }

  start(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.status = session.approvals.size ? "approval" : "working";
  }

  private finish(sessionId: string, outcome: Outcome): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // A clean end that follows an error must not turn a failed turn green.
    if (session.status === "failed" && outcome !== "failed") return;
    session.status = outcome;
    session.approvals.clear();
    const project = this.project(session.projectId);
    // While unread, the worst result since the project was last looked at wins.
    project.outcome = project.unread && project.outcome && severity[project.outcome] > severity[outcome]
      ? project.outcome : outcome;
    project.unread = this.viewed !== session.projectId;
  }

  transcript(sessionId: string, events: TranscriptEvent[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const event of events) {
      if (event.kind === "blockAppended" && event.blockKind === "user") {
        this.start(sessionId);
      } else if (event.kind === "approvalRequested") {
        session.approvals.add(event.id);
        this.start(sessionId);
      } else if (event.kind === "approvalResolved") {
        session.approvals.delete(event.id);
        if (session.status === "approval" && !session.approvals.size) session.status = "working";
      } else if (event.kind === "failed") {
        this.finish(sessionId, "failed");
      } else if (event.kind === "turnEnded") {
        this.finish(sessionId, event.stop.kind === "endTurn" ? "completed" : event.stop.kind === "failed" ? "failed" : "stopped");
      }
    }
  }

  forget(projectId: string): void {
    this.projects.delete(projectId);
    for (const [id, session] of this.sessions) {
      if (session.projectId === projectId) this.sessions.delete(id);
    }
  }

  /** Conversations with a turn in flight, to the project they belong to. */
  running(): Record<string, string> {
    return Object.fromEntries([...this.sessions].filter(([, session]) => active(session.status)).map(([id, session]) => [id, session.projectId]));
  }

  snapshot(): Record<string, ProjectActivity> {
    const result: Record<string, ProjectActivity> = {};
    const ids = new Set([...this.projects.keys(), ...[...this.sessions.values()].map(session => session.projectId)]);
    for (const projectId of ids) {
      const working = [...this.sessions.values()].filter(session => session.projectId === projectId && active(session.status));
      const project = this.projects.get(projectId);
      if (working.length) {
        result[projectId] = { status: working.some(session => session.status === "approval") ? "approval" : "working", unread: false, runningCount: working.length };
      } else if (project?.outcome && project.unread) {
        result[projectId] = { status: project.outcome, unread: true, runningCount: 0 };
      }
    }
    return result;
  }

  unread(): Record<string, Outcome> {
    return Object.fromEntries(Object.entries(this.snapshot()).filter(([, value]) => value.unread).map(([id, value]) => [id, value.status as Outcome]));
  }
}
