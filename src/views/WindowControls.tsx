import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Minimise, maximise and close, drawn by the app.
 *
 * The window has no decorations (`tauri.conf.json`), so a native title bar
 * never appears above kitty's own chrome. The strip these sit in carries
 * `data-tauri-drag-region`, which is what makes the window movable; Tauri only
 * treats an event as a drag when the element under the pointer is the region
 * itself, so these buttons still receive their clicks.
 */
export function WindowControls(): React.ReactElement {
  const win = getCurrentWindow();

  return (
    <div className="wincontrols">
      <button
        type="button"
        className="wincontrol"
        aria-label="Minimise"
        onClick={() => void win.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="1" y1="5" x2="9" y2="5" />
        </svg>
      </button>

      <button
        type="button"
        className="wincontrol"
        aria-label="Maximise"
        onClick={() => void win.toggleMaximize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="1.5" y="1.5" width="7" height="7" fill="none" />
        </svg>
      </button>

      <button
        type="button"
        className="wincontrol wincontrol--close"
        aria-label="Close"
        onClick={() => void win.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
          <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
        </svg>
      </button>
    </div>
  );
}
