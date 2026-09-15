import { useEffect } from "react";

import type { HarnessId, HarnessStatus, SessionRow } from "../ipc/bindings";
import { clearSearch, search, useProjects } from "../stores/projectStore";
import { Mark } from "./Marks";

/**
 * Every conversation in the chosen project.
 *
 * Typing in the box searches across *all* projects, not just this one: a hit
 * you half remember is rarely in the folder you happen to be looking at. It is
 * an FTS5 index query rather than a scan, so it runs on each keystroke
 * (ADR-0005).
 */
export function ChatRail({
  projectName,
  sessions,
  activeId,
  draft,
  harnesses,
  onNewSession,
  onOpenSession,
  onOpenAnywhere,
}: {
  projectName: string | null;
  sessions: SessionRow[];
  activeId: string | null;
  /** An agent chosen but not yet spoken to. */
  draft: HarnessId | null;
  harnesses: HarnessStatus[];
  onNewSession: (harness: HarnessId) => void;
  onOpenSession: (id: string) => void;
  onOpenAnywhere: (projectId: string, sessionId: string) => void;
}): React.ReactElement {
  const { query, results, searching } = useProjects();

  useEffect(() => clearSearch, []);

  const searchingNow = query.trim().length > 0;

  return (
    <aside className="rail rail--chats">
      <header className="rail__head" data-tauri-drag-region>
        <h2 className="rail__title">{projectName ?? "No project"}</h2>
      </header>

      <div className="rail__tools">
        <input
          className="search"
          value={query}
          placeholder="Search every conversation"
          onChange={(event) => void search(event.target.value)}
        />
        {!searchingNow && (
          <div className="starters">
            {harnesses.map((harness) => (
              <button
                key={harness.id}
                type="button"
                className={`starter ${draft === harness.id ? "starter--chosen" : ""}`}
                disabled={!harness.ready || projectName === null}
                title={
                  harness.ready
                    ? `New conversation with ${harness.label}`
                    : harness.hint?.message
                }
                onClick={() => onNewSession(harness.id)}
              >
                <Mark harness={harness.id} size={16} />
                <span>{harness.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {searchingNow ? (
        <Hits
          results={results}
          searching={searching}
          onOpen={onOpenAnywhere}
        />
      ) : (
        <ul className="rail__list">
          {draft !== null && (
            // Shown so the choice is visible, but it is not a conversation
            // until something is sent.
            <li>
              <span className="entry entry--active">
                <span className="entry__name">New conversation</span>
                <span className="entry__meta">{draft} · unsent</span>
              </span>
            </li>
          )}
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                className={`entry ${session.id === activeId ? "entry--active" : ""}`}
                onClick={() => onOpenSession(session.id)}
              >
                <span className="entry__name">
                  {session.title ?? "Untitled"}
                </span>
                <span className="entry__meta">{session.harness}</span>
              </button>
            </li>
          ))}
          {sessions.length === 0 && draft === null && (
            <p className="muted rail__empty">
              {projectName === null
                ? "Pick a project on the left."
                : "Start one with an agent above."}
            </p>
          )}
        </ul>
      )}
    </aside>
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
