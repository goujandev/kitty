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

import type { Scan } from "../ipc/bindings";
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
