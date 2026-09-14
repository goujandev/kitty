/**
 * Typed wrappers over the Tauri commands.
 *
 * Every `invoke` in the app goes through here, so there is exactly one place
 * where a command name is spelled and one place where its result is typed.
 */

import { invoke } from "@tauri-apps/api/core";

import type { Scan } from "./bindings";

/** The last completed scan, or null if nothing has been scanned yet. */
export function harnessSnapshot(): Promise<Scan | null> {
  return invoke<Scan | null>("harness_snapshot");
}

/**
 * Runs a full scan. Slow by nature: each CLI is a child process, and an npm
 * shim boots Node before it will tell you its version.
 */
export function harnessRescan(): Promise<Scan> {
  return invoke<Scan>("harness_rescan");
}
