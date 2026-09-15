import { useEffect, useState } from "react";

import { refresh, remove, useProjects } from "../stores/projectStore";

/**
 * The folders kitty works in.
 *
 * A project is a folder and nothing else: you pick one, and the agent runs
 * with that as its working directory. There is no project file, no import
 * step, and nothing to configure — which is why this rail is a list and a
 * button rather than a screen.
 */
export function ProjectRail({
  activeId,
  onOpen,
  onAdd,
  onShowAgents,
  showingAgents,
}: {
  activeId: string | null;
  onOpen: (root: string) => void;
  onAdd: () => void;
  onShowAgents: () => void;
  showingAgents: boolean;
}): React.ReactElement {
  const { projects, loading, error } = useProjects();
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <aside className="rail">
      <header className="rail__head" data-tauri-drag-region>
        <h2 className="rail__title">Projects</h2>
        <button
          type="button"
          className="linkish"
          onClick={onAdd}
          title="Open a folder"
        >
          Open
        </button>
      </header>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      <ul className="rail__list">
        {projects.map((project) => (
          <li key={project.id}>
            <button
              type="button"
              className={[
                "entry",
                project.id === activeId && !showingAgents ? "entry--active" : "",
                project.exists ? "" : "entry--missing",
              ]
                .filter(Boolean)
                .join(" ")}
              title={project.root}
              disabled={!project.exists}
              onClick={() => onOpen(project.root)}
            >
              <span className="entry__name">{project.name}</span>
              <span className="entry__meta">
                {project.exists
                  ? `${project.sessionCount} ${
                      project.sessionCount === 1 ? "chat" : "chats"
                    }`
                  : "folder is gone"}
              </span>
            </button>
            {confirming === project.id ? (
              <div className="rail__confirm">
                <span className="muted">Forget it?</span>
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
                    void remove(project.id);
                  }}
                >
                  Forget
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="entry__remove"
                title="Forget this project and its conversations"
                onClick={() => setConfirming(project.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}

        {!loading && projects.length === 0 && (
          <p className="muted rail__empty">
            Open a folder to start working in it.
          </p>
        )}
      </ul>

      <div className="rail__foot">
        {/* The promise in ADR-0004, kept where it is always readable rather
            than in a header strip that truncates. */}
        <p className="muted rail__promise">
          kitty reads your existing logins. It never writes to them.
        </p>
        <button
          type="button"
          className={`entry ${showingAgents ? "entry--active" : ""}`}
          onClick={onShowAgents}
        >
          <span className="entry__name">Agents</span>
          <span className="entry__meta">what kitty can run</span>
        </button>
      </div>
    </aside>
  );
}
