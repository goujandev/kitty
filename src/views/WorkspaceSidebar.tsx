import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { archiveChat, deleteChat, ensureCatalogs, forgetProject, modelLabel, renameChat, renameProject, useChat } from "../stores/chatStore";
import { ProviderMark } from "./Marks";
import { refresh, reorder, setExpanded, useProjects } from "../stores/projectStore";
import { setRailWidth, useAppearance } from "../stores/appearanceStore";
import { nearbyAfterRemoval, splitChats } from "../stores/sidebarModel";
import { useDragResize } from "../hooks/useDragResize";
import { useReorder } from "../hooks/useReorder";
import { ActionMenu, type ActionMenuHandle, type MenuItem } from "./ActionMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { focusChatRow, focusChooser, focusComposer, focusProjectRow } from "./focus";
import { Grip } from "./Grip";
import { Icon, PantheonMark } from "./Icon";
import { InlineRename } from "./InlineRename";
import { ProjectMonogram } from "./ProjectMonogram";
import type { ProjectActivity } from "../stores/projectActivity";
import type { ProjectSummary, SessionRow } from "../ipc/bindings";

export interface WorkspaceSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onSelectProject: (id: string) => void;
  onOpenSession: (projectId: string, sessionId: string) => void;
  onNewChat: (projectId?: string) => void;
  onAddProject: () => void;
  onSearch: () => void;
  onSettings: () => void;
}

type Renaming = { kind: "project"; id: string } | { kind: "chat"; id: string; projectId: string };
type Confirming =
  | { kind: "project"; project: ProjectSummary }
  | { kind: "chat"; projectId: string; chat: SessionRow };

const AGENT = { codex: "Codex", claude: "Claude Code" } as const;

/** What a chat is called in the list. Titles come from the first message. */
export function chatTitle(row: Pick<SessionRow, "title">): string {
  return row.title?.trim() || "New chat";
}

// Where the list was scrolled, kept across collapsing the sidebar, which
// unmounts it, so expanding again shows the same place.
let savedScroll = 0;

export function WorkspaceSidebar(props: WorkspaceSidebarProps): React.ReactElement | null {
  const { projects, error, chats, expanded } = useProjects();
  const chat = useChat();
  const { rails } = useAppearance();
  const [renaming, setRenaming] = useState<Renaming | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});
  const menus = useRef(new Map<string, ActionMenuHandle | null>());
  const list = useRef<HTMLElement>(null);
  const folders = projects.filter(project => project.root !== null);
  const drag = useReorder(folders, project => project.id, ids => { void reorder([...ids, ...projects.filter(project => project.root === null).map(project => project.id)]); });
  const resize = useDragResize({ min: 200, max: () => Math.min(400, window.innerWidth / 3), defaultWidth: 256, initial: rails.projects, onCommit: width => setRailWidth("projects", width) });
  useEffect(() => { void refresh(); }, []);
  // Model names in the list come from the model catalogs.
  useEffect(() => { ensureCatalogs(Object.values(chats).flat().map(row => row.harness)); }, [chats]);
  useLayoutEffect(() => {
    if (props.collapsed || !list.current) return;
    list.current.scrollTop = savedScroll;
  }, [props.collapsed]);

  const rowsOf = (projectId: string) => chats[projectId] ?? [];

  const openMenu = (key: string, event: React.MouseEvent | React.KeyboardEvent) => {
    const handle = menus.current.get(key);
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    const row = (event.currentTarget as HTMLElement).querySelector<HTMLElement>(".ws-project__open, .ws-chat__open");
    if ("clientX" in event && event.type === "contextmenu") handle.openAt(event.clientX, event.clientY, row);
    else handle.open(row);
  };
  // Shift+F10 and the context-menu key open a row's actions, as on any
  // Windows list; F2 renames, as in Explorer.
  const rowKeys = (key: string, rename: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openMenu(key, event);
    else if (event.key === "F2") { event.preventDefault(); rename(); }
  };

  const chatRow = (project: ProjectSummary, row: SessionRow) => {
    const title = chatTitle(row);
    const isActive = chat.project?.id === project.id && chat.activeId === row.id;
    const working = row.id in chat.running;
    const waiting = row.id in chat.waiting;
    const archived = Boolean(row.archivedAt);
    const isRenaming = renaming?.kind === "chat" && renaming.id === row.id;
    const items: MenuItem[] = [
      { label: "Rename", shortcut: "F2", onSelect: () => setRenaming({ kind: "chat", id: row.id, projectId: project.id }) },
      archived
        ? { label: "Restore", onSelect: () => void archiveChat(project.id, row.id, false).then(() => focusChatRow(row.id)) }
        : { label: "Archive", onSelect: () => {
            const pool = splitChats(rowsOf(project.id)).open.map(entry => entry.id);
            void archiveChat(project.id, row.id, true).then(selected => {
              if (selected !== false) focusChatRow(isActive ? selected : nearbyAfterRemoval(pool, row.id));
            });
          } },
      { label: "Delete…", danger: true, separatorBefore: true, onSelect: () => setConfirming({ kind: "chat", projectId: project.id, chat: row }) },
    ];
    return <li key={row.id} data-chat-id={row.id} className={`ws-chat${isActive ? " is-active" : ""}${archived ? " is-archived" : ""}${isRenaming ? " is-renaming" : ""}`}
      onContextMenu={event => openMenu(row.id, event)} onKeyDown={rowKeys(row.id, () => setRenaming({ kind: "chat", id: row.id, projectId: project.id }))}>
      {isRenaming
        ? <InlineRename initial={title} what="chat" label="Rename chat" className="ws-chat__rename"
            onSave={name => void renameChat(project.id, row.id, name)}
            onDone={() => { setRenaming(null); focusChatRow(row.id); }} />
        : <button type="button" className="ws-chat__open" aria-current={isActive ? "page" : undefined}
            title={`${title}\n${AGENT[row.harness] ?? row.harness} · ${modelLabel(row)}`}
            onClick={() => props.onOpenSession(project.id, row.id)}
            onDoubleClick={() => setRenaming({ kind: "chat", id: row.id, projectId: project.id })}>
            <ProviderMark harness={row.harness} size={14} brand />
            <span className="ws-chat__text"><span className="ws-chat__title">{title}</span><span className="ws-chat__model">{modelLabel(row)}</span></span>
            {waiting
              ? <span className="ws-chat__state ws-chat__state--waiting" role="img" aria-label="Needs approval" title="Needs approval"><Icon name="clock" size={14} /></span>
              : working && <span className="ws-chat__state project-activity__working" role="img" aria-label="Working" title="Working" />}
          </button>}
      {!isRenaming && <ActionMenu ref={handle => { menus.current.set(row.id, handle); }} label={`Actions for ${title}`} items={items} />}
    </li>;
  };

  const projectBlock = (project: ProjectSummary) => {
    const active = chat.project?.id === project.id;
    const open = Boolean(expanded[project.id]);
    const activity = chat.projectActivity[project.id];
    const isRenaming = renaming?.kind === "project" && renaming.id === project.id;
    const { open: openChats, archived } = splitChats(rowsOf(project.id));
    const showArchived = archivedOpen[project.id] ?? false;
    const draft = active && chat.draft !== null && chat.activeId === null;
    const items: MenuItem[] = [
      { label: "New chat", shortcut: active ? "Ctrl+N" : undefined, onSelect: () => props.onNewChat(project.id) },
      { label: "Rename", shortcut: "F2", onSelect: () => setRenaming({ kind: "project", id: project.id }) },
      { label: "Remove from Pantheon…", danger: true, separatorBefore: true, onSelect: () => setConfirming({ kind: "project", project }) },
    ];
    if (!project.exists) items.shift();
    return <li key={project.id} data-project-id={project.id} className={`ws-project${active ? " is-active" : ""}${open ? " is-open" : ""}${activity?.unread ? " is-unread" : ""}${drag.dragging === project.id ? " is-dragging" : ""}`}>
      <div className="ws-project__row" {...(isRenaming ? {} : drag.rowProps(project.id))}
        onContextMenu={event => openMenu(project.id, event)} onKeyDown={rowKeys(project.id, () => setRenaming({ kind: "project", id: project.id }))}>
        <button type="button" className="ws-project__toggle" aria-expanded={open} aria-controls={`chats-${project.id}`}
          aria-label={open ? `Hide chats in ${project.name}` : `Show chats in ${project.name}`} title={open ? "Hide chats" : "Show chats"}
          draggable={false}
          onClick={() => setExpanded(project.id, !open)}>
          <span className="ws-project__icon"><ProjectMonogram name={project.name} /></span>
          <span className="ws-project__chevron"><Icon name="chevron" size={14} /></span>
        </button>
        {isRenaming
          ? <InlineRename initial={project.name} what="project" label="Rename project" className="ws-project__rename"
              hint={`Only the name in Pantheon changes. The folder stays ${project.root?.split(/[\\/]/).filter(Boolean).pop() ?? ""}.`}
              onSave={name => void renameProject(project.id, name)}
              onDone={() => { setRenaming(null); focusProjectRow(project.id); }} />
          : <button type="button" className="ws-project__open" aria-current={active ? "true" : undefined}
              aria-describedby={activity ? `activity-${project.id}` : undefined}
              title={project.exists ? project.root ?? project.name : `${project.root} — folder not found`}
              disabled={!project.exists}
              onClick={() => { if (active) setExpanded(project.id, true); else props.onSelectProject(project.id); }}
              onDoubleClick={() => setRenaming({ kind: "project", id: project.id })}>
              <span className="ws-project__name">{project.name}</span>
              {!project.exists && <span className="ws-project__missing">Folder not found</span>}
            </button>}
        <ProjectStatus projectId={project.id} activity={activity} />
        {!isRenaming && <ActionMenu ref={handle => { menus.current.set(project.id, handle); }} label={`Actions for ${project.name}`} items={items} />}
      </div>
      {open && <ul id={`chats-${project.id}`} className="ws-chat-list" aria-label={`Chats in ${project.name}`}>
        {draft && <li className="ws-chat ws-chat--draft is-active">
          <button type="button" className="ws-chat__open" aria-current="page" onClick={focusComposer}>
            <span className="ws-chat__title">New chat</span><span className="ws-chat__hint">Draft</span>
          </button>
        </li>}
        {openChats.map(row => chatRow(project, row))}
        {!draft && openChats.length === 0 && project.exists && <li className="ws-chat-empty">
          <span>{archived.length ? "All chats are archived." : "No chats yet."}</span>
          <button type="button" className="ws-link" onClick={() => props.onNewChat(project.id)}>Start a chat</button>
        </li>}
        {archived.length > 0 && <li className="ws-archived">
          <button type="button" className="ws-archived__toggle" aria-expanded={showArchived}
            onClick={() => setArchivedOpen(value => ({ ...value, [project.id]: !showArchived }))}>
            <span>{showArchived ? "Hide archived" : "Archived"}</span><span className="ws-archived__count">{archived.length}</span>
          </button>
          {showArchived && <ul aria-label={`Archived chats in ${project.name}`}>{archived.map(row => chatRow(project, row))}</ul>}
        </li>}
      </ul>}
    </li>;
  };

  const confirmBody = (target: Confirming) => {
    if (target.kind === "chat") {
      const working = target.chat.id in chat.running;
      return <>
        <p>This permanently removes the conversation and its history from Pantheon. It can't be undone.</p>
        <p>Files in the project aren't changed. {AGENT[target.chat.harness] ?? "The agent"} keeps its own record of the session.</p>
        {working && <p>The agent working in this chat will be stopped.</p>}
      </>;
    }
    const count = target.project.sessionCount;
    return <>
      <p>The folder <span className="confirm-dialog__path">{target.project.root}</span> and everything in it stay on your computer.</p>
      <p>{count === 0 ? "It has no saved chats." : `Its ${count} saved ${count === 1 ? "chat" : "chats"} in Pantheon will be permanently deleted.`}</p>
    </>;
  };

  const runConfirm = async (target: Confirming) => {
    if (target.kind === "chat") {
      const { open, archived } = splitChats(rowsOf(target.projectId));
      const pool = (!target.chat.archivedAt ? open : archived).map(row => row.id);
      const wasActive = chat.activeId === target.chat.id;
      const selected = await deleteChat(target.projectId, target.chat.id);
      setConfirming(null);
      if (selected === false) { focusChatRow(target.chat.id); return; }
      focusChatRow(wasActive ? selected : nearbyAfterRemoval(pool, target.chat.id));
      return;
    }
    const ids = folders.map(project => project.id);
    const wasActive = chat.project?.id === target.project.id;
    const ok = await forgetProject(target.project.id);
    setConfirming(null);
    if (!ok) { focusProjectRow(target.project.id); return; }
    if (wasActive) { focusChooser(); return; }
    const next = nearbyAfterRemoval(ids, target.project.id);
    if (next) focusProjectRow(next); else focusChooser();
  };

  const primary = [
    { label: "New chat", icon: "squarePen" as const, keys: "Ctrl+N", aria: "Control+N", run: () => props.onNewChat() },
    { label: "New project", icon: "folderPlus" as const, keys: "Ctrl+O", aria: "Control+O", run: props.onAddProject },
    { label: "Search", icon: "search" as const, keys: "Ctrl+K", aria: "Control+K", run: props.onSearch },
  ];

  // Closed means gone, as in the reference: the chat gets the whole window.
  // The title bar keeps a button to bring it back (and Ctrl+B).
  if (props.collapsed) return null;

  return <aside className={`ws-sidebar ws-sidebar--projects${props.collapsed ? " ws-sidebar--collapsed" : ""}`} ref={resize.setPaneRef} aria-label="Projects and chats" data-app-sidebar>
    <header className="ws-sidebar__head" data-tauri-drag-region>
      <button type="button" className="ws-icon-button" aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"} title={`${props.collapsed ? "Expand" : "Collapse"} sidebar (Ctrl+B)`} aria-keyshortcuts="Control+B" onClick={props.onToggleCollapse}><Icon name={props.collapsed ? "panel" : "panelClose"} size={16} /></button>
      {!props.collapsed && <span className="ws-brand" data-tauri-drag-region><PantheonMark size={24} />Pantheon</span>}
    </header>
    <nav className="ws-primary" aria-label="Start">
      {primary.map(action => <button key={action.label} type="button" className="ws-action" aria-label={props.collapsed ? action.label : undefined}
        title={`${action.label} (${action.keys})`} aria-keyshortcuts={action.aria} onClick={action.run}>
        <Icon name={action.icon} size={16} />
        {!props.collapsed && <><span className="ws-action__label">{action.label}</span><kbd className="ws-action__keys">{action.keys}</kbd></>}
      </button>)}
    </nav>
    {props.collapsed
      ? <nav className="ws-nav ws-nav--compact-projects" aria-label="Projects">{folders.map(project => <button key={project.id} type="button"
          className={`ws-nav__item${chat.project?.id === project.id ? " is-active" : ""}`} title={project.name} aria-label={project.name}
          aria-describedby={chat.projectActivity[project.id] ? `activity-${project.id}` : undefined}
          aria-current={chat.project?.id === project.id ? "true" : undefined} disabled={!project.exists}
          onClick={() => props.onSelectProject(project.id)}>
          <ProjectMonogram name={project.name} /><ProjectStatus projectId={project.id} activity={chat.projectActivity[project.id]} compact />
        </button>)}</nav>
      : <section className="ws-projects" ref={list} aria-labelledby="ws-projects-label" onScroll={event => { savedScroll = event.currentTarget.scrollTop; }}>
          <h2 id="ws-projects-label" className="ws-section-label">Projects</h2>
          {error && <p role="alert" className="ws-error">{error} <button type="button" className="ws-link" onClick={() => void refresh()}>Try again</button></p>}
          {folders.length > 0
            ? <ul className="ws-project-list">{drag.items.map(projectBlock)}</ul>
            : <div className="ws-empty"><p>Open a project to start working.</p><button type="button" className="ws-link" onClick={props.onAddProject}>New project…</button></div>}
        </section>}
    <footer className="ws-footer">
      <button type="button" className="ws-action ws-action--footer" aria-label={props.collapsed ? "Settings" : undefined} title="Settings" onClick={props.onSettings}>
        <Icon name="settings" size={16} />{!props.collapsed && <span className="ws-action__label">Settings</span>}
      </button>
    </footer>
    {!props.collapsed && <Grip resize={resize} label="Resize sidebar" />}
    {confirming && <ConfirmDialog
      title={confirming.kind === "chat" ? `Delete “${chatTitle(confirming.chat)}”?` : `Remove “${confirming.project.name}” from Pantheon?`}
      confirmLabel={confirming.kind === "chat" ? "Delete chat" : "Remove project"}
      workingLabel={confirming.kind === "chat" ? "Deleting…" : "Removing…"}
      onConfirm={() => runConfirm(confirming)}
      onCancel={() => {
        const target = confirming;
        setConfirming(null);
        if (target.kind === "chat") focusChatRow(target.chat.id); else focusProjectRow(target.project.id);
      }}>
      {confirmBody(confirming)}
    </ConfirmDialog>}
  </aside>;
}

const statusLabels = { working: "Working", approval: "Needs approval", completed: "Done", failed: "Failed", stopped: "Stopped" } as const;

function ProjectStatus({ projectId, activity, compact = false }: { projectId: string; activity?: ProjectActivity; compact?: boolean }): React.ReactElement | null {
  if (!activity) return null;
  const label = statusLabels[activity.status];
  return <span id={`activity-${projectId}`} className={`project-activity project-activity--${activity.status}${compact ? " project-activity--compact" : ""}`} role="status" title={`${label}${activity.unread ? " · Unread" : ""}${activity.runningCount > 1 ? ` · ${activity.runningCount} chats` : ""}`}>
    {activity.status === "working" ? <span className="project-activity__working" aria-hidden="true" /> : <Icon name={activity.status === "completed" ? "check" : activity.status === "approval" ? "clock" : "close"} size={12} />}
    <span className="project-activity__label">{label}</span>
  </span>;
}
