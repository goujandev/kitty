import { updates, useUpdates } from "../stores/updateStore";
import { useChat } from "../stores/chatStore";

const megabytes = (bytes: number): string => (bytes / 1_048_576).toFixed(1) + " MB";
export function UpdateSettings(): React.ReactElement {
  const state = useUpdates();
  const chat = useChat();
  const running = Object.keys(chat.running).length > 0;
  const busy = ["checking", "downloading", "installing"].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  const status = {
    idle: "Check for a newer published release of Kitty.",
    checking: "Checking for updates...",
    current: "You're running the latest version of Kitty.",
    available: "Kitty " + state.version + " is available.",
    downloading: "Downloading Kitty " + state.version + "...",
    ready: "Kitty " + state.version + " is downloaded and ready to install.",
    installing: "Starting the installer. Kitty will close and restart after installation.",
    installed: "Installation has started. If Kitty does not restart automatically, reopen it from the Start menu.",
    unavailable: "Updates are available in the installed Windows app.",
  }[state.phase];
  return <div className="settings"><div className="settings__inner">
    <h2 className="settings__heading">App updates</h2>
    <div className="settings__row">
      <div className="settings__label">
        <span className="settings__name">Kitty{state.currentVersion ? " " + state.currentVersion : ""}</span>
        <span className="settings__blurb">Kitty checks GitHub Releases when it starts. You choose when to download and install an update.</span>
      </div>
      <div className="settings__control"><button type="button" className="button"
        disabled={busy || ["unavailable", "ready", "installed"].includes(state.phase)}
        onClick={() => void updates.check()}>{state.phase === "checking" ? "Checking..." : "Check for updates"}</button></div>
    </div>
    <div className="update-status" role="status" aria-live="polite" aria-atomic="true">
      <p>{status}</p>
      {state.checkedAt && <p className="settings__blurb">Last checked {new Date(state.checkedAt).toLocaleString()}.</p>}
    </div>
    {state.error && <p className="banner banner--error" role="alert">{state.error}</p>}
    {state.phase === "downloading" && <div className="update-progress">
      <progress aria-label="Update download progress" max={100} value={percent ?? undefined} />
      <span>{percent === null ? megabytes(state.downloaded) + " downloaded" : percent + "% - " + megabytes(state.downloaded) + " / " + megabytes(state.total!)}</span>
    </div>}
    {state.phase === "available" && <button type="button" className="button" onClick={() => void updates.download()}>Download update</button>}
    {state.phase === "ready" && <div className="update-restart">
      <p className="settings__blurb">Restart to install this update. Kitty will close, and the installer will reopen it when finished. Save anything you need from unsent drafts first.</p>
      {running && <p className="settings__blurb">Wait for running conversations to finish before restarting.</p>}
      <button type="button" className="button" disabled={running} onClick={() => void updates.install(Object.keys(chat.running).length > 0)}>Restart and install</button>
    </div>}
    {state.notes && <details className="update-notes"><summary>Release notes</summary><p>{state.notes}</p></details>}
  </div></div>;
}
