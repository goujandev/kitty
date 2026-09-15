import { useEffect, useState } from "react";

import type { HarnessId, RateLimitWindow } from "../ipc/bindings";
import { Mark } from "./Marks";

/**
 * How much of each usage window is gone, and how long until it comes back.
 *
 * Both vendors volunteer this on their normal stream — Claude as
 * `rate_limit_event`, Codex as `account/rateLimits/updated` — so kitty never
 * reads a credential file to show it (ADR-0004).
 *
 * A bar rather than a number alone because the question being asked is "how
 * much room is left", which is a proportion; the number is there for when you
 * want to be precise about it. Windows the vendor did not report are simply
 * absent: an empty bar would claim knowledge kitty does not have.
 */
export function Usage({
  harness,
  limits,
}: {
  harness: HarnessId | null;
  limits: RateLimitWindow[];
}): React.ReactElement | null {
  // The countdown is derived from a fixed timestamp, so without a nudge it
  // would still read "37m" an hour later. Once a minute is as often as a
  // minute-precision value can change.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  if (limits.length === 0) return null;

  // Shortest window first, so the one most likely to bite is read first.
  const ordered = [...limits].sort((a, b) => minutes(a.label) - minutes(b.label));

  return (
    <div className="usage">
      {harness && <Mark harness={harness} size={13} />}
      {ordered.map((window, index) => (
        <span className="usage__window" key={window.label}>
          {index > 0 && <span className="usage__sep">·</span>}
          <Meter window={window} />
        </span>
      ))}
    </div>
  );
}

function Meter({ window }: { window: RateLimitWindow }): React.ReactElement {
  const used = Math.min(1, Math.max(0, window.utilization));
  const percent = Math.round(used * 100);
  const reset = untilReset(window.resetsAtMs);

  return (
    <span
      className="usage__meter"
      title={[
        `${window.label} window, ${percent}% used`,
        window.resetsAtMs ? `resets ${new Date(window.resetsAtMs).toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join(" — ")}
    >
      <span className="usage__bar">
        <span
          className={`usage__fill usage__fill--${pressure(used)}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="usage__pct">{percent}%</span>
      {reset && <span className="usage__reset">{reset}</span>}
    </span>
  );
}

/**
 * How worried to look.
 *
 * Only changes colour when it is worth changing behaviour over. A bar that is
 * amber from 40% has said nothing by the time it matters.
 */
function pressure(used: number): "calm" | "warm" | "hot" {
  if (used >= 0.9) return "hot";
  if (used >= 0.75) return "warm";
  return "calm";
}

/** Sort key. Unknown labels sort last rather than pretending to a duration. */
function minutes(label: string): number {
  const match = /^(\d+)([mhd])$/.exec(label);
  if (!match) return Number.MAX_SAFE_INTEGER;
  const value = Number(match[1]);
  if (match[2] === "h") return value * 60;
  if (match[2] === "d") return value * 60 * 24;
  return value;
}

/**
 * Time left, at the coarsest useful precision: `37m`, `14h 47m`, `3d 2h`.
 *
 * Seconds are never shown. Nothing about a quota window is worth watching tick
 * down, and a value that changes every second is a value you stop reading.
 */
function untilReset(at: number | null): string | null {
  if (at === null) return null;

  const left = Math.round((at - Date.now()) / 60000);
  if (left <= 0) return "now";
  if (left < 60) return `${left}m`;

  const hours = Math.floor(left / 60);
  const mins = left % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const spare = hours % 24;
  return spare > 0 ? `${days}d ${spare}h` : `${days}d`;
}
