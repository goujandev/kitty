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
  /**
   * Time already worked on this request before the agent picked it up again
   * by itself, for instance when a background task reported back.
   */
  priorMs?: number;
}

/** A run of tool calls and thinking between two things the agent said. */
export interface Steps {
  blocks: Block[];
  /** The newest thing in a running turn, so it is shown as it happens. */
  live: boolean;
}

/** How a finished turn went, under its last row. */
export interface TurnEnd {
  startedAt: number;
  timing?: TurnTiming;
}

export interface DisplayBlock extends Block {
  steps?: Steps;
  turnEnd?: TurnEnd;
}

/** Time spent on a turn, counting any earlier stretch of the same request. */
export function workedFor(timing: TurnTiming | undefined, now: number): number | null {
  if (!timing) return null;
  const end = timing.endedAt ?? now;
  return (timing.priorMs ?? 0) + Math.max(0, end - timing.startedAt);
}

/**
 * Lays a transcript out in the order things happened.
 *
 * Everything the agent says stays where it was said: an update written
 * halfway through a turn is not moved or folded away when the next one
 * arrives. Tool calls and thinking between two messages collapse into one
 * line of steps, which stays open while it is the newest thing happening.
 * A finished turn closes with how long it took.
 *
 * Synthetic rows take negative keys, from the first block they stand for, so
 * a group keeps its identity -- and its measured height -- as it grows.
 */
export function groupActivity(blocks: Block[], busy: boolean, timings: Record<number, TurnTiming>): DisplayBlock[] {
  const rows: DisplayBlock[] = [];
  let index = 0;
  while (index < blocks.length) {
    const first = blocks[index]!;
    const user = first.kind === "user" ? first : null;
    if (user) {
      rows.push(user);
      index++;
    }
    const start = index;
    while (index < blocks.length && blocks[index]!.kind !== "user") index++;
    const turn = blocks.slice(start, index);
    const active = busy && index === blocks.length;

    for (let i = 0; i < turn.length;) {
      const block = turn[i]!;
      if (block.kind === "assistant") {
        rows.push(block);
        i++;
        continue;
      }
      const from = i;
      while (i < turn.length && turn[i]!.kind !== "assistant") i++;
      const group = turn.slice(from, i);
      rows.push({
        seq: -block.seq - 1, kind: "tool", text: "", meta: null, createdAt: block.createdAt,
        steps: { blocks: group, live: active && i === turn.length },
      });
    }

    if (user && !active && turn.length > 0) {
      rows.push({
        seq: -user.seq - 1 - 1_000_000_000, kind: "tool", text: "", meta: null, createdAt: user.createdAt,
        turnEnd: { startedAt: user.createdAt, timing: timings[user.seq] },
      });
    }
  }
  return rows;
}

/** A line saying what a group of steps did, for when it is folded away. */
export function summarizeSteps(blocks: Block[]): string {
  const tools = blocks.filter(block => block.kind === "tool").length;
  const thought = blocks.some(block => block.kind === "reasoning");
  const parts: string[] = [];
  if (thought) parts.push("Thought");
  if (tools) parts.push(`${tools} ${tools === 1 ? "step" : "steps"}`);
  return parts.join(" · ") || "Working";
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
