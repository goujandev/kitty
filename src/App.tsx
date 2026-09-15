import { useEffect, useState } from "react";

import {
  chooseProject,
  listen,
  newChat,
  newSession,
  openById,
  openSession,
  openSessionAnywhere,
  removeSession,
  reorderSessions,
  loadDefaultChoice,
  restoreLastProject,
  useChat,
} from "./stores/chatStore";
import { loadAppearance, nudgeZoom } from "./stores/appearanceStore";
import { initialise, useHarnessState } from "./stores/harnessStore";
import { ChatRail } from "./views/ChatRail";
import { ChatView } from "./views/ChatView";
import { ProjectRail } from "./views/ProjectRail";
import { SettingsRail, SettingsView, type Section } from "./views/Settings";

/**
 * Three panes, left to right: the things you work on, the conversations in the
 * chosen one, and the conversation itself.
 *
 * Nothing is behind a tab. Picking a project and picking a chat are one click
 * each, and both stay on screen while you read the third pane. The middle pane
 * goes away for a project with no folder, which is a single conversation and
 * so has nothing for that pane to list.
 */
export function App(): React.ReactElement {
  // Null means the conversation is on screen; a section means settings is.
  const [settings, setSettings] = useState<Section | null>(null);
  const chat = useChat();
  const { scan } = useHarnessState();
  // The middle rail lists the conversations in a folder, so it only exists
  // when there is a folder. A chat with no folder holds exactly one
  // conversation and nothing else is open at all -- in both cases the rail's
  // only possible content is an apology for being empty.
  const inFolder = chat.project?.root != null;
  const firstReady = (scan?.harnesses ?? []).find((h) => h.ready)?.id;

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
    <div className={`app ${!inFolder && !settings ? "app--solo" : ""}`}>
      <ProjectRail
        activeId={chat.project?.id ?? null}
        canChat={firstReady !== undefined}
        inSettings={settings !== null}
        onOpen={(projectId) => {
          setSettings(null);
          void openById(projectId);
        }}
        onAdd={() => {
          setSettings(null);
          void chooseProject();
        }}
        onNewChat={() => {
          setSettings(null);
          void newChat();
        }}
        onOpenSettings={() => setSettings("appearance")}
      />

      {settings ? (
        <SettingsRail
          section={settings}
          onSelect={setSettings}
          onClose={() => setSettings(null)}
        />
      ) : inFolder ? (
        <ChatRail
          projectName={chat.project?.name ?? ""}
          sessions={chat.sessions}
          running={chat.running}
          activeId={chat.activeId}
          draft={chat.draft !== null}
          canStart={chat.project !== null && firstReady !== undefined}
          onNewSession={newSession}
          onOpenSession={(id) => void openSession(id)}
          onDeleteSession={(id) => void removeSession(id)}
          onReorder={(ids) => void reorderSessions(ids)}
          onOpenAnywhere={(projectId, sessionId) =>
            void openSessionAnywhere(projectId, sessionId)
          }
        />
      ) : null}

      {settings ? <SettingsView section={settings} /> : <ChatView />}
    </div>
  );
}
