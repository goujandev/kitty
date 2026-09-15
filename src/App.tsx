import { useEffect, useState } from "react";

import {
  chooseProject,
  listen,
  newSession,
  openByRoot,
  openSession,
  openSessionAnywhere,
  restoreLastProject,
  useChat,
} from "./stores/chatStore";
import { initialise, useHarnessState } from "./stores/harnessStore";
import { ChatRail } from "./views/ChatRail";
import { ChatView } from "./views/ChatView";
import { HarnessList } from "./views/HarnessList";
import { ProjectRail } from "./views/ProjectRail";

/**
 * Three panes, left to right: the folders you work in, the conversations in
 * the chosen folder, and the conversation itself.
 *
 * Nothing is behind a tab. Picking a project and picking a chat are one click
 * each, and both stay on screen while you read the third pane.
 */
export function App(): React.ReactElement {
  const [agents, setAgents] = useState(false);
  const chat = useChat();
  const { scan } = useHarnessState();

  useEffect(() => {
    // Deliberately after first paint. Probing spawns child processes and an
    // npm shim boots Node before it will answer, so doing this during startup
    // would put seconds in front of an empty window (PROTOTYPE-1 criterion 1).
    void initialise();
    void restoreLastProject();

    const unlisten = listen();
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  return (
    <div className="app">
      <ProjectRail
        activeId={chat.project?.id ?? null}
        showingAgents={agents}
        onOpen={(root) => {
          setAgents(false);
          void openByRoot(root);
        }}
        onAdd={() => {
          setAgents(false);
          void chooseProject();
        }}
        onShowAgents={() => setAgents(true)}
      />

      <ChatRail
        projectName={chat.project?.name ?? null}
        sessions={chat.sessions}
        activeId={chat.activeId}
        draft={chat.draft}
        harnesses={scan?.harnesses ?? []}
        onNewSession={(harness) => {
          setAgents(false);
          newSession(harness);
        }}
        onOpenSession={(id) => {
          setAgents(false);
          void openSession(id);
        }}
        onOpenAnywhere={(projectId, sessionId) => {
          setAgents(false);
          void openSessionAnywhere(projectId, sessionId);
        }}
      />

      {agents ? <HarnessList /> : <ChatView />}
    </div>
  );
}
