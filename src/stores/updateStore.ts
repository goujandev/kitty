import { useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { UpdateController } from "./updateController";

export const updates = new UpdateController({
  supported: isTauri(),
  getVersion,
  check: () => check({ timeout: 20_000 }),
});
let started = false;
export function initialiseUpdates(): void {
  if (started) return;
  started = true;
  void updates.check();
}
export function useUpdates() {
  return useSyncExternalStore(updates.subscribe, updates.getSnapshot);
}
