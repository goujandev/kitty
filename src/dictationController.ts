import type { DictationStatus } from "./ipc/commands";

export type DictationSnapshot = DictationStatus;

/** Keep only the newest bounded microphone levels; malformed values stay quiet. */
export function normalizeWaveform(levels: readonly number[] | undefined): number[] {
  return (levels ?? []).slice(-80).map(level => Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0);
}

export interface DictationDraft {
  key: string;
  text: string;
  start: number;
  end: number;
}

interface Ports {
  status: () => Promise<DictationSnapshot>;
  start: (id: string) => Promise<void>;
  finish: (id: string) => Promise<string>;
  cancel: (id: string) => Promise<void>;
  current: (draft: DictationDraft) => boolean;
  result: (draft: DictationDraft, text: string, caret: number, send: boolean) => void;
  id: () => string;
  now?: () => number;
}

/** Insert only a completed transcript at the original selection. */
export function insertDictation(draft: DictationDraft, transcript: string): { text: string; caret: number } {
  const start = Math.max(0, Math.min(draft.start, draft.text.length));
  const end = Math.max(start, Math.min(draft.end, draft.text.length));
  const before = draft.text.slice(0, start);
  const after = draft.text.slice(end);
  const spoken = transcript.trim();
  const leading = before && !/[\s([{]$/.test(before) && !/^[,.;:!?\s)]/.test(spoken) ? " " : "";
  const trailing = after && !/^\s|^[,.;:!?)}\]]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const inserted = leading + spoken + trailing;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

/** Owns a UI request, never the native recorder. IDs and draft identity fence late replies. */
export class DictationController {
  private snapshot: DictationSnapshot = { id: null, phase: "idle", ready: false, progress: null, error: null, waveform: [] };
  private run: { id: string; draft: DictationDraft } | null = null;
  private listeners = new Set<() => void>();
  private polling = false;
  private phaseStarted = 0;
  constructor(private ports: Ports) {}
  getSnapshot = (): DictationSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private set(patch: Partial<DictationSnapshot>): void {
    if (patch.phase && patch.phase !== this.snapshot.phase) this.phaseStarted = (this.ports.now ?? Date.now)();
    this.snapshot = { ...this.snapshot, ...patch };
    if (this.snapshot.phase !== "recording") this.snapshot.waveform = [];
    for (const listener of this.listeners) listener();
  }
  private owned(run: NonNullable<DictationController["run"]>): boolean {
    return this.run === run && this.ports.current(run.draft);
  }
  private release(id: string): void { void this.ports.cancel(id).catch(() => {}); }
  private fail(run: NonNullable<DictationController["run"]>, message: string): void {
    if (!this.owned(run)) return;
    this.run = null;
    this.release(run.id);
    this.set({ id: null, phase: "error", progress: null, error: message });
  }
  async start(draft: DictationDraft): Promise<void> {
    if (this.run || !this.ports.current(draft)) return;
    const run = { id: this.ports.id(), draft: { ...draft } };
    this.run = run;
    this.set({ id: run.id, phase: "preparing", progress: null, error: null });
    try {
      await this.ports.start(run.id);
      if (!this.owned(run)) { this.release(run.id); return; }
      this.set({ phase: "recording", ready: true, progress: null });
    } catch (error) {
      this.fail(run, typeof error === "string" ? error : "Couldn't start dictation. Check your microphone and connection, then try again.");
    }
  }
  async finish(send = false): Promise<void> {
    const run = this.run;
    if (!run || !this.owned(run) || this.snapshot.phase !== "recording") return;
    this.set({ phase: "transcribing", progress: null, error: null });
    try {
      const spoken = await this.ports.finish(run.id);
      if (!this.owned(run)) return;
      if (!spoken.trim()) { this.fail(run, "Didn't catch any speech. Try again."); return; }
      const merged = insertDictation(run.draft, spoken);
      this.run = null;
      this.set({ id: null, phase: "idle", progress: null, error: null });
      // Setting idle may notify callers; validate the destination again before delivery.
      if (this.ports.current(run.draft)) this.ports.result(run.draft, merged.text, merged.caret, send);
    } catch (error) {
      this.fail(run, typeof error === "string" ? error : "Couldn't transcribe that recording. Try again.");
    }
  }
  cancel(): void {
    const run = this.run;
    this.run = null;
    if (run) this.release(run.id);
    this.set({ id: null, phase: "idle", progress: null, error: null });
  }
  async poll(): Promise<void> {
    if (this.polling) return;
    const run = this.run;
    if (run && !this.owned(run)) { this.cancel(); return; }
    this.polling = true;
    try {
      const status = await this.ports.status();
      if (!run) {
        if (!this.run) this.set({ ready: status.ready });
        return;
      }
      if (!this.owned(run)) return;
      const elapsed = (this.ports.now ?? Date.now)() - this.phaseStarted;
      if ((this.snapshot.phase === "preparing" && elapsed > 15 * 60_000) ||
          (this.snapshot.phase === "transcribing" && elapsed > 3 * 60_000)) {
        this.fail(run, "Dictation took too long. Try again.");
        return;
      }
      if (status.id !== run.id) return;
      if (status.phase === "error") {
        this.fail(run, status.error || "Dictation stopped. Try again.");
      } else if (this.snapshot.phase === "preparing" && status.phase === "preparing") {
        this.set({ ready: status.ready, progress: status.progress });
      } else if (this.snapshot.phase === "recording" && status.phase === "recording") {
        this.set({ waveform: normalizeWaveform(status.waveform) });
      }
    } catch {
      if (run) this.fail(run, "Couldn't reach dictation. Try again.");
    } finally { this.polling = false; }
  }
}
