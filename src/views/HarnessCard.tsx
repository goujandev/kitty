import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";

import {
  assertNever,
  formatVersion,
  type HarnessStatus,
  type InstallState,
  type LoginState,
} from "../ipc/bindings";

export function HarnessCard({ status }: { status: HarnessStatus }): React.ReactElement {
  return (
    <article className={`card ${status.ready ? "card--ready" : "card--blocked"}`}>
      <header className="card__head">
        <div>
          <h2 className="card__title">{status.label}</h2>
          <p className="card__vendor">{status.vendor}</p>
        </div>
        <span className={`pill ${status.ready ? "pill--ready" : "pill--blocked"}`}>
          {status.ready ? "ready" : "blocked"}
        </span>
      </header>

      <dl className="facts">
        <dt>Install</dt>
        <dd>{describeInstall(status.install)}</dd>
        <dt>Sign-in</dt>
        <dd>{describeLogin(status.login)}</dd>
      </dl>

      {status.newerThanVerified && (
        <p className="note">
          Newer than the {formatVersion(status.verifiedVersion)} kitty has been tested
          against. It should work; tell us if it does not.
        </p>
      )}

      {status.hint && <HintBlock hint={status.hint} />}
    </article>
  );
}

function HintBlock({
  hint,
}: {
  hint: NonNullable<HarnessStatus["hint"]>;
}): React.ReactElement {
  return (
    <div className="hint">
      <p className="hint__message">{hint.message}</p>
      {hint.command && <CopyableCommand command={hint.command} />}
      {hint.url && (
        <button
          type="button"
          className="linkish"
          onClick={() => {
            void openUrl(hint.url as string);
          }}
        >
          Open documentation
        </button>
      )}
    </div>
  );
}

function CopyableCommand({ command }: { command: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="command"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard
          .writeText(command)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          })
          .catch(() => setCopied(false));
      }}
    >
      <code>{command}</code>
      <span className="command__action">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

function describeInstall(install: InstallState): React.ReactElement {
  switch (install.kind) {
    case "notFound":
      return <span className="muted">Not found</span>;
    case "found":
      return (
        <>
          <strong>{formatVersion(install.version)}</strong>
          <span className="path" title={install.path}>
            {install.path}
          </span>
        </>
      );
    case "unsupportedVersion":
      return (
        <>
          <strong>{formatVersion(install.found)}</strong>
          <span className="muted">
            {" "}
            needs {formatVersion(install.required)} or newer
          </span>
          <span className="path" title={install.path}>
            {install.path}
          </span>
        </>
      );
    case "unidentified":
      return (
        <>
          <span className="muted">Unrecognised</span>
          <span className="path" title={install.path}>
            {install.path}
          </span>
          {install.output && <span className="path">said: {install.output}</span>}
        </>
      );
    case "probeFailed":
      return (
        <>
          <span className="muted">Could not run it</span>
          <span className="path" title={install.path}>
            {install.path}
          </span>
          <span className="path">{install.message}</span>
        </>
      );
    default:
      return assertNever(install, "InstallState");
  }
}

function describeLogin(login: LoginState): React.ReactElement {
  switch (login.kind) {
    case "unknown":
      return <span className="muted">{login.reason}</span>;
    case "loggedOut":
      return <span className="muted">Signed out</span>;
    case "loggedIn":
      return (
        <>
          <strong>Signed in</strong>
          {login.plan && <span className="muted"> on {login.plan}</span>}
          {login.expiresAtMs !== null && (
            <span className="muted"> · token valid {relative(login.expiresAtMs)}</span>
          )}
        </>
      );
    case "expired":
      return (
        <>
          <strong>Expired</strong>
          <span className="muted"> {relative(login.expiredAtMs)}</span>
        </>
      );
    default:
      return assertNever(login, "LoginState");
  }
}

/** "for 2h" / "5d ago". Coarse on purpose; nobody needs seconds here. */
function relative(targetMs: number): string {
  const deltaSeconds = Math.round((targetMs - Date.now()) / 1000);
  const past = deltaSeconds < 0;
  const magnitude = Math.abs(deltaSeconds);

  let amount: string;
  if (magnitude < 90) amount = `${magnitude}s`;
  else if (magnitude < 5400) amount = `${Math.round(magnitude / 60)}m`;
  else if (magnitude < 172800) amount = `${Math.round(magnitude / 3600)}h`;
  else amount = `${Math.round(magnitude / 86400)}d`;

  return past ? `${amount} ago` : `for ${amount}`;
}
