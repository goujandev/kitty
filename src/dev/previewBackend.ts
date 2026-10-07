/**
 * A pretend host, so the real interface runs in an ordinary browser.
 *
 * Development only: `main.tsx` installs this when Vite is serving and there
 * is no Tauri, and production builds never import it. It answers every
 * command the app sends from an in-memory copy of a few projects and chats,
 * streams a short made-up reply to anything sent, and keeps a wallpaper so
 * the look can be reviewed and adjusted in seconds rather than rebuilt.
 *
 * Nothing here talks to a real agent or touches a real file.
 */

import type { DictationStatus } from "../ipc/commands";

type Row = Record<string, unknown>;
type Handler = (event: { event: string; id: number; payload: unknown }) => void;

const now = Date.now();
let dictation: DictationStatus = { id: null, phase: "idle", ready: true, progress: null, error: null, waveform: [] };
let recordingStarted = 0;

// Deterministic sample audio levels for visual review only, excluded from production.
function previewWaveform(): number[] {
  const tick = Math.floor((Date.now() - recordingStarted) / 75);
  return Array.from({ length: 96 }, (_, index) => {
    const position = tick - 95 + index;
    if (position < 0 || position % 70 < 22) return 0;
    return Math.abs(Math.sin(position * 0.27)) * (0.25 + 0.65 * Math.abs(Math.sin(position * 0.08)));
  });
}
const minutes = (n: number) => now - n * 60_000;

const projects: Row[] = [
  { id: "kitty", name: "kitty", root: "C:\\GitHub\\kitty", createdAt: minutes(9000), lastOpenedAt: minutes(5), sortOrder: 3 },
  { id: "spyder", name: "spyder", root: "C:\\GitHub\\spyder", createdAt: minutes(8000), lastOpenedAt: minutes(60), sortOrder: 2 },
  { id: "site", name: "personal-website", root: "C:\\GitHub\\personal-website", createdAt: minutes(7000), lastOpenedAt: minutes(600), sortOrder: 1 },
];

let sessionNumber = 0;
const session = (projectId: string, title: string | null, harness: "codex" | "claude", age: number, archivedAt: number | null = null): Row => ({
  id: `s${++sessionNumber}`, projectId, title, harness,
  model: harness === "codex" ? "gpt-6.1-sol" : "fable-5", effort: "high",
  providerSession: null, createdAt: minutes(age), updatedAt: minutes(age), archivedAt, sortOrder: -age,
});

const sessions: Row[] = [
  session("kitty", "Redesign the sidebar for projects and chats", "claude", 12),
  session("kitty", "Why does the transcript jump when streaming?", "codex", 95),
  session("kitty", "Add a Nord theme", "claude", 1400),
  session("kitty", "Old experiment with tabs", "codex", 9000, minutes(4000)),
  session("spyder", "Add Pinterest and Reddit downloads", "codex", 50),
  session("spyder", "Fix the progress bar on large files", "claude", 2000),
  session("site", "Plush Kitty section on the homepage", "claude", 3000),
];

const blocks: Record<string, Row[]> = {};
const block = (seq: number, kind: string, text: string, meta: string | null = null): Row => ({ seq, kind, text, meta, createdAt: minutes(10) });
for (const row of sessions) {
  const id = row.id as string;
  blocks[id] = [
    block(0, "user", String(row.title)),
    block(1, "tool", "Read src/views/WorkspaceSidebar.tsx", JSON.stringify({ status: "ok", detail: "148 lines" })),
    block(2, "assistant", "Here is the plan:\n\n1. **Group chats under their project** so the hierarchy is obvious.\n2. Give every row a `⋯` menu with *Rename*, *Archive* and *Delete*.\n3. Keep destructive actions last, behind a confirmation.\n\nI've made the first two changes; the third needs your call on wording."),
  ];
}

const models = {
  codex: { harness: "codex", cliVersion: "1.0.0", fetchedAtMs: now, models: [
    { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", description: "Most capable", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true },
    { id: "gpt-6.1-mini", displayName: "GPT-6.1 Mini", description: "Fast", efforts: ["low", "medium"], defaultEffort: "low", isDefault: false },
  ] },
  claude: { harness: "claude", cliVersion: "2.0.0", fetchedAtMs: now, models: [
    { id: "fable-5", displayName: "Claude Fable 5", description: "Best for everyday, complex tasks", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: true },
    { id: "opus-5-5", displayName: "Claude Opus 5.5", description: "Deepest reasoning", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: false },
  ] },
};
const found = { kind: "found", path: "cli", version: { major: 1, minor: 0, patch: 0 } };
const harness = (id: string, label: string, vendor: string) => ({ id, label, vendor, install: found, login: { kind: "loggedIn", plan: null, expiresAtMs: null }, ready: true, hint: null, verifiedVersion: found.version, newerThanVerified: false, checkedAtMs: now });
const scan = { harnesses: [harness("claude", "Claude Code", "Anthropic"), harness("codex", "Codex", "OpenAI")], durationMs: 1, pathDirs: 1 };

// ------------------------------------------------------------------ wallpaper

const WALLPAPER_KEY = "kitty.preview.wallpaper";
/** A copy of the real wallpaper, if one was put here (gitignored). */
const LOCAL_WALLPAPER = "/preview-local/background.jpg";

async function wallpaper(): Promise<string | null> {
  try {
    const saved = localStorage.getItem(WALLPAPER_KEY);
    if (saved === "none") return null;
    if (saved) return saved;
  } catch { /* Storage may be unavailable. */ }
  try {
    const response = await fetch(LOCAL_WALLPAPER, { method: "HEAD" });
    if (response.ok && (response.headers.get("content-type") ?? "").startsWith("image/")) return LOCAL_WALLPAPER;
  } catch { /* No local copy. */ }
  return null;
}

/** The browser's own file picker, standing in for the native one. */
function pickImage(): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Files attached in the preview, by the path handed back for them. */
const picked = new Map<string, { path: string; name: string; kind: "image" | "text"; size: number }>();

/**
 * The browser's own picker, standing in for the native one. Pictures come
 * back as data URLs so the preview can draw them; the real host keeps a copy
 * on disk instead and applies the same limits.
 */
function pickAttachments(): Promise<{ attached: unknown[]; refused: string[] }> {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/png,image/jpeg,image/gif,image/webp,.txt,.md,.csv,.json,.ts,.tsx,.rs,.py,.log";
    input.addEventListener("change", () => {
      const files = [...input.files ?? []];
      void Promise.all(files.map(file => new Promise<{ ok: boolean; reason?: string; value?: { path: string; name: string; kind: "image" | "text"; size: number } }>(done => {
        const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
        if (image ? file.size > 5 * 1024 * 1024 : file.size > 256 * 1024) {
          done({ ok: false, reason: `${file.name} is larger than ${image ? "5 MB, the limit for a picture" : "256 KB, the limit for a text document"}` });
          return;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const path = image ? String(reader.result) : `preview:${crypto.randomUUID()}/${file.name}`;
          done({ ok: true, value: { path, name: file.name, kind: image ? "image" : "text", size: file.size } });
        };
        reader.onerror = () => done({ ok: false, reason: `${file.name} could not be read` });
        if (image) reader.readAsDataURL(file); else reader.readAsText(file);
      }))).then(results => {
        for (const result of results) if (result.value) picked.set(result.value.path, result.value);
        resolve({
          attached: results.flatMap(result => result.value ? [result.value] : []),
          refused: results.flatMap(result => result.reason ? [result.reason] : []),
        });
      });
    });
    input.addEventListener("cancel", () => resolve({ attached: [], refused: [] }));
    input.click();
  });
}

// -------------------------------------------------------------------- events

const callbacks = new Map<number, Handler>();
const listeners = new Map<string, number[]>();
let nextCallback = 1;

function emit(sessionId: string, events: Row[]): void {
  for (const id of listeners.get("kitty://transcript") ?? []) {
    callbacks.get(id)?.({ event: "kitty://transcript", id, payload: { sessionId, events } });
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Streams one message, word by word. */
async function say(sessionId: string, kind: "assistant" | "reasoning", text: string): Promise<void> {
  const rows = blocks[sessionId]!;
  const seq = rows.length;
  rows.push(block(seq, kind, ""));
  emit(sessionId, [{ kind: "blockAppended", seq, blockKind: kind, text: "" }]);
  for (const word of text.split(/(?<= )/)) {
    await sleep(25);
    emit(sessionId, [{ kind: "blockDelta", seq, text: word }]);
  }
  rows[seq] = { ...rows[seq], text };
  emit(sessionId, [{ kind: "blockFinal", seq, text }]);
}

/** Runs one tool row from start to finish. */
async function step(sessionId: string, title: string, detail: string, ms: number): Promise<void> {
  const rows = blocks[sessionId]!;
  const seq = rows.length;
  rows.push(block(seq, "tool", title, JSON.stringify({ status: "running", detail: null })));
  emit(sessionId, [{ kind: "blockAppended", seq, blockKind: "tool", text: title }, { kind: "toolStatusChanged", seq, status: "running", detail: null }]);
  await sleep(ms);
  rows[seq] = { ...rows[seq], meta: JSON.stringify({ status: "ok", detail }) };
  emit(sessionId, [{ kind: "toolStatusChanged", seq, status: "ok", detail }]);
}

/**
 * A plausible turn, streamed the way the host batches one: an update, some
 * thinking and steps, another update, more steps, then the answer. Mentioning
 * "background" also has the agent pick the request up again by itself a
 * moment after finishing, the way a background task reporting back does.
 */
async function reply(sessionId: string, text: string): Promise<void> {
  emit(sessionId, [{ kind: "turnStarted" }]);
  await sleep(400);
  await say(sessionId, "assistant", "I'll look through the project first.");
  await say(sessionId, "reasoning", "The request touches the transcript, so the grouping code is the place to start.");
  await step(sessionId, "rg -n \"groupActivity\" src", "3 matches", 900);
  await step(sessionId, "Read src/views/activity.ts", "55 lines", 700);
  await say(sessionId, "assistant", "Found it. Running the checks now.");
  await step(sessionId, "npm run test:activity", "17 passed", 1600);
  await say(sessionId, "assistant", `This is the **preview**, so no agent is running. You said:\n\n> ${text.split("\n")[0]}\n\nIn the real app the reply streams in here, word by word.`);
  emit(sessionId, [{ kind: "turnEnded", stop: { kind: "endTurn" } }]);
  if (!/background/i.test(text)) return;
  await sleep(2500);
  emit(sessionId, [{ kind: "turnStarted" }]);
  await step(sessionId, "Background task finished: npm run build", "built in 4.1s", 1200);
  await say(sessionId, "assistant", "The background build finished too.");
  emit(sessionId, [{ kind: "turnEnded", stop: { kind: "endTurn" } }]);
}

// ------------------------------------------------------------------ commands

const sorted = (rows: Row[]) => [...rows].sort((a, b) => Number(b.sortOrder) - Number(a.sortOrder));
const summary = (project: Row) => ({ ...project, sessionCount: sessions.filter(row => row.projectId === project.id).length, exists: true });
const named = (text: unknown, what: string) => {
  const value = String(text).split(/\s+/).filter(Boolean).join(" ");
  if (!value) throw `could not rename that ${what}: A ${what} name can't be empty`;
  return value;
};
const settings = { theme: "dark", zoom: 1, approval: new Map<string, string>(), choice: { harness: "claude", model: "fable-5", effort: "high" } };

async function command(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "plugin:event|listen": {
      const event = String(args.event);
      listeners.set(event, [...(listeners.get(event) ?? []), Number(args.handler)]);
      return args.handler;
    }
    case "plugin:event|unlisten": return null;
    case "plugin:app|version": return "0.1.2-preview";
    case "harness_snapshot": case "harness_rescan": return scan;
    // Simulated activity for reviewing the composer. The browser preview never
    // opens a microphone or loads the native speech engine.
    case "dictation_status": return { ...dictation, waveform: dictation.phase === "recording" ? previewWaveform() : [] };
    case "dictation_start": {
      const id = String(args.id);
      if (dictation.id) throw new Error("Dictation is already in use.");
      dictation = { ...dictation, id, phase: "preparing" };
      await new Promise(resolve => setTimeout(resolve, 500));
      if (dictation.id !== id) throw new Error("Dictation was cancelled.");
      dictation.phase = "recording";
      recordingStarted = Date.now();
      return null;
    }
    case "dictation_finish": {
      const id = String(args.id);
      if (dictation.id !== id || dictation.phase !== "recording") throw new Error("Dictation is no longer recording.");
      dictation.phase = "transcribing";
      await new Promise(resolve => setTimeout(resolve, 900));
      if (dictation.id !== id) throw new Error("Dictation was cancelled.");
      dictation = { ...dictation, id: null, phase: "idle" };
      return "This is a dictation preview. The Windows prototype uses your microphone.";
    }
    case "dictation_cancel": {
      if (dictation.id === String(args.id)) dictation = { ...dictation, id: null, phase: "idle", progress: null, error: null };
      return null;
    }
    case "theme": return settings.theme;
    case "set_theme": settings.theme = String(args.theme); return null;
    case "zoom": return settings.zoom;
    case "set_zoom": settings.zoom = Number(args.factor); return settings.zoom;
    case "rail_widths": return { projects: 256, chats: 260 };
    case "set_rail_widths": return null;
    case "background": return wallpaper();
    case "pick_image": return pickImage();
    case "pick_attachments": return pickAttachments();
    case "set_background": try { localStorage.setItem(WALLPAPER_KEY, String(args.path)); } catch { /* Too large to keep. */ } return args.path;
    case "clear_background": try { localStorage.setItem(WALLPAPER_KEY, "none"); } catch { /* Storage may be unavailable. */ } return null;
    case "default_model": return settings.choice;
    case "set_default_model": settings.choice = args.choice as typeof settings.choice; return null;
    case "list_models": return models[args.harness as keyof typeof models];
    case "favourite_models": case "toggle_favourite_model": return [];
    case "pick_folder": {
      const name = window.prompt("Preview: type a folder path to add as a project", "C:\\GitHub\\new-project");
      return name || null;
    }
    case "open_project": {
      const path = String(args.path);
      const key = (root: unknown) => String(root).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
      const existing = projects.find(project => key(project.root) === key(path));
      if (existing) return { project: existing, created: false };
      const project = { id: `p${Date.now()}`, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path, root: path, createdAt: Date.now(), lastOpenedAt: Date.now(), sortOrder: Date.now() };
      projects.push(project);
      return { project, created: true };
    }
    case "open_stored_project": return projects.find(project => project.id === args.projectId);
    case "list_projects": return sorted(projects);
    case "list_project_summaries": return sorted(projects).map(summary);
    case "rename_project": { const project = projects.find(row => row.id === args.projectId)!; project.name = named(args.name, "project"); return project; }
    case "remove_project": {
      projects.splice(projects.findIndex(row => row.id === args.projectId), 1);
      for (let i = sessions.length - 1; i >= 0; i -= 1) if (sessions[i]!.projectId === args.projectId) sessions.splice(i, 1);
      return null;
    }
    case "reorder_projects": (args.ids as string[]).forEach((id, index, all) => { const row = projects.find(p => p.id === id); if (row) row.sortOrder = all.length - index; }); return null;
    case "reorder_sessions": return null;
    case "new_chat": case "prune_chats": case "prune_sessions": return 0;
    case "list_sessions": return sorted(sessions.filter(row => row.projectId === args.projectId));
    case "create_session": {
      const row: Row = { ...session(String(args.projectId), null, args.harness as "codex" | "claude", 0), sortOrder: Date.now() };
      sessions.push(row);
      blocks[row.id as string] = [];
      return row;
    }
    case "rename_session": { const row = sessions.find(s => s.id === args.sessionId)!; row.title = named(args.title, "chat"); return { ...row }; }
    case "archive_session": { const row = sessions.find(s => s.id === args.sessionId)!; row.archivedAt = args.archived ? Date.now() : null; return { ...row }; }
    case "delete_session": sessions.splice(sessions.findIndex(row => row.id === args.sessionId), 1); return null;
    case "session_blocks": return blocks[String(args.sessionId)] ?? [];
    case "set_session_model": {
      const row = sessions.find(s => s.id === args.sessionId);
      if (row) { row.model = args.model; row.effort = args.effort; }
      return null;
    }
    case "get_approval_mode": return settings.approval.get(String(args.sessionId)) ?? "auto";
    case "set_approval_mode": settings.approval.set(String(args.sessionId), String(args.mode)); return null;
    case "start_session": case "stop_session": case "cancel_turn": case "respond_approval": case "restart_session_thread": return null;
    case "send_turn": {
      const id = String(args.sessionId);
      const row = sessions.find(s => s.id === id)!;
      if (row.title == null) {
        row.title = String(args.text).split("\n")[0]!.slice(0, 60);
        // Stand-in for the agent-written title: the first few meaningful words.
        const short = String(args.text).replace(/^(hey|hi|hello|please|can you|could you|we need to|i want to)[,\s]+/i, "").split(/\s+/).filter(word => !/^(the|a|an|to|we|need|entire|please)$/i.test(word)).slice(0, 3).join(" ");
        setTimeout(() => {
          row.title = short.charAt(0).toUpperCase() + short.slice(1);
          for (const handler of listeners.get("kitty://session-title") ?? []) callbacks.get(handler)?.({ event: "kitty://session-title", id: handler, payload: { sessionId: id, projectId: row.projectId, title: row.title } });
        }, 1500);
      }
      row.archivedAt = null;
      const rows = blocks[id]!;
      const seq = rows.length;
      const sent = (args.attachments as string[] | undefined ?? []).map(path => picked.get(path)).filter(file => file !== undefined);
      const meta = sent.length ? JSON.stringify({
        images: sent.filter(file => file.kind === "image").map(file => file.path),
        files: sent.filter(file => file.kind === "text").map(({ name, path, size }) => ({ name, path, size })),
      }) : null;
      rows.push(block(seq, "user", String(args.text), meta));
      void reply(id, String(args.text) || `the ${sent.length} attached file${sent.length === 1 ? "" : "s"}`);
      return seq;
    }
    case "search": {
      const query = String(args.query).toLowerCase();
      return Object.entries(blocks).flatMap(([sessionId, rows]) => rows
        .filter(row => String(row.text).toLowerCase().includes(query))
        .map(row => ({ sessionId, seq: row.seq, snippet: String(row.text).slice(0, 120) })));
    }
    default:
      // Window and webview plumbing (dragging, zoom, minimise) has nothing to
      // do in a browser tab.
      return null;
  }
}

/** Puts the pretend host where `@tauri-apps/api` looks for the real one. */
export function install(): void {
  const target = window as unknown as Record<string, unknown>;
  target.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    transformCallback: (callback: Handler) => { const id = nextCallback++; callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (path: string) => path,
    invoke: (cmd: string, args: Record<string, unknown> = {}) => command(cmd, args),
  };
  target.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  document.documentElement.dataset.preview = "true";
}
