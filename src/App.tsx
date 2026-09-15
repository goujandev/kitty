import { useEffect, useState } from "react";

import { listen, restoreLastProject } from "./stores/chatStore";
import { initialise } from "./stores/harnessStore";
import { ChatView } from "./views/ChatView";
import { HarnessList } from "./views/HarnessList";

type Screen = "chat" | "agents";

export function App(): React.ReactElement {
  const [screen, setScreen] = useState<Screen>("chat");

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
      <nav className="tabs">
        <button
          type="button"
          className={`tab ${screen === "chat" ? "tab--active" : ""}`}
          onClick={() => setScreen("chat")}
        >
          Chat
        </button>
        <button
          type="button"
          className={`tab ${screen === "agents" ? "tab--active" : ""}`}
          onClick={() => setScreen("agents")}
        >
          Agents
        </button>
        <span className="tabs__note">
          kitty reads your existing logins. It never writes to them.
        </span>
      </nav>

      {screen === "chat" ? <ChatView /> : <HarnessList />}
    </div>
  );
}
