import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "installing" | "installed" | "unavailable";
export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string | null;
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  checkedAt: number | null;
  error: string | null;
}
export interface UpdatePackage {
  version: string;
  body?: string;
  download: (onEvent: (event: DownloadEvent) => void, options: { timeout: number }) => Promise<void>;
  install: (options: { restartAfterInstall: boolean }) => Promise<void>;
  close: () => Promise<void>;
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Held outside Settings so checks and downloads survive closing the dialog. */
export class UpdateController {
  private state: UpdateState = { phase: "idle", currentVersion: null, version: null, notes: null, downloaded: 0, total: null, checkedAt: null, error: null };
  private update: UpdatePackage | null = null;
  private listeners = new Set<() => void>();
  constructor(private dependencies: {
    supported: boolean;
    getVersion: () => Promise<string>;
    check: () => Promise<UpdatePackage | null>;
  }) {
    if (!dependencies.supported) this.state.phase = "unavailable";
  }
  getSnapshot = (): UpdateState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }
  async check(): Promise<void> {
    if (!this.dependencies.supported || ["checking", "downloading", "ready", "installing", "installed"].includes(this.state.phase)) return;
    this.set({ phase: "checking", error: null, version: null, notes: null, downloaded: 0, total: null });
    try {
      if (this.update) await this.update.close();
      this.update = null;
      const currentVersion = await this.dependencies.getVersion();
      this.set({ currentVersion });
      this.update = await this.dependencies.check();
      this.set({ phase: this.update ? "available" : "current", version: this.update?.version ?? null, notes: this.update?.body ?? null, checkedAt: Date.now() });
    } catch (error) {
      this.set({ phase: "idle", error: "Could not check for updates: " + message(error) });
    }
  }
  async download(): Promise<void> {
    if (this.state.phase !== "available" || !this.update) return;
    this.set({ phase: "downloading", error: null, downloaded: 0, total: null });
    try {
      await this.update.download(event => {
        if (event.event === "Started") this.set({ total: event.data.contentLength || null, downloaded: 0 });
        if (event.event === "Progress") this.set({ downloaded: this.state.downloaded + event.data.chunkLength });
        // Finished is only the network transfer. Do not allow installation until
        // download() resolves, after the Rust plugin verifies the signature.
      }, { timeout: 120_000 });
      this.set({ phase: "ready" });
    } catch (error) {
      this.set({ phase: "available", error: "Could not download or verify the update: " + message(error) });
    }
  }
  async install(hasRunningTurns: boolean): Promise<void> {
    if (this.state.phase !== "ready" || !this.update) return;
    if (hasRunningTurns) {
      this.set({ error: "Wait for running conversations to finish before restarting Pantheon." });
      return;
    }
    this.set({ phase: "installing", error: null });
    try {
      // Windows exits Pantheon after starting NSIS; the installer relaunches it.
      await this.update.install({ restartAfterInstall: true });
      this.set({ phase: "installed" });
    } catch (error) {
      this.set({ phase: "ready", error: "Could not start the installer: " + message(error) });
    }
  }
}
