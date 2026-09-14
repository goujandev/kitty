import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri drives this dev server, so the port is fixed and failure to bind is an
// error rather than something to silently work around.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // The Rust side has its own watcher; this one should ignore it.
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**"],
    },
  },
  build: {
    target: "chrome120",
    sourcemap: true,
  },
});
