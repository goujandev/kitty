import { useEffect, useState } from "react";

import {
  chooseProject,
  listen,
  newChat,
  newSession,
  openById,
  openSessionAnywhere,
  loadDefaultChoice,
  restoreLastProject,
  useChat,
} from "./stores/chatStore";
import { loadAppearance, nudgeZoom } from "./stores/appearanceStore";
import { initialise, useHarnessState } from "./stores/harnessStore";
import { useProjects } from "./stores/projectStore";
import { ChatView } from "./views/ChatView";
import { WorkspaceSidebar } from "./views/WorkspaceSidebar";
import { ThreadLibrary } from "./views/ThreadLibrary";
import { SearchDialog } from "./views/SearchDialog";
import { SettingsDialog, type Section } from "./views/Settings";
import { Icon } from "./views/Icon";
import { WindowControls } from "./views/WindowControls";

/** Shared workspace chrome around Kitty's existing session and model stores. */
export function App(): React.ReactElement {
  // Settings overlays the workspace without replacing its conversation.
  const [settings, setSettings] = useState<Section | null>(null);
  const [view, setView] = useState<"home" | "chat" | "threads">("home");
  const [searchOpen, setSearchOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("kitty:sidebar-collapsed") === "true"; }
    catch { return false; }
  });
  const [tabs, setTabs] = useState<{ id: string; projectId: string; title: string }[]>([]);
  const chat = useChat();
  const { scan } = useHarnessState();
  const projectIndex = useProjects();
  const firstReady = (scan?.harnesses ?? []).find((h) => h.ready)?.id;
  const startThread = () => {
    if (!firstReady) { setSettings("agents"); return; }
    setSettings(null);
    setView("chat");
    if (chat.project && (chat.project.root !== null || chat.activeId === null)) newSession();
    else void newChat();
  };
  const openThread = (projectId: string, id: string) => {
    setView("chat");
    setSettings(null);
    void openSessionAnywhere(projectId, id);
  };
  const toggleSidebar = () => setCollapsed((value) => {
    try { localStorage.setItem("kitty:sidebar-collapsed", String(!value)); } catch { /* Window state still works without storage. */ }
    return !value;
  });

  useEffect(() => {
    if (!chat.activeId || !chat.project) return;
    // A project switch loads its rows before opening the requested thread.
    // Do not attribute the previous active thread to that new project.
    const session = chat.sessions.find(s => s.id === chat.activeId && s.projectId === chat.project?.id);
    if (!session) return;
    const entry = { id: session.id, projectId: session.projectId, title: session.title ?? "Untitled thread" };
    setTabs(previous => {
      const existing = previous.findIndex(tab => tab.id === entry.id);
      if (existing >= 0) {
        if (previous[existing]?.title === entry.title && previous[existing]?.projectId === entry.projectId) return previous;
        return previous.map(tab => tab.id === entry.id ? entry : tab);
      }
      return [...previous, entry];
    });
  }, [chat.activeId, chat.project, chat.sessions]);

  useEffect(() => { if (chat.activeId) setView("chat"); }, [chat.activeId]);

  useEffect(() => {
    if (projectIndex.loading || projectIndex.error) return;
    const ids = new Set(projectIndex.projects.map(project => project.id));
    setTabs(previous => previous.some(tab => !ids.has(tab.projectId)) ? previous.filter(tab => ids.has(tab.projectId)) : previous);
  }, [projectIndex.projects, projectIndex.loading, projectIndex.error]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
      if (event.key.toLowerCase() === "b") { event.preventDefault(); toggleSidebar(); }
      if (event.key.toLowerCase() === "n" && firstReady) { event.preventDefault(); startThread(); }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [chat.project, firstReady]);

  useEffect(() => {
    // Deliberately after first paint. Probing spawns child processes and an
    // npm shim boots Node before it will answer, so doing this during startup
    // would put seconds in front of an empty window (PROTOTYPE-1 criterion 1).
    // The default model is read before the project, because restoring one
    // opens a conversation and that conversation wants to arrive with a model
    // already in the chip.
    void initialise();
    void loadDefaultChoice().then(restoreLastProject);
    void loadAppearance();

    const unlisten = listen();
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // The scan is deliberately slow -- it spawns a child process per CLI -- so a
  // project restored at startup gets its conversation opened before anything
  // is known to be able to run one, and the draft comes up with no model. This
  // catches that the moment the scan lands.
  useEffect(() => {
    if (!chat.project || chat.activeId !== null || chat.draft !== null) return;
    if (firstReady === undefined) return;
    newSession();
  }, [chat.project, chat.activeId, chat.draft, firstReady]);

  // WebView2 brings its own menu -- Back, Refresh, Save as, Print, Inspect --
  // which is a browser talking about itself inside an app that is not a
  // browser. Suppressed everywhere except text fields, where the one thing it
  // offers that we do not is cut, copy and paste.
  useEffect(() => {
    const onMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea")) return;
      event.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

  // Ctrl and plus, minus, or zero. Handled here rather than left to the
  // webview's own hotkeys so the level is saved: the reason to change it is
  // usually the monitor, and the monitor is still there next time.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;
      // `=` is the unshifted key that carries `+` on most layouts, so both
      // arrive here and both should zoom in. `NumpadAdd` reports as `+`.
      const direction =
        event.key === "+" || event.key === "="
          ? 1
          : event.key === "-" || event.key === "_"
            ? -1
            : event.key === "0"
              ? 0
              : null;
      if (direction === null) return;
      event.preventDefault();
      void nudgeZoom(direction);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={`workspace ${collapsed ? "workspace--collapsed" : ""}`}>
      <WorkspaceSidebar collapsed={collapsed} activeView={settings ? "settings" : view}
        onToggleCollapse={toggleSidebar} onHome={startThread} onThreads={() => setView("threads")}
        onSearch={() => setSearchOpen(true)} onSettings={() => setSettings("appearance")}
        onNewThread={startThread} onAddProject={() => { setView("chat"); void chooseProject(); }}
        onOpenProject={(id) => { setView("chat"); void openById(id); }} onOpenSession={openThread}
        onThreadDeleted={(id) => setTabs(previous => previous.filter(tab => tab.id !== id))} />
      <div className="workspace__main">
        <header className="workspace-tabs" data-tauri-drag-region>
          {collapsed && <button className="icon-button" type="button" aria-label="Expand sidebar" title="Expand sidebar (Ctrl+B)" onClick={toggleSidebar}><Icon name="panel" /></button>}
          <div className="workspace-tabs__list" aria-label="Open threads">
            {tabs.map((tab) => <div key={tab.id} className={`workspace-tab ${view !== "threads" && chat.activeId === tab.id ? "workspace-tab--active" : ""}`}>
              <button className="workspace-tab__select" type="button" onClick={() => openThread(tab.projectId, tab.id)} aria-current={view !== "threads" && chat.activeId === tab.id ? "page" : undefined}><Icon name="message" size={14} /><span>{tab.title}</span></button>
              <button className="workspace-tab__close" type="button" aria-label={`Close tab ${tab.title}`} onClick={() => {
                const remaining = tabs.filter(t => t.id !== tab.id);
                setTabs(remaining);
                if (tab.id === chat.activeId) {
                  const next = remaining[remaining.length - 1];
                  if (next) openThread(next.projectId, next.id); else startThread();
                }
              }}><Icon name="close" size={12} /></button>
            </div>)}
            {view === "threads" ? <div className="workspace-tab workspace-tab--active"><span className="workspace-tab__select"><Icon name="threads" size={14} />Threads</span></div>
              : chat.activeId === null && <div className="workspace-tab workspace-tab--active"><span className="workspace-tab__select"><Icon name="sparkles" size={14} />New thread</span></div>}
            <button className="icon-button workspace-tabs__new" type="button" disabled={!firstReady} aria-label="New thread" title="New thread (Ctrl+N)" onClick={startThread}><Icon name="plus" size={14} /></button>
          </div>
          <span className="workspace-tabs__drag" data-tauri-drag-region />
          <WindowControls />
        </header>
        {view === "threads" ? <ThreadLibrary onOpenSession={openThread} onNewThread={startThread} /> : <ChatView onOpenSettings={() => setSettings("agents")} onNewThread={startThread} />}
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} onOpenSession={(projectId, id) => { setSearchOpen(false); openThread(projectId, id); }} />}
      {settings && <SettingsDialog section={settings} onSelect={setSettings} onClose={() => setSettings(null)} />}
    </div>
  );
}
