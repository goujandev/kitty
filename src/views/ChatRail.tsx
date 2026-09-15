import { useEffect, useState } from "react";

import type { SessionRow } from "../ipc/bindings";
import { useDragResize } from "../hooks/useDragResize";
import { useReorder } from "../hooks/useReorder";
import { setRailWidth, useAppearance } from "../stores/appearanceStore";
import { Grip } from "./Grip";
import { RowMenu } from "./RowMenu";
import { clearSearch, search, useProjects } from "../stores/projectStore";
import { Mark } from "./Marks";

/**
 * Every conversation in the chosen project.
 *
 * There are no agent buttons here any more. Which CLI runs a conversation is
 * not a decision on its own -- you pick a model and the vendor comes with it
 * -- so choosing the agent here and the model in the composer was the same
 * question asked in two places, and they could disagree.
 *
 * Typing in the box searches across *all* projects, not just this one: a hit
 * you half remember is rarely in the folder you happen to be looking at. It is
 * an FTS5 index query rather than a scan, so it runs on each keystroke
 * (ADR-0005).
 */
export function ChatRail({
  projectName,
  sessions,
  running,
  activeId,
  draft,
  canStart,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onReorder,
  onOpenAnywhere,
}: {
  projectName: string;
  sessions: SessionRow[];
  /** Ids of conversations with a turn in flight. */
  running: Record<string, string>;
  activeId: string | null;
  /** True when an agent has been chosen but not yet spoken to. */
  draft: boolean;
  /** False when there is no project open, or no agent that could run one. */
  canStart: boolean;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onOpenAnywhere: (projectId: string, sessionId: string) => void;
}): React.ReactElement {
  const { query, results, searching } = useProjects();
  const { rails } = useAppearance();
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const drag = useReorder(sessions, sessionId, onReorder);
  const resize = useDragResize({
    min: 150,
    max: () => Math.min(460, Math.floor(window.innerWidth / 2)),
    defaultWidth: 248,
    initial: rails.chats,
    onCommit: (width) => setRailWidth("chats", width),
  });

  useEffect(() => clearSearch, []);

  const searchingNow = query.trim().length > 0;

  return (
    <aside className="rail rail--chats" ref={resize.setPaneRef}>
      <header className="rail__head" data-tauri-drag-region>
        <h2 className="rail__title">{projectName}</h2>
        <button
          type="button"
          className="chip chip--icon"
          disabled={!canStart}
          title={canStart ? "New conversation" : "Open a project first"}
          aria-label="New conversation"
          onClick={onNewSession}
        >
          <Plus />
        </button>
      </header>

      <div className="rail__tools">
        <input
          className="search"
          value={query}
          placeholder="Search every conversation"
          onChange={(event) => void search(event.target.value)}
        />
      </div>

      {searchingNow ? (
        <Hits results={results} searching={searching} onOpen={onOpenAnywhere} />
      ) : (
        <ul className="rail__list">
          {draft && (
            // Shown so the choice is visible, but it is not a conversation
            // until something is sent.
            <li>
              <span className="entry entry--active">
                <span className="entry__name">New conversation</span>
                <span className="entry__meta">unsent</span>
              </span>
            </li>
          )}
          {drag.items.map((session) => (
            <li
              key={session.id}
              className={drag.dragging === session.id ? "row--lifted" : ""}
              {...drag.rowProps(session.id)}
            >
              <button
                type="button"
                className={`entry ${session.id === activeId ? "entry--active" : ""}`}
                onClick={() => onOpenSession(session.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ id: session.id, x: event.clientX, y: event.clientY });
                }}
              >
                <span className="entry__name">
                  {session.title ?? "Untitled"}
                </span>
                <span className="entry__meta">
                  <Mark harness={session.harness} size={12} />
                  {session.model ?? session.harness}
                </span>
                {session.id in running && <Working />}
              </button>
              {confirming === session.id ? (
                <div className="rail__confirm">
                  <span className="muted">Delete it?</span>
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    className="linkish linkish--danger"
                    onClick={() => {
                      setConfirming(null);
                      onDeleteSession(session.id);
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="entry__remove"
                  title="Delete this conversation"
                  onClick={() => setConfirming(session.id)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {sessions.length === 0 && !draft && (
            <p className="muted rail__empty">Start one with the + above.</p>
          )}
        </ul>
      )}

      {menu && (
        <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            className="rowmenu__item rowmenu__item--danger"
            onClick={() => {
              const { id } = menu;
              setMenu(null);
              onDeleteSession(id);
            }}
          >
            Delete
          </button>
        </RowMenu>
      )}

      <Grip resize={resize} label="Resize the conversations list" />
    </aside>
  );
}

/**
 * A turn is in flight here.
 *
 * A bar rather than a spinner, and along the bottom edge of the row rather
 * than beside the name: it has to be legible at a glance down a list without
 * taking a column away from the title, which is the thing you are reading.
 */
export function Working(): React.ReactElement {
  return <span className="working" aria-label="Working" />;
}

const sessionId = (session: SessionRow): string => session.id;

function Plus(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path
        d="M7 2.6v8.8M2.6 7h8.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Hits({
  results,
  searching,
  onOpen,
}: {
  results: ReturnType<typeof useProjects>["results"];
  searching: boolean;
  onOpen: (projectId: string, sessionId: string) => void;
}): React.ReactElement {
  if (results.length === 0) {
    return (
      <p className="muted rail__empty">
        {searching ? "Searching…" : "Nothing matched."}
      </p>
    );
  }

  return (
    <ul className="rail__list results">
      {results.map((hit) => (
        <li key={`${hit.sessionId}:${hit.seq}`}>
          <button
            type="button"
            className="result"
            onClick={() => onOpen(hit.projectId, hit.sessionId)}
          >
            <span className="result__title">{hit.title ?? "Untitled"}</span>
            <span className="result__snippet">{hit.snippet}</span>
            <span className="result__meta">
              {hit.projectName} · {hit.harness}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
