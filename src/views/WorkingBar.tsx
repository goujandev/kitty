import { useEffect, useMemo, useState } from "react";

import { toolMeta, type Block } from "../ipc/bindings";
import { formatElapsed, workedFor, type TurnTiming } from "./activity";

/**
 * Whether the agent is working, said where you are already looking.
 *
 * It sits directly above the box you type into rather than at the top of the
 * turn, so however long the reply grows it never scrolls out of sight. It is
 * there exactly while a turn is running and gone the moment it ends: the
 * window has one answer to "is it still going?", and this is it.
 */
export function WorkingBar({ blocks, timings, startedAt, status, waiting }: {
  blocks: Block[];
  timings: Record<number, TurnTiming>;
  /** When Send was pressed, before the turn has a number of its own. */
  startedAt: number | null;
  status: string | null;
  waiting: boolean;
}): React.ReactElement {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { timing, doing } = useMemo(() => {
    let user: Block | undefined;
    let running: Block | undefined;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i]!;
      if (block.kind === "user") { user = block; break; }
      if (!running && block.kind === "tool" && toolMeta(block).status === "running") running = block;
    }
    return { timing: user ? timings[user.seq] : undefined, doing: running?.text };
  }, [blocks, timings]);

  const elapsed = workedFor(timing, now) ?? (startedAt !== null ? now - startedAt : null);
  const label = waiting ? "Waiting for your approval" : "Working";
  const detail = waiting ? "Answer the request above to continue." : status ?? doing ?? "Thinking…";

  return <div className={`working-bar${waiting ? " working-bar--waiting" : ""}`}>
    <span className="working-bar__spinner" aria-hidden="true" />
    {/* Announced when it changes, not every second. */}
    <span className="working-bar__label" role="status">{label}</span>
    {elapsed !== null && <span className="working-bar__time" aria-hidden="true">{formatElapsed(elapsed)}</span>}
    <span className="working-bar__detail" title={detail}>{detail}</span>
  </div>;
}
