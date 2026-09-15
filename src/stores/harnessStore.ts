/**
 * The harness scan, held outside React.
 *
 * ADR-0006: state lives in a store and components subscribe through selectors.
 * One screen does not need this yet, which is exactly why it is worth doing
 * now. `MonoCode` started with state in its root component and ended with a
 * 6,509-line file holding 36 `useState` and 57 refs that mirror them. The
 * cheapest time to not do that is before there is anything to move.
 */

import { useSyncExternalStore } from "react";

import type { HarnessId, Scan } from "../ipc/bindings";
import { harnessRescan, harnessSnapshot } from "../ipc/commands";

export type Phase = "idle" | "scanning" | "ready" | "failed";

export interface HarnessState {
  phase: Phase;
  scan: Scan | null;
  error: string | null;
}

let state: HarnessState = { phase: "idle", scan: null, error: null };

const listeners = new Set<() => void>();

function set(next: Partial<HarnessState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): HarnessState {
  return state;
}

export function useHarnessState(): HarnessState {
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The agents that can actually run something, in the order they were found.
 *
 * Not a hook: the chat store needs this when deciding what a new conversation
 * should open with, and that happens in an action rather than in a render.
 */
export function readyHarnesses(): HarnessId[] {
  return (state.scan?.harnesses ?? []).filter((h) => h.ready).map((h) => h.id);
}

/** Guards against two scans overlapping, which would only waste processes. */
let inFlight: Promise<void> | null = null;

export function rescan(): Promise<void> {
  if (inFlight) return inFlight;

  set({ phase: "scanning", error: null });
  inFlight = harnessRescan()
    .then((scan) => {
      set({ phase: "ready", scan, error: null });
    })
    .catch((error: unknown) => {
      set({ phase: "failed", error: messageOf(error) });
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Called once after first paint. Shows a cached scan immediately if the host
 * already has one, then always starts a fresh scan, because an install or a
 * login can change between launches.
 */
export async function initialise(): Promise<void> {
  try {
    const cached = await harnessSnapshot();
    if (cached) set({ phase: "ready", scan: cached });
  } catch {
    // A missing cache is not an error worth showing; the scan below is what
    // actually matters.
  }
  await rescan();
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "the scan failed for an unknown reason";
}

// ---------------------------------------------------------------- hot reload

/**
 * This module is not hot-swappable, so an edit reloads the window.
 *
 * It holds live state and, more importantly, the transcript subscription
 * registered once at startup. Vite replaces the module on every edit, and
 * React Fast Refresh makes the components importing it self-accepting, so the
 * update is absorbed without a page reload: the components start reading a
 * fresh, empty copy while the subscription keeps writing into the old one.
 *
 * Nothing re-renders. A reply streams into a store nobody is looking at, the
 * blocks still reach the database, and clicking the conversation appears to
 * fix it because that path reloads from there. Which is a very convincing
 * impression of a broken transcript, and cost a lot of time to recognise.
 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    import.meta.hot?.invalidate();
  });
}
