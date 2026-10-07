import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";
import "./workspace.css";
import "./t3.css";
import "./sidebar.css";
import "./frame.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing #root");
const mount = root;

function render(): void {
  ReactDOM.createRoot(mount).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// `npm run dev` opened in a plain browser: stand in a pretend host so the real
// interface can be reviewed there. Vite drops this branch from production
// builds, so the preview code never ships.
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  void import("./dev/previewBackend").then(preview => { preview.install(); render(); });
} else {
  render();
}
