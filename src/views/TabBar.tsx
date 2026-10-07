import { useEffect, useRef, useState } from "react";
import { modelLabel, newSession, openSession, renameChat, useChat } from "../stores/chatStore";
import { close, DRAFT, prune, reveal, updateTabs, useTabs } from "../stores/tabStore";
import { Icon } from "./Icon";
import { InlineRename } from "./InlineRename";
import { ProviderMark } from "./Marks";
import { chatTitle } from "./WorkspaceSidebar";

/**
 * The open chats of the current project, as tabs in the title bar.
 *
 * Lets someone who keeps the sidebar closed still move between chats. A tab
 * follows whatever is open -- picked in the sidebar, found by search, or just
 * created -- and closing one never touches the chat itself.
 */
export function TabBar({ onNewChat, renameActive, onRenameDone }: {
  onNewChat: () => void;
  /** Set by F2 or the sidebar: rename the active tab in place. */
  renameActive: boolean;
  onRenameDone: () => void;
}): React.ReactElement | null {
  const chat = useChat();
  const projectId = chat.project?.id ?? null;
  const tabs = useTabs(projectId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const current = chat.activeId ?? (chat.draft !== null ? DRAFT : null);

  // Whatever is open is a tab, and the active one.
  useEffect(() => {
    if (projectId && current) updateTabs(projectId, tabs => reveal(tabs, current));
  }, [projectId, current]);

  // Chats deleted or archived elsewhere close their tabs.
  useEffect(() => {
    if (!projectId || chat.loading) return;
    const valid = new Set(chat.sessions.filter(row => !row.archivedAt).map(row => row.id));
    if (chat.activeId) valid.add(chat.activeId);
    updateTabs(projectId, tabs => prune(tabs, valid));
  }, [projectId, chat.sessions, chat.activeId, chat.loading]);

  useEffect(() => { if (renameActive && chat.activeId) setRenaming(chat.activeId); }, [renameActive, chat.activeId]);

  // Keep the active tab in view when there are more than fit.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>(".tab.is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tabs.active]);

  if (!projectId) return null;

  const select = (id: string) => {
    if (id === DRAFT) newSession();
    else if (id !== chat.activeId) void openSession(id);
  };
  const closeTab = (id: string) => {
    const next = close(tabs, id);
    updateTabs(projectId, () => next);
    if (tabs.active !== id) return;
    if (next.active) { select(next.active); return; }
    // Never an empty strip: the last tab closing leaves a fresh new chat.
    updateTabs(projectId, tabs => reveal(tabs, DRAFT));
    newSession();
  };

  return <div className="tabbar" ref={strip} role="tablist" aria-label="Open chats" onWheel={event => {
    // A vertical wheel scrolls the strip sideways, as in a browser.
    if (event.deltaY && strip.current) strip.current.scrollLeft += event.deltaY;
  }}>
    {tabs.ids.map(id => {
      const row = id === DRAFT ? null : chat.sessions.find(session => session.id === id);
      if (id !== DRAFT && !row) return null;
      const active = tabs.active === id;
      const title = row ? chatTitle(row) : "New chat";
      const working = row ? row.id in chat.running : false;
      const waiting = row ? row.id in chat.waiting : false;
      return <div key={id} className={`tab${active ? " is-active" : ""}`} data-tab-id={id}>
        {renaming === id && row
          ? <InlineRename initial={title} what="chat" label="Rename chat" className="tab__rename"
              onSave={name => void renameChat(row.projectId, row.id, name)}
              onDone={() => { setRenaming(null); onRenameDone(); }} />
          : <button type="button" role="tab" aria-selected={active} className="tab__open"
              title={row ? `${title}\n${modelLabel(row)} · double-click to rename` : "New chat"}
              onClick={() => select(id)}
              onDoubleClick={() => { if (row) setRenaming(id); }}
              onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closeTab(id); } }}>
              {row ? <ProviderMark harness={row.harness} size={14} brand /> : <Icon name="squarePen" size={14} />}
              <span className="tab__title">{title}</span>
              {waiting ? <span className="tab__state tab__state--waiting" role="img" aria-label="Needs approval"><Icon name="clock" size={12} /></span>
                : working && <span className="tab__state project-activity__working" role="img" aria-label="Working" />}
            </button>}
        <button type="button" className="tab__close" aria-label={`Close ${title}`} title="Close tab (Ctrl+W)" onClick={() => closeTab(id)}>
          <Icon name="close" size={12} />
        </button>
      </div>;
    })}
    <button type="button" className="tabbar__new" aria-label="New chat" title="New chat (Ctrl+N)" aria-keyshortcuts="Control+N" onClick={onNewChat}>
      <Icon name="plus" size={16} />
    </button>
  </div>;
}

/** Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab, for App's key handler. */
export { cycle as cycleTabs } from "../stores/tabStore";
