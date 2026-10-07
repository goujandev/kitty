import { useEffect, useState } from "react";
import { chooseProject, listen, loadDefaultChoice, newSession, newSessionInProject, openById, openSession, openSessionAnywhere, restoreLastProject, useChat } from "./stores/chatStore";
import { loadAppearance, nudgeZoom } from "./stores/appearanceStore";
import { initialise, useHarnessState } from "./stores/harnessStore";
import { WorkspaceSidebar } from "./views/WorkspaceSidebar";
import { ChatView } from "./views/ChatView";
import { SearchDialog } from "./views/SearchDialog";
import { SettingsDialog, type Section } from "./views/Settings";
import { WindowControls } from "./views/WindowControls";
import { Icon, PantheonMark } from "./views/Icon";
import { ProjectChooser } from "./views/ProjectChooser";
import { TabBar, cycleTabs } from "./views/TabBar";
import { DRAFT, tabsFor } from "./stores/tabStore";
import { NoticeHost } from "./views/NoticeHost";
import { focusChooser } from "./views/focus";
import { initialiseUpdates } from "./stores/updateStore";
import { useAppearance } from "./stores/appearanceStore";
import { useWallpaperPalette } from "./views/Wallpaper";

/** Whether a key press belongs to a text field rather than the app. */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function App(): React.ReactElement {
  const [settings, setSettings] = useState<Section | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [narrowExpanded, setNarrowExpanded] = useState(false);
  const sidebarCollapsed = narrow ? !narrowExpanded : collapsed;
  const toggleSidebar = () => { if (narrow) setNarrowExpanded(value => !value); else setCollapsed(value => !value); };
  const chat = useChat();
  const { background } = useAppearance();
  useWallpaperPalette(background);
  const { scan } = useHarnessState();
  const canStart = (scan?.harnesses ?? []).some(harness => harness.ready);
  const active = chat.draft === null ? chat.sessions.find(session => session.id === chat.activeId) ?? null : null;
  /** New chat: a draft in the open project, or the project chooser when none is open. */
  const startChat = (projectId?: string) => {
    setNarrowExpanded(false);
    if (!canStart) { setSettings("agents"); return; }
    if (projectId && projectId !== chat.project?.id) void newSessionInProject(projectId);
    else if (chat.project) newSession();
    else focusChooser();
  };
  const addProject = () => { setNarrowExpanded(false); void chooseProject(); };
  useEffect(() => { setDetailsOpen(false); setRenamingTitle(false); }, [chat.project?.id]);
  useEffect(() => setRenamingTitle(false), [chat.activeId]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    void initialise().then(() => loadDefaultChoice()).then(restoreLastProject);
    void loadAppearance();
    initialiseUpdates();
    const subscription = listen();
    return () => { void subscription.then(stop => stop()); };
  }, []);
  // The agent scan is slow -- it starts each CLI -- so a project restored at
  // launch can open before anything is known to run a conversation. Give its
  // empty draft an agent the moment the scan lands.
  useEffect(() => {
    if (!chat.project || chat.loading || chat.activeId !== null || chat.draft !== null || !canStart) return;
    newSession();
  }, [chat.project, chat.loading, chat.activeId, chat.draft, canStart]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && narrowExpanded) { event.preventDefault(); setNarrowExpanded(false); return; }
      if (event.key === "F2" && !typing(event.target) && active) { event.preventDefault(); setRenamingTitle(true); return; }
      // Tabs: Ctrl+Tab / Ctrl+Shift+Tab move between them, Ctrl+W closes one.
      if (event.ctrlKey && event.key === "Tab" && chat.project) {
        event.preventDefault();
        const next = cycleTabs(tabsFor(chat.project.id), event.shiftKey ? -1 : 1);
        if (next === DRAFT) newSession(); else if (next && next !== chat.activeId) void openSession(next);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "w" && chat.project) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".tab.is-active .tab__close")?.click();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const letter = event.key.toLowerCase();
      if (letter === "k") { event.preventDefault(); setSearchOpen(true); }
      if (letter === "n" && !event.shiftKey) { event.preventDefault(); startChat(); }
      if (letter === "o" && !event.shiftKey) { event.preventDefault(); addProject(); }
      if (letter === "b") { event.preventDefault(); toggleSidebar(); }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); void nudgeZoom(1); }
      if (event.key === "-") { event.preventDefault(); void nudgeZoom(-1); }
      if (event.key === "0") { event.preventDefault(); void nudgeZoom(0); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return <div className={`workspace${sidebarCollapsed ? " workspace--collapsed" : ""}${narrow && narrowExpanded ? " workspace--sidebar-overlay" : ""}`}>
    <WorkspaceSidebar collapsed={sidebarCollapsed} onToggleCollapse={toggleSidebar}
      onSelectProject={id => { void openById(id); setNarrowExpanded(false); }}
      onOpenSession={(projectId, sessionId) => { void openSessionAnywhere(projectId, sessionId); setNarrowExpanded(false); }}
      onNewChat={startChat}
      onAddProject={addProject}
      onSearch={() => { setSearchOpen(true); setNarrowExpanded(false); }}
      onSettings={() => { setSettings("appearance"); setNarrowExpanded(false); }} />
    {narrow && narrowExpanded && <button type="button" className="ws-project-backdrop" aria-label="Close sidebar" onClick={() => setNarrowExpanded(false)} />}
    <div className="workspace__main">
      <header className="workspace-tabs" data-tauri-drag-region>
        {sidebarCollapsed && <button type="button" className="icon-button workspace-tabs__sidebar" aria-label="Show sidebar" title="Show sidebar (Ctrl+B)" aria-keyshortcuts="Control+B" onClick={toggleSidebar}><Icon name="panel" size={16} /></button>}
        {chat.project?.root
          ? <TabBar onNewChat={() => startChat()} renameActive={renamingTitle} onRenameDone={() => setRenamingTitle(false)} />
          : <strong className="workspace-title workspace-title--static"><PantheonMark size={24} />Pantheon</strong>}
        <span className="workspace-tabs__drag" data-tauri-drag-region />
        {chat.project?.root && <>
          <button type="button" className={`icon-button${detailsOpen ? " is-active" : ""}`} aria-label="Chat details" aria-expanded={detailsOpen} title="Chat details" onClick={() => setDetailsOpen(value => !value)}><Icon name="panelRight" size={16} /></button>
        </>}
        <WindowControls />
      </header>
      {chat.project?.root
        ? <ChatView key={chat.project.id} detailsOpen={detailsOpen} onCloseDetails={() => setDetailsOpen(false)} onSwitchProject={id => startChat(id)} />
        : <ProjectChooser onNewProject={addProject} onStartIn={id => startChat(id)} />}
      <NoticeHost />
    </div>
    {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} onOpenSession={(projectId, sessionId) => { setSearchOpen(false); void openSessionAnywhere(projectId, sessionId); }} />}
    {settings && <SettingsDialog section={settings} onSelect={setSettings} onClose={() => setSettings(null)} />}
  </div>;
}
