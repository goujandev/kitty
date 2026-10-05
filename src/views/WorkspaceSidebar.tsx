import { useEffect, useRef, useState } from "react";

import type { ProjectSummary, SessionRow } from "../ipc/bindings";
import { useDragResize } from "../hooks/useDragResize";
import { useReorder } from "../hooks/useReorder";
import { useThreadIndex } from "../hooks/useThreadIndex";
import { setRailWidth, useAppearance } from "../stores/appearanceStore";
import { forgetProject, useChat } from "../stores/chatStore";
import { useHarnessState } from "../stores/harnessStore";
import { refresh, reorder, useProjects } from "../stores/projectStore";
import { Grip } from "./Grip";
import { Icon, KittyMark } from "./Icon";
import { RowMenu } from "./RowMenu";

export interface WorkspaceSidebarProps {
  collapsed: boolean;
  activeView: "home" | "chat" | "threads" | "settings";
  onToggleCollapse: () => void;
  onHome: () => void;
  onThreads: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onNewThread: () => void;
  onAddProject: () => void;
  onOpenProject: (id: string) => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onThreadDeleted?: (id: string) => void;
}

interface RowTarget {
  kind: "project" | "thread";
  project: ProjectSummary;
  session?: SessionRow;
  label: string;
}

const projectId = (project: ProjectSummary): string => project.id;
const sessionId = (session: SessionRow): string => session.id;

export function WorkspaceSidebar(props: WorkspaceSidebarProps): React.ReactElement {
  const { projects, loading: projectLoading, error: projectError } = useProjects();
  const chat = useChat();
  const { rails } = useAppearance();
  const { scan } = useHarnessState();
  const index = useThreadIndex();
  const drag = useReorder(projects, projectId, reorder);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<(RowTarget & { x: number; y: number }) | null>(null);
  const [confirming, setConfirming] = useState<RowTarget | null>(null);
  const confirmation = useRef<HTMLDivElement>(null);
  const resize = useDragResize({
    min: 224,
    max: () => Math.min(330, Math.max(224, Math.floor(window.innerWidth / 2))),
    defaultWidth: 240,
    initial: rails.projects === 198 ? 240 : rails.projects,
    onCommit: (width) => setRailWidth("projects", width),
  });

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!chat.project?.root) return;
    const id = chat.project.id;
    setExpanded((previous) => new Set(previous).add(id));
  }, [chat.project?.id, chat.project?.root]);
  useEffect(() => {
    if (!confirming) return;
    confirmation.current?.scrollIntoView({ block: "nearest" });
    confirmation.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [confirming]);

  const ready = scan?.harnesses.filter((agent) => agent.ready).length ?? 0;
  const busyProjects = new Set(Object.values(chat.running));
  const toggleProject = (id: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const openMenu = (target: RowTarget, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const position = event.type === "contextmenu"
      ? { x: event.clientX, y: event.clientY }
      : { x: event.currentTarget.getBoundingClientRect().left,
          y: event.currentTarget.getBoundingClientRect().bottom };
    setMenu({ ...target, ...position });
  };

  return (
    <aside className={`ws-sidebar${props.collapsed ? " ws-sidebar--collapsed" : ""}`}
      ref={resize.setPaneRef} aria-label="Workspace navigation">
      <header className="ws-sidebar__head" data-tauri-drag-region>
        <button type="button" className="ws-brand" title="Kitty home" onClick={props.onHome}>
          <KittyMark size={22} /><span>Kitty</span>
        </button>
        <div className="ws-sidebar__actions">
          <button type="button" className="ws-icon-button" title="Search threads" aria-label="Search threads" onClick={props.onSearch}>
            <Icon name="search" size={15} />
          </button>
          <button type="button" className="ws-icon-button" title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={props.onToggleCollapse}>
            <Icon name="panel" size={15} />
          </button>
        </div>
      </header>

      <nav className="ws-nav" aria-label="Main">
        <button type="button" className={`ws-nav__item${props.activeView === "home" ? " is-active" : ""}`}
          title="New thread" onClick={props.onNewThread}>
          <Icon name="plus" size={16} /><span className="ws-nav__label">New thread</span>
        </button>
        <button type="button" className={`ws-nav__item${props.activeView === "threads" ? " is-active" : ""}`}
          title="All threads" aria-current={props.activeView === "threads" ? "page" : undefined} onClick={props.onThreads}>
          <Icon name="threads" size={16} /><span className="ws-nav__label">Threads</span>
          <span className="ws-nav__count">{index.threads.length || ""}</span>
        </button>
      </nav>

      {!props.collapsed && <section className="ws-projects" aria-label="Projects and chats">
        <div className="ws-section-label"><span>Projects</span>
          <button type="button" className="ws-icon-button" title="Open a project folder" aria-label="Open a project folder" onClick={props.onAddProject}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        {(projectError || index.error) && <p className="ws-error" role="alert">{projectError ?? index.error}</p>}
        <ul className="ws-project-list">
          {drag.items.map((project) => {
            const target: RowTarget = { kind: "project", project, label: project.name };
            const open = expanded.has(project.id);
            const active = chat.project?.id === project.id && props.activeView === "chat";
            return <li key={project.id} className={`ws-project${active ? " is-active" : ""}`}>
              <div className={`ws-project__row${drag.dragging === project.id ? " is-dragging" : ""}`}
                {...drag.rowProps(project.id)} onContextMenu={(event) => openMenu(target, event)}>
                {project.root !== null ? <button type="button" className="ws-project__toggle"
                  aria-label={`${open ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={open} onClick={() => toggleProject(project.id)}>
                  <Icon name={open ? "chevronDown" : "chevron"} size={12} />
                </button> : <span className="ws-project__toggle ws-project__toggle--empty" />}
                <button type="button" className="ws-project__open" disabled={!project.exists}
                  title={project.root ?? project.name} onClick={() => props.onOpenProject(project.id)}>
                  <Icon name={project.root ? "folder" : "message"} size={15} />
                  <span className="ws-project__name">{project.name}</span>
                  {busyProjects.has(project.id) && <span className="ws-thread__status" aria-label="Working" />}
                </button>
                <button type="button" className="ws-project__more" title={`Actions for ${project.name}`}
                  aria-label={`Actions for ${project.name}`} onClick={(event) => openMenu(target, event)}>
                  <Icon name="more" size={14} />
                </button>
              </div>
              {project.root !== null && open && <ProjectThreads project={project}
                sessions={index.sessionsByProject[project.id] ?? []} activeId={chat.activeId}
                running={chat.running} showActive={props.activeView === "chat"}
                onOpen={props.onOpenSession} onMenu={openMenu}
                onReorder={(ids) => { void index.reorderThreads(project.id, ids); }} />}
            </li>;
          })}
        </ul>
        {!projectLoading && projects.length === 0 && <p className="ws-projects__empty">Open a folder to start a project.</p>}
        {confirming && <div className="ws-confirm" ref={confirmation} role="alert">
          <p>{confirming.kind === "project" && confirming.project.root ? `Delete “${confirming.label}” and its threads?` : `Delete “${confirming.label}”?`}</p>
          <div><button type="button" onClick={() => setConfirming(null)}>Cancel</button>
            <button type="button" className="is-danger" onClick={() => {
              const target = confirming;
              setConfirming(null);
              if (target.kind === "project") void forgetProject(target.project.id);
              else if (target.session) void index.deleteThread(target.session).then(deleted => {
                if (deleted && target.session) props.onThreadDeleted?.(target.session.id);
              });
            }}>Delete</button></div>
        </div>}
      </section>}

      <footer className="ws-footer">
        <button type="button" className={`ws-footer__settings${props.activeView === "settings" ? " is-active" : ""}`}
          title="Settings" onClick={props.onSettings}><Icon name="settings" size={16} /><span>Settings</span></button>
        {!props.collapsed && <div className="ws-footer__status">
          <span className={`ws-status-dot${ready ? " is-ready" : ""}`} />
          <span>{!scan ? "Checking agents…" : ready ? `${ready} ${ready === 1 ? "agent" : "agents"} ready` : "No agents ready"}</span>
          <span className="ws-footer__local">Local</span>
        </div>}
      </footer>

      {menu && <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <button type="button" className="rowmenu__item" role="menuitem" onClick={() => {
          const target = menu; setMenu(null);
          if (target.session) props.onOpenSession(target.project.id, target.session.id);
          else props.onOpenProject(target.project.id);
        }}>Open {menu.kind === "thread" ? "thread" : "project"}</button>
        <button type="button" className="rowmenu__item rowmenu__item--danger" role="menuitem" onClick={() => {
          setConfirming(menu); setMenu(null);
        }}>Delete {menu.kind === "thread" ? "thread" : "project"}…</button>
      </RowMenu>}
      {!props.collapsed && <Grip resize={resize} label="Resize workspace sidebar" />}
    </aside>
  );
}

function ProjectThreads({ project, sessions, activeId, running, showActive, onOpen, onMenu, onReorder }: {
  project: ProjectSummary;
  sessions: SessionRow[];
  activeId: string | null;
  running: Record<string, string>;
  showActive: boolean;
  onOpen: (projectId: string, sessionId: string) => void;
  onMenu: (target: RowTarget, event: React.MouseEvent) => void;
  onReorder: (ids: string[]) => void;
}): React.ReactElement {
  const drag = useReorder(sessions, sessionId, onReorder);
  return <ul className="ws-thread-list">
    {drag.items.map((session) => {
      const label = session.title ?? "Untitled thread";
      const target: RowTarget = { kind: "thread", project, session, label };
      return <li key={session.id} className={`ws-thread${showActive && activeId === session.id ? " is-active" : ""}${drag.dragging === session.id ? " is-dragging" : ""}`}
        {...drag.rowProps(session.id)} onContextMenu={(event) => onMenu(target, event)}>
        <button type="button" className="ws-thread__open" title={label} onClick={() => onOpen(project.id, session.id)}>
          <span className="ws-thread__name">{label}</span>
          {session.id in running && <span className="ws-thread__status" aria-label="Working" />}
        </button>
        <button type="button" className="ws-thread__more" title={`Actions for ${label}`} aria-label={`Actions for ${label}`}
          onClick={(event) => onMenu(target, event)}><Icon name="more" size={13} /></button>
      </li>;
    })}
    {sessions.length === 0 && <li className="ws-thread-list__empty">No threads yet</li>}
  </ul>;
}
