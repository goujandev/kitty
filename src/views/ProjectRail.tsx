import { useEffect, useState } from "react";

import type { ProjectSummary } from "../ipc/bindings";
import { useDragResize } from "../hooks/useDragResize";
import { useReorder } from "../hooks/useReorder";
import { setRailWidth, useAppearance } from "../stores/appearanceStore";
import { Working } from "./ChatRail";
import { Grip } from "./Grip";
import { RowMenu } from "./RowMenu";
import { forgetProject, useChat } from "../stores/chatStore";
import { refresh, reorder, useProjects } from "../stores/projectStore";

/**
 * The things kitty works on.
 *
 * Two kinds of row, and the difference is one column in the database. A
 * project with a folder is a codebase: the agent runs in it, reads it, and the
 * rail beside this one lists the conversations you have had about it. A
 * project without one is a single conversation and nothing else -- no
 * codebase, so no context you did not type, and no second rail because there
 * is nothing to list.
 *
 * That second kind exists because the alternative is worse. Asking a question
 * that has nothing to do with your code should not mean opening a codebase and
 * paying for its context to answer it, and it should not mean leaving for
 * another app either.
 */
export function ProjectRail({
  activeId,
  canChat,
  onOpen,
  onAdd,
  onNewChat,
  onOpenSettings,
  inSettings,
}: {
  activeId: string | null;
  /** False when no agent is installed and signed in to run one. */
  canChat: boolean;
  onOpen: (projectId: string) => void;
  onAdd: () => void;
  onNewChat: () => void;
  onOpenSettings: () => void;
  inSettings: boolean;
}): React.ReactElement {
  const { projects, loading, error } = useProjects();
  const { running } = useChat();
  const { rails } = useAppearance();
  // A project is working if anything inside it is.
  const busyProjects = new Set(Object.values(running));
  const drag = useReorder(projects, projectId, reorder);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const resize = useDragResize({
    min: 150,
    // Never past half the window, whatever the saved value says: a rail wide
    // enough to hide the conversation is a rail you cannot get back from.
    max: () => Math.min(460, Math.floor(window.innerWidth / 2)),
    defaultWidth: 198,
    initial: rails.projects,
    onCommit: (width) => setRailWidth("projects", width),
  });

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <aside className="rail" ref={resize.setPaneRef}>
      <header className="rail__head" data-tauri-drag-region>
        <h2 className="rail__title">Projects</h2>
      </header>

      {/* Two rows rather than one that opens a menu. Asking a quick question
          is the fastest thing you do in the app and it should stay that way:
          putting a picker in front of it turns one click into three, and the
          folder picker in that menu belonged to the other choice anyway. */}
      <div className="rail__new">
        <button
          type="button"
          className="entry entry--slim"
          disabled={!canChat}
          title={canChat ? "Ask something, with no codebase attached" : "No agent is ready to run one"}
          onClick={onNewChat}
        >
          <span className="pmark pmark--plain">
            <Compose />
          </span>
          <span className="entry__name">New chat</span>
        </button>

        <button
          type="button"
          className="entry entry--slim"
          title="Open a folder to work in"
          onClick={onAdd}
        >
          <span className="pmark pmark--plain">
            <Folder />
          </span>
          <span className="entry__name">New project</span>
        </button>
      </div>

      {error && (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      )}

      <ul className="rail__list">
        {drag.items.map((project) => (
          <li
            key={project.id}
            className={drag.dragging === project.id ? "row--lifted" : ""}
            {...drag.rowProps(project.id)}
          >
            <button
              type="button"
              className={[
                "entry",
                "entry--slim",
                project.id === activeId && !inSettings ? "entry--active" : "",
                project.exists ? "" : "entry--missing",
              ]
                .filter(Boolean)
                .join(" ")}
              title={project.root ?? "No folder — this chat has no codebase"}
              disabled={!project.exists}
              onClick={() => onOpen(project.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ id: project.id, x: event.clientX, y: event.clientY });
              }}
            >
              <ProjectMark project={project} />
              <span className="entry__name">{project.name}</span>
              {busyProjects.has(project.id) && <Working />}
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
                    void forgetProject(project.id);
                  }}
                >
                  Forget
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="entry__remove"
                title={
                  project.root
                    ? "Forget this project and its conversations"
                    : "Delete this chat"
                }
                onClick={() => setConfirming(project.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}

        {!loading && drag.items.length === 0 && (
          <p className="muted rail__empty">
            Start a chat, or open a folder to work in it.
          </p>
        )}
      </ul>

      <div className="rail__foot">
        <button
          type="button"
          className={`entry entry--slim ${inSettings ? "entry--active" : ""}`}
          onClick={onOpenSettings}
        >
          <span className="pmark pmark--plain">
            <Gear />
          </span>
          <span className="entry__name">Settings</span>
        </button>
      </div>

      {menu && (
        <RowMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            type="button"
            className="rowmenu__item rowmenu__item--danger"
            onClick={() => {
              const { id } = menu;
              setMenu(null);
              void forgetProject(id);
            }}
          >
            Delete
          </button>
        </RowMenu>
      )}

      <Grip resize={resize} label="Resize the projects list" />
    </aside>
  );
}

const projectId = (project: ProjectSummary): string => project.id;

/**
 * The tints a project's initial can land on.
 *
 * Kept as triplets rather than hex so the tile can be built out of one colour
 * at two strengths -- a wash behind, the full thing in front -- without asking
 * the browser to take a hex string apart.
 */
const TINTS: [number, number, number][] = [
  [224, 114, 74],
  [212, 161, 60],
  [95, 168, 95],
  [74, 144, 217],
  [138, 111, 212],
  [212, 95, 154],
  [63, 169, 160],
];

/**
 * A mark for each row, so the rail can be read by shape at a glance.
 *
 * Assigned from the project's id rather than its name: a rename should not
 * repaint the icon, and the id never changes. There is no attempt to find a
 * real logo -- a folder on disk does not have one, and guessing produces a
 * rail of wrong answers.
 */
function ProjectMark({
  project,
}: {
  project: ProjectSummary;
}): React.ReactElement {
  // No folder, no initial worth showing: these are named after whatever was
  // asked first, which changes, and the useful thing to know at a glance is
  // that this one has nothing behind it.
  if (project.root === null) {
    return (
      <span className="pmark pmark--plain">
        <Bubble />
      </span>
    );
  }

  let hash = 0;
  for (const character of project.id) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const [r, g, b] = TINTS[hash % TINTS.length] ?? [128, 128, 128];

  return (
    <span
      className="pmark"
      style={{
        background: `rgba(${r}, ${g}, ${b}, 0.16)`,
        color: `rgb(${r}, ${g}, ${b})`,
      }}
      aria-hidden="true"
    >
      {project.name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

function Compose(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M9.1 3.2H3.6a1.1 1.1 0 0 0-1.1 1.1v8.1a1.1 1.1 0 0 0 1.1 1.1h8.1a1.1 1.1 0 0 0 1.1-1.1V6.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="m11.3 2.3 2.1 2.1-4.6 4.6-2.6.5.5-2.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Folder(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M1.9 4.2a1 1 0 0 1 1-1h2.7l1.3 1.5h5.2a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1h-9.2a1 1 0 0 1-1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Bubble(): React.ReactElement {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M13.4 8.4c0 2.5-2.4 4.5-5.4 4.5a6.6 6.6 0 0 1-1.7-.2l-3 1.1.9-2.3A4.3 4.3 0 0 1 2.6 8.4c0-2.5 2.4-4.5 5.4-4.5s5.4 2 5.4 4.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Gear(): React.ReactElement {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <circle
        cx="8"
        cy="8"
        r="2.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
