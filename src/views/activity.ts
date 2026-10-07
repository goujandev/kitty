import type { Block } from "../ipc/bindings";

/** Older saved recovery diagnostics are history notes, not current failures. */
export function savedContextNote(title: string, detail: string | null): string | null {
  return title === "Agent error" && detail !== null && /^no rollout found for thread id [a-zA-Z0-9-]+$/.test(detail.trim())
    ? "An earlier agent context was unavailable. Your saved chat history is kept."
    : null;
}

export interface TurnTiming {
  startedAt: number;
  endedAt?: number;
  outcome?: "worked" | "stopped" | "failed";
}

export interface Activity {
  blocks: Block[];
  active: boolean;
  startedAt: number;
  timing?: TurnTiming;
}

export interface DisplayBlock extends Block { activity?: Activity }

/** Keep the final assistant reply outside the expandable work history. */
export function groupActivity(blocks: Block[], busy: boolean, timings: Record<number, TurnTiming>): DisplayBlock[] {
  const rows: DisplayBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    const first = blocks[index]!;
    if (first.kind !== "user") { rows.push(first); index++; continue; }
    rows.push(first);
    const start = ++index;
    while (index < blocks.length && blocks[index]!.kind !== "user") index++;
    const turn = blocks.slice(start, index);
    const active = busy && index === blocks.length;
    let final = -1;
    for (let i = 0; i < turn.length; i++) if (turn[i]!.kind === "assistant") final = i;
    const history = turn.filter((_, i) => i !== final);
    const timing = timings[first.seq];
    rows.push({
      seq: -first.seq - 1, kind: "reasoning", text: "", meta: null, createdAt: first.createdAt,
      activity: { blocks: history, active, startedAt: timing?.startedAt ?? first.createdAt, timing },
    });
    if (final >= 0) rows.push(turn[final]!);
  }
  return rows;
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
