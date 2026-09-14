import { useEffect } from "react";

import { initialise } from "./stores/harnessStore";
import { HarnessList } from "./views/HarnessList";

export function App(): React.ReactElement {
  useEffect(() => {
    // Deliberately after first paint. Probing spawns child processes and an
    // npm shim boots Node before it will answer, so doing this during startup
    // would put seconds in front of an empty window (PROTOTYPE-1 criterion 1).
    void initialise();
  }, []);

  return (
    <main className="app">
      <HarnessList />
      <footer className="app__foot">
        kitty reads your existing logins. It never writes to them.
      </footer>
    </main>
  );
}
