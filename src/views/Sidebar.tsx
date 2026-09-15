import type { HarnessId, HarnessStatus, SessionRow } from "../ipc/bindings";

/**
 * Project, sessions, and which agents are usable.
 *
 * Kept to a handful of props by taking the data it renders and the callbacks
 * it fires, nothing else. ADR-0006 puts the cap at roughly eight; `MonoCode`'s
 * sidebar takes 76.
 */
export function Sidebar({
  projectName,
  sessions,
  activeId,
  draft,
  harnesses,
  onChooseProject,
  onNewSession,
  onOpenSession,
}: {
  projectName: string | null;
  sessions: SessionRow[];
  activeId: string | null;
  /** An agent chosen but not yet spoken to. */
  draft: HarnessId | null;
  harnesses: HarnessStatus[];
  onChooseProject: () => void;
  onNewSession: (harness: HarnessId) => void;
  onOpenSession: (id: string) => void;
}): React.ReactElement {
  const ready = harnesses.filter((h) => h.ready);

  return (
    <aside className="sidebar">
      <button type="button" className="project" onClick={onChooseProject}>
        <span className="project__name">{projectName ?? "Choose a folder"}</span>
        <span className="project__action">change</span>
      </button>

      <div className="sidebar__section">
        <h2 className="sidebar__heading">New session</h2>
        <div className="starters">
          {harnesses.map((harness) => (
            <button
              key={harness.id}
              type="button"
              className={`starter ${draft === harness.id ? "starter--chosen" : ""}`}
              disabled={!harness.ready || projectName === null}
              title={harness.ready ? harness.label : harness.hint?.message}
              onClick={() => onNewSession(harness.id)}
            >
              {harness.label}
            </button>
          ))}
        </div>
        {ready.length === 0 && (
          <p className="muted sidebar__note">
            No agent is ready. Check the Agents screen for what to do.
          </p>
        )}
      </div>

      <div className="sidebar__section sidebar__section--grow">
        <h2 className="sidebar__heading">Sessions</h2>
        {sessions.length === 0 && draft === null ? (
          <p className="muted sidebar__note">Nothing here yet.</p>
        ) : (
          <ul className="sessions">
            {draft !== null && (
              <li>
                {/* A draft is shown so the choice is visible, but it is not a
                    session until something is sent. */}
                <span className="session session--active session--draft">
                  <span className="session__title">New conversation</span>
                  <span className="session__meta">{draft} · unsent</span>
                </span>
              </li>
            )}
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={`session ${session.id === activeId ? "session--active" : ""}`}
                  onClick={() => onOpenSession(session.id)}
                >
                  <span className="session__title">
                    {session.title ?? "Untitled"}
                  </span>
                  <span className="session__meta">{session.harness}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
