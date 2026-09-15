/**
 * What the window looks like, beyond the stylesheet.
 *
 * Held outside React for the same reason the other stores are (ADR-0006), and
 * kept apart from them because it belongs to the app rather than to any
 * project or conversation.
 */

import { useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import type { RailWidths } from "../ipc/bindings";
import type { Theme } from "../ipc/commands";
import * as ipc from "../ipc/commands";

export type { Theme } from "../ipc/commands";

export interface Appearance {
  theme: Theme;
  /** The chosen image as a data URL, or null for none. */
  background: string | null;
  /** How far the window is zoomed. 1 is unscaled. */
  zoom: number;
  /** How wide each rail is, in pixels. */
  rails: RailWidths;
  error: string | null;
}

let state: Appearance = {
  theme: "system",
  background: null,
  zoom: 1,
  // Matched to the stylesheet, so the rails do not jump when the saved widths
  // arrive a moment later.
  rails: { projects: 198, chats: 248 },
  error: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<Appearance>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => state,
  );
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "something went wrong";
}

// ------------------------------------------------------------------- theme

const dark = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * Writes the theme onto the document, which is what the stylesheet keys off.
 *
 * "System" is resolved here rather than in CSS so there is one answer to
 * "which theme is in force" instead of two that can disagree.
 */
function paint(): void {
  const resolved =
    state.theme === "system" ? (dark.matches ? "dark" : "light") : state.theme;
  document.documentElement.dataset.theme = resolved;
  // Tells the browser which way to render scrollbars and form controls.
  document.documentElement.style.colorScheme = resolved;
}

// Following the OS means following it as it changes, not only at startup.
dark.addEventListener("change", () => {
  if (state.theme === "system") paint();
});

export async function setTheme(next: Theme): Promise<void> {
  // Applied before it is saved. The paint is the thing the user asked for;
  // writing it down is bookkeeping that should not delay it.
  set({ theme: next });
  paint();
  try {
    await ipc.setTheme(next);
  } catch (error) {
    set({ error: message(error) });
  }
}

// -------------------------------------------------------------- background

/** Reads the saved appearance. Call once, at startup. */
export async function loadAppearance(): Promise<void> {
  const [saved, image, factor, rails] = await Promise.all([
    ipc.theme().catch<Theme>(() => "system"),
    ipc.background().catch(() => null),
    ipc.zoom().catch(() => 1),
    ipc.railWidths().catch(() => state.rails),
  ]);
  set({ theme: saved, background: image, zoom: factor, rails });
  paint();
  // Quiet at startup: an unzoomed window is a working window.
  void applyZoom(factor).catch(() => undefined);
}

/** Remembers a rail's width. Called when a drag ends, not during one. */
export function setRailWidth(rail: keyof RailWidths, width: number): void {
  const rails = { ...state.rails, [rail]: width };
  set({ rails });
  void ipc.setRailWidths(rails).catch(() => undefined);
}

// -------------------------------------------------------------------- zoom

/**
 * The levels Ctrl+plus steps through.
 *
 * Fixed stops rather than a percentage per press: a step that is 10% of the
 * current size is a large jump when you are zoomed out and an imperceptible
 * one when you are zoomed in, so it takes a different number of presses to get
 * back to where you were than it took to leave.
 */
const STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

/**
 * Zooms the webview itself rather than scaling a root font size.
 *
 * Half the layout is in pixels -- the reading column, the rails, the radii --
 * so scaling type alone would grow the text inside a column that stayed the
 * same width, which is not zooming, it is reflowing.
 */
async function applyZoom(factor: number): Promise<void> {
  await getCurrentWebview().setZoom(factor);
}

/** Moves one stop. `direction` is +1 to zoom in, -1 out, 0 to reset. */
export async function nudgeZoom(direction: -1 | 0 | 1): Promise<void> {
  let next = 1;
  if (direction !== 0) {
    // The nearest stop to where we are, so a saved level that is not on the
    // ladder still steps sensibly.
    const here = STEPS.reduce((best, step) =>
      Math.abs(step - state.zoom) < Math.abs(best - state.zoom) ? step : best,
    );
    const index = STEPS.indexOf(here) + direction;
    next = STEPS[Math.min(Math.max(index, 0), STEPS.length - 1)] ?? 1;
  }
  if (next === state.zoom) return;

  try {
    await applyZoom(next);
  } catch (error) {
    // Said out loud rather than swallowed. A key that does nothing and
    // explains nothing is the worst of the three possible outcomes.
    set({ error: message(error) });
    return;
  }
  set({ zoom: next, error: null });
  // Saved, because the reason to change this is usually the monitor, and the
  // monitor is still there next time.
  await ipc.setZoom(next).catch(() => next);
}

/** Picks an image and adopts it. Does nothing if the picker is cancelled. */
export async function chooseBackground(): Promise<void> {
  try {
    const path = await ipc.pickImage();
    if (!path) return;
    set({ background: await ipc.setBackground(path), error: null });
  } catch (error) {
    set({ error: message(error) });
  }
}

export async function removeBackground(): Promise<void> {
  try {
    await ipc.clearBackground();
    set({ background: null, error: null });
  } catch (error) {
    set({ error: message(error) });
  }
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
