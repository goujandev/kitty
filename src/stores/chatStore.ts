/**
 * Everything the chat screen renders, held outside React.
 *
 * ADR-0006: state lives in a store, components subscribe through selectors,
 * and nothing is mirrored into refs. The specific thing this buys during
 * streaming is that a delta replaces exactly one block object. Every other
 * row keeps its identity, so a memoised row does not re-render.
 *
 * The store is a mirror of authoritative state in Rust, never a second source
 * of truth. It can be thrown away and rebuilt from the database at any time,
 * which is what `openSession` does.
 */

import { useSyncExternalStore } from "react";

import {
  assertNever,
  type ApprovalKind,
  type Block,
  type HarnessId,
  type ModelCatalog,
  type ModelChoice,
  type Project,
  type RateLimitWindow,
  type SessionRow,
  type TranscriptBatch,
  type TranscriptEvent,
  type Usage,
  describeStop,
} from "../ipc/bindings";
import * as ipc from "../ipc/commands";
import { forgetProjectRow, patchChat, patchProject, refresh as refreshProjects, setChats, setExpanded, snapshot as projectSnapshot } from "./projectStore";
import { showNotice } from "./noticeStore";
import { nearbyAfterRemoval, splitChats } from "./sidebarModel";
import { focusComposer } from "../views/focus";
import { DRAFT, forgetProjectTabs, tabsFor } from "./tabStore";
import { readyHarnesses } from "./harnessStore";
import type { TurnTiming } from "../views/activity";
import { isActivityEvent, ProjectActivityTracker, type ProjectActivity } from "./projectActivity";

export type { ProjectActivity, ProjectActivityStatus } from "./projectActivity";

function readUnreadActivity(): unknown {
  try { return JSON.parse(localStorage.getItem("kitty.projectUnread") ?? "{}"); }
  catch { return {}; }
}
const activity = new ProjectActivityTracker(readUnreadActivity());
/** Activity for conversations not yet known to belong to a project. */
const pendingActivity = new Map<string, TranscriptEvent[]>();
let savedUnreadActivity = JSON.stringify(activity.unread());

function readTimings(): Record<string, Record<number, TurnTiming>> {
  try { return JSON.parse(localStorage.getItem("kitty.turnTimings") ?? "{}"); }
  catch { return {}; }
}
const turnTimings = readTimings();
const pendingStarts: Record<string, number> = {};
const pendingEnds: Record<string, Pick<TurnTiming, "endedAt" | "outcome">> = {};
const pendingApprovals = new Map<string, PendingApproval>();

function saveTimings(): void {
  try { localStorage.setItem("kitty.turnTimings", JSON.stringify(turnTimings)); } catch { /* Storage may be unavailable. */ }
}

export type { ApprovalKind } from "../ipc/bindings";

/** A permission request waiting on the user. */
export interface PendingApproval {
  id: string;
  approvalKind: ApprovalKind;
  title: string;
  detail: string | null;
}

export interface ChatState {
  project: Project | null;
  sessions: SessionRow[];
  activeId: string | null;
  /**
   * An agent chosen but not yet spoken to.
   *
   * Picking an agent should not commit you to a conversation, so no session
   * exists until the first message is sent. Before that it is only a draft.
   */
  draft: HarnessId | null;
  /** Transcript of the active session, in order. */
  blocks: Block[];
  /** A turn is in flight. */
  busy: boolean;
  approvalMode: ipc.ApprovalMode;
  startedAt: number | null;
  timings: Record<number, TurnTiming>;
  /** Short-lived progress text from the CLI. */
  status: string | null;
  /** Why the last turn stopped, when it was not a clean finish. */
  notice: string | null;
  usage: Usage | null;
  context: { used: number | null; window: number | null } | null;
  /**
   * How much of each usage window is gone, per vendor.
   *
   * Keyed by harness rather than held for the open conversation, because that
   * is what a quota actually is: an account-level fact that every session with
   * the same vendor shares. Holding one list and clearing it on every switch
   * meant opening an old chat blanked the meters until the next turn refilled
   * them -- the numbers had not changed, kitty had just thrown them away.
   *
   * Still per vendor, though. Showing Claude's numbers in a Codex session
   * would be worse than showing none.
   */
  limits: Partial<Record<HarnessId, RateLimitWindow[]>>;
  /**
   * Conversations with a turn in flight, to the project they belong to.
   *
   * Tracked for every session rather than just the open one, because the point
   * is to see from the rails that something is working while you read
   * something else. The project id rides along so the projects rail can show
   * activity without knowing which sessions live where.
   */
  running: Record<string, string>;
  /** Conversations waiting on a permission answer, wherever they are. */
  waiting: Record<string, true>;
  /** Per-project badges for conversations working or finished in the background. */
  projectActivity: Record<string, ProjectActivity>;
  /**
   * The agent is asking permission. The turn is stalled until this is
   * answered, so it is shown prominently rather than as a notification.
   */
  approval: PendingApproval | null;
  /** Model lists, per harness, once asked for. */
  catalogs: Partial<Record<HarnessId, ModelCatalog>>;
  /** Starred model ids, per harness. */
  favourites: Partial<Record<HarnessId, string[]>>;
  /**
   * The model the CLI says it resolved to.
   *
   * Display only. It is the full name, while the catalog is keyed by the
   * shorter id you ask for, so the two must not be confused.
   */
  runningModel: string | null;
  /**
   * A model chosen for a draft, applied when the session is created.
   *
   * A draft has no session to configure yet, so the choice is held here.
   */
  draftModel: { model: string; effort: string | null } | null;
  /**
   * The model a new conversation opens with, from settings.
   *
   * Null means none has been chosen and whichever agent is ready runs on its
   * own recommended model.
   */
  defaultChoice: ModelChoice | null;
  error: string | null;
  loading: boolean;
}

const EMPTY: ChatState = {
  project: null,
  sessions: [],
  activeId: null,
  draft: null,
  blocks: [],
  busy: false,
  approvalMode: "auto",
  startedAt: null,
  timings: {},
  status: null,
  notice: null,
  usage: null,
  context: null,
  limits: {},
  running: {},
  waiting: {},
  projectActivity: activity.snapshot(),
  approval: null,
  catalogs: {},
  favourites: {},
  runningModel: null,
  draftModel: null,
  defaultChoice: null,
  error: null,
  loading: false,
};

let state: ChatState = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<ChatState>): void {
  state = { ...state, ...next };
  // The sidebar lists every project's chats from one place; the open
  // project's list is this one.
  if ("sessions" in next && state.project) setChats(state.project.id, state.sessions);
  if ("project" in next || "activeId" in next || "loading" in next) {
    activity.view(viewedProject());
    updateActivityFields();
  }
  for (const listener of listeners) listener();
}

function viewedProject(): string | null {
  return state.activeId && !state.loading && document.visibilityState === "visible" && document.hasFocus()
    ? state.project?.id ?? null : null;
}

function updateActivityFields(): boolean {
  const projectActivity = activity.snapshot();
  const running = activity.running();
  const unread = JSON.stringify(activity.unread());
  if (unread !== savedUnreadActivity) {
    savedUnreadActivity = unread;
    // This is a disposable read receipt, like scroll position and turn timing;
    // session outcomes remain authoritative in Rust.
    try { localStorage.setItem("kitty.projectUnread", unread); } catch { /* Storage may be unavailable. */ }
  }
  if (JSON.stringify(projectActivity) === JSON.stringify(state.projectActivity)
    && JSON.stringify(running) === JSON.stringify(state.running)) return false;
  state = { ...state, projectActivity, running };
  return true;
}

function publishActivity(): void {
  if (updateActivityFields()) for (const listener of listeners) listener();
}

function registerActivitySession(sessionId: string, projectId: string): void {
  activity.register(sessionId, projectId);
  const events = pendingActivity.get(sessionId);
  if (!events) return;
  pendingActivity.delete(sessionId);
  activity.transcript(sessionId, events);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useChat(): ChatState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Read the current state outside React, for event handlers. */
export function snapshot(): ChatState {
  return state;
}

function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "something went wrong";
}

// ------------------------------------------------------------------ actions

/**
 * New project: pick a folder, then land in a fresh chat there.
 *
 * Cancelling the picker changes nothing. A folder that is already a project
 * selects that project rather than adding a twin, and says so.
 */
export async function chooseProject(): Promise<boolean> {
  try {
    const path = await ipc.pickFolder();
    if (!path) return false;
    const { project, created } = await ipc.openProject(path);
    // The rail is a separate store and has no idea this happened. Without
    // this a folder you just opened is not in the list of folders.
    await refreshProjects();
    await useProject(project, true);
    if (!created) showNotice({ tone: "info", message: `${project.name} is already in Kitty, so it was opened.` });
    return true;
  } catch (error) {
    showNotice({ tone: "error", message: `Couldn't open that folder. ${message(error)}`, action: { label: "Try again", run: () => void chooseProject() } });
    set({ loading: false });
    return false;
  }
}

/**
 * Forgets a project and everything in it.
 *
 * Lives here rather than in the projects store because of the case that made
 * it worth writing: deleting the project you are currently reading. The rail
 * would drop the row and leave a transcript on screen belonging to something
 * that no longer exists, and the next thing you typed would go to a session
 * whose rows had been cascaded away.
 *
 * So you get moved out of it, into a new chat with no folder -- which is the
 * one place that is always safe to land, because it depends on nothing.
 */
export async function forgetProject(projectId: string): Promise<boolean> {
  const wasOpen = state.project?.id === projectId;
  try {
    await ipc.removeProject(projectId);
    activity.forget(projectId);
    publishActivity();
    forgetProjectRow(projectId);
    forgetProjectTabs(projectId);
    setExpanded(projectId, false);
    if (wasOpen) set({ project: null, sessions: [], activeId: null, blocks: [], draft: null, draftModel: null, busy: false, approval: null, loading: false, error: null, notice: null, status: null });
    await refreshProjects();
    return true;
  } catch (error) {
    showNotice({ tone: "error", message: `Couldn't remove the project. ${message(error)}`, action: { label: "Try again", run: () => void forgetProject(projectId) } });
    return false;
  }
}

/** Renames a project in Kitty, showing the new name at once. */
export async function renameProject(projectId: string, name: string): Promise<boolean> {
  const before = projectSnapshot().projects.find(project => project.id === projectId)?.name;
  patchProject(projectId, project => ({ ...project, name }));
  if (state.project?.id === projectId) set({ project: { ...state.project, name } });
  try {
    const saved = await ipc.renameProject(projectId, name);
    patchProject(projectId, project => ({ ...project, name: saved.name }));
    if (state.project?.id === projectId) set({ project: { ...state.project, name: saved.name } });
    return true;
  } catch (error) {
    if (before !== undefined) {
      patchProject(projectId, project => ({ ...project, name: before }));
      if (state.project?.id === projectId) set({ project: { ...state.project, name: before } });
    }
    showNotice({ tone: "error", message: `Couldn't rename the project. ${message(error)}`, action: { label: "Try again", run: () => void renameProject(projectId, name) } });
    return false;
  }
}

function chatsOf(projectId: string): SessionRow[] {
  return state.project?.id === projectId ? state.sessions : projectSnapshot().chats[projectId] ?? [];
}

function replaceChat(projectId: string, id: string, update: (row: SessionRow) => SessionRow | null): void {
  if (state.project?.id === projectId) {
    set({ sessions: state.sessions.flatMap(row => {
      if (row.id !== id) return [row];
      const next = update(row);
      return next ? [next] : [];
    }) });
  } else {
    patchChat(projectId, id, update);
  }
}

/**
 * Moves off a chat that is leaving the list, to its neighbour.
 *
 * The chat below takes its place, or the one above; with none left the
 * project opens a fresh draft rather than pointing at something gone.
 * Returns the chat now selected, or null for the draft.
 */
async function leaveChat(projectId: string, sessionId: string, openIds: string[]): Promise<string | null> {
  if (state.project?.id !== projectId || state.activeId !== sessionId) return state.activeId;
  const next = nearbyAfterRemoval(openIds, sessionId);
  if (next && next !== sessionId) {
    await openSession(next);
    return next;
  }
  newSession();
  return null;
}

/** Renames a chat. The sidebar and heading change at once. */
export async function renameChat(projectId: string, sessionId: string, title: string): Promise<boolean> {
  const before = chatsOf(projectId).find(row => row.id === sessionId)?.title ?? null;
  replaceChat(projectId, sessionId, row => ({ ...row, title }));
  try {
    const saved = await ipc.renameSession(sessionId, title);
    replaceChat(projectId, sessionId, row => ({ ...row, title: saved.title }));
    return true;
  } catch (error) {
    replaceChat(projectId, sessionId, row => ({ ...row, title: before }));
    showNotice({ tone: "error", message: `Couldn't rename the chat. ${message(error)}`, action: { label: "Try again", run: () => void renameChat(projectId, sessionId, title) } });
    return false;
  }
}

/**
 * Archives a chat, or restores one.
 *
 * Archiving the chat on screen moves to its neighbour. A short Undo follows,
 * because archive is the reversible way to tidy up.
 */
export async function archiveChat(projectId: string, sessionId: string, archived: boolean): Promise<string | null | false> {
  const rows = chatsOf(projectId);
  const row = rows.find(entry => entry.id === sessionId);
  const openIds = splitChats(rows).open.map(entry => entry.id);
  replaceChat(projectId, sessionId, entry => ({ ...entry, archivedAt: archived ? Date.now() : null }));
  try {
    const saved = await ipc.archiveSession(sessionId, archived);
    replaceChat(projectId, sessionId, () => saved);
    const selected = archived ? await leaveChat(projectId, sessionId, openIds) : state.activeId;
    const name = row?.title ?? "Chat";
    if (archived) {
      showNotice({ tone: "info", message: `Archived “${name}”.`, action: { label: "Undo", run: () => void archiveChat(projectId, sessionId, false) } });
    } else {
      showNotice({ tone: "info", message: `Restored “${name}”.` });
    }
    return selected;
  } catch (error) {
    replaceChat(projectId, sessionId, entry => ({ ...entry, archivedAt: row?.archivedAt ?? null }));
    showNotice({ tone: "error", message: `Couldn't ${archived ? "archive" : "restore"} the chat. ${message(error)}`, action: { label: "Try again", run: () => void archiveChat(projectId, sessionId, archived) } });
    return false;
  }
}

/** Opens a project kitty already knows about, with or without a folder. */
export async function openById(projectId: string): Promise<void> {
  try {
    await useProject(await ipc.openStoredProject(projectId));
    // Opening one moves it to the top, and the rail sorts by that.
    await refreshProjects();
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

/** Opens a project directly into a draft without opening a saved thread first. */
export async function newSessionInProject(projectId: string): Promise<void> {
  if (state.project?.id === projectId) { newSession(); return; }
  set({ loading: true });
  try {
    const project = await ipc.openStoredProject(projectId);
    await useProject(project, true);
    await refreshProjects();
  } catch (error) {
    set({ loading: false });
    showNotice({ tone: "error", message: `Couldn't open that project. ${message(error)}`, action: { label: "Try again", run: () => void newSessionInProject(projectId) } });
  }
}

/**
 * Starts a conversation with no codebase behind it.
 *
 * The project is created now rather than on the first message, because unlike
 * a draft session it is a row in the rail you are looking at. Walking away
 * from an empty one is tidied up by `pruneChats` the next time any project is
 * opened.
 */
export async function newChat(): Promise<void> {
  try {
    const project = await ipc.newChat();
    await useProject(project);
    await refreshProjects();
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

/**
 * Jumps to one conversation, switching project first if it is in another one.
 *
 * Used by search, where a hit can be anywhere.
 */
export async function openSessionAnywhere(
  projectId: string,
  sessionId: string,
): Promise<void> {
  set({ loading: true });
  try {
    if (state.project?.id !== projectId) {
      const project = (await ipc.listProjects()).find((p) => p.id === projectId);
      if (!project) { set({ loading: false }); return; }
      // Deliberately not `useProject`: that would open the newest session, and
      // the point here is to open a specific one.
      set({
        project,
        error: null,
        activeId: null,
        blocks: [],
        busy: false,
        startedAt: null,
        timings: {},
        status: null,
        notice: null,
        runningModel: null,
        draft: null,
        draftModel: null,
        usage: null,
        context: null,
        approval: null,
      });
      set({ sessions: await ipc.listSessions(projectId) });
    }
    setExpanded(projectId, true);
    await openSession(sessionId);
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

export async function restoreLastProject(): Promise<void> {
  try {
    // Sweep first, keeping nothing. A chat with no folder and no messages is
    // one that was asked for and walked away from, and restoring it would put
    // the user back in front of a box they already decided not to type into.
    await ipc.pruneChats("").catch(() => 0);
    const projects = (await ipc.listProjects()).filter(project => project.root !== null);
    if (projects[0]) await useProject(projects[0]);
  } catch (error) {
    set({ error: message(error), loading: false });
  }
}

/**
 * Switches to a project and opens its most recent conversation, or a new one
 * when it has none or `startFresh` asks for it.
 */
async function useProject(project: Project, startFresh = false): Promise<void> {
  set({
    project,
    loading: true,
    error: null,
    sessions: [],
    activeId: null,
    draft: null,
    blocks: [],
    usage: null,
    context: null,
    approval: null,
  });
  // Tidy before listing, so abandoned sessions never appear at all.
  await ipc.pruneSessions(project.id).catch(() => 0);
  // And the same for chats: one exists from the moment you ask for it, so
  // clicking away from an empty one has to leave nothing behind.
  await ipc.pruneChats(project.id).catch(() => 0);
  const sessions = await ipc.listSessions(project.id);
  if (state.project?.id !== project.id) return;
  for (const session of sessions) registerActivitySession(session.id, project.id);
  publishActivity();
  set({ sessions });
  setExpanded(project.id, true);
  // Back to the tab that was open last time; otherwise the newest chat still
  // in the list. Archived chats are put away.
  const remembered = tabsFor(project.id).active;
  if (remembered === DRAFT && !startFresh) { newSession(); return; }
  const open = splitChats(sessions).open;
  const first = open.find(session => session.id === remembered) ?? open[0];
  if (first && !startFresh) {
    await openSession(first.id);
    return;
  }
  // Nothing to open, so open the next one. A project with no conversations
  // and a box you cannot type into is a dead end you have to click out of.
  newSession();
}
/** Reads the saved default, for deciding what a new conversation opens with. */
export async function loadDefaultChoice(): Promise<void> {
  try {
    set({ defaultChoice: await ipc.defaultModel() });
  } catch {
    // A missing preference is not an error; it means the recommended model.
  }
}

export async function setDefaultChoice(choice: ModelChoice | null): Promise<void> {
  try {
    await ipc.setDefaultModel(choice);
    set({ defaultChoice: choice });
  } catch (error) {
    set({ error: message(error) });
  }
}

/**
 * What a new conversation opens with.
 *
 * The saved default if its agent can still run -- an agent that has been
 * uninstalled or signed out of is not a choice any more -- and otherwise the
 * first one that can, on whatever it recommends itself. Never nothing: an
 * empty chip is a box you cannot type into, which is the whole problem this
 * exists to solve.
 */
function opening(): { harness: HarnessId; model: string | null; effort: string | null } | null {
  const ready = readyHarnesses();
  if (ready.length === 0) return null;

  const saved = state.defaultChoice;
  if (saved && ready.includes(saved.harness)) {
    return { harness: saved.harness, model: saved.model, effort: saved.effort };
  }

  const harness = ready[0];
  if (!harness) return null;
  // Whatever that CLI recommends, once its catalog has arrived. Until then the
  // session starts on the CLI's own default, which is the same thing.
  const suggested = state.catalogs[harness]?.models.find((m) => m.isDefault);
  return {
    harness,
    model: suggested?.id ?? null,
    effort: suggested?.defaultEffort ?? null,
  };
}

/**
 * Opens a conversation that does not exist yet.
 *
 * Nothing is written until the first message, so opening one and changing your
 * mind leaves no empty sessions behind. It arrives with a model already
 * chosen, so the box is typeable the moment it appears -- picking a model is
 * something you do because you want a different one, not a toll gate in front
 * of typing.
 */
export function newSession(): void {
  if (!state.project) return;
  // Already looking at an unsent draft: that is the new chat. Starting over
  // would throw away the agent and model just chosen for it.
  if (state.draft !== null && state.activeId === null) {
    focusComposer();
    return;
  }
  const start = opening();

  if (start) void loadModels(start.harness);
  set({
    loading: false,
    draft: start?.harness ?? null,
    approvalMode: "auto",
    draftModel:
      start?.model != null
        ? { model: start.model, effort: start.effort }
        : null,
    activeId: null,
    blocks: [],
    busy: false,
    startedAt: null,
    timings: {},
    status: null,
    notice: null,
    usage: null,
    context: null,
    approval: null,
    error: null,
  });
  focusComposer();
}

/**
 * Permanently deletes one chat from Kitty.
 *
 * If it was the one on screen, its neighbour takes its place -- or a fresh
 * draft, rather than a transcript that is no longer anywhere. Returns the
 * chat now selected (null for a draft), or false when the delete failed.
 */
export async function deleteChat(projectId: string, sessionId: string): Promise<string | null | false> {
  const rows = chatsOf(projectId);
  const { open, archived } = splitChats(rows);
  const ids = (open.some(row => row.id === sessionId) ? open : archived).map(row => row.id);
  try {
    await ipc.deleteSession(sessionId);
    pendingApprovals.delete(sessionId);
    delete turnTimings[sessionId];
    saveTimings();
    const selected = await leaveChat(projectId, sessionId, ids);
    replaceChat(projectId, sessionId, () => null);
    void refreshProjects();
    return selected;
  } catch (error) {
    showNotice({ tone: "error", message: `Couldn't delete the chat. ${message(error)}`, action: { label: "Try again", run: () => void deleteChat(projectId, sessionId) } });
    return false;
  }
}

/** Switches to a session, reloading its transcript from the database. */
export async function openSession(sessionId: string): Promise<void> {
  set({
    activeId: sessionId,
    approvalMode: "auto",
    draft: null,
    draftModel: null,
    blocks: [],
    busy: sessionId in state.running,
    startedAt: pendingStarts[sessionId] ?? null,
    timings: turnTimings[sessionId] ?? {},
    status: null,
    notice: null,
    usage: null,
    context: null,
    approval: pendingApprovals.get(sessionId) ?? null,
    runningModel: null,
    error: null,
    loading: true,
  });

  const row = state.sessions.find((s) => s.id === sessionId);
  const harness = row?.harness;
  if (harness === "claude" || harness === "codex") void loadModels(harness);

  try {
    const blocks = await ipc.sessionBlocks(sessionId);
    // Guard against a slower load landing after the user moved on.
    if (state.activeId !== sessionId) return;
    const approvalMode = await ipc.getApprovalMode(sessionId);
    if (state.activeId !== sessionId) return;
    set({ blocks, approvalMode });
    // An archived chat is for reading; its agent starts if you write in it.
    if (!row?.archivedAt) await ipc.startSession(sessionId);
    if (state.activeId === sessionId) set({ loading: false });
  } catch (error) {
    if (state.activeId === sessionId) {
      set({ error: message(error), loading: false });
    }
  }
}

export async function restartAgentContext(): Promise<void> {
  const sessionId = state.activeId;
  if (!sessionId || state.busy) return;
  set({ loading: true, error: null, approval: null });
  try {
    await ipc.restartSessionThread(sessionId);
    if (state.activeId === sessionId) {
      set({ loading: false, notice: "Fresh agent context ready. Saved Kitty history remains; send your next request." });
    }
  } catch (error) {
    if (state.activeId === sessionId) set({ loading: false, error: message(error) });
  }
}

export async function send(text: string): Promise<void> {
  if (state.busy) return;

  const trimmed = text.trimEnd();
  if (!trimmed) return;

  const startedAt = Date.now();
  const projectId = state.project?.id;
  const approvalMode = state.approvalMode;
  let sessionId = state.activeId;
  set({ busy: true, startedAt, notice: null, error: null, status: null });
  try {
    // A draft becomes a real session here, on the first message and not
    // before.
    sessionId ??= await commitDraft();
    if (!sessionId) {
      set({ busy: false });
      return;
    }

    // Marked before the round trip, not after. A turn that finished first
    // would otherwise clear a flag that had not been set yet, and then the
    // flag would be set, and the row would spin for ever.
    if (projectId) {
      registerActivitySession(sessionId, projectId);
      activity.start(sessionId);
      publishActivity();
    }
    pendingStarts[sessionId] = startedAt;
    // Opening a project may have failed to launch its CLI, or the process may
    // have exited since then. Ensure it is ready before accepting another turn.
    await ipc.startSession(sessionId);
    await ipc.setApprovalMode(sessionId, approvalMode);
    delete pendingEnds[sessionId];
    const seq = await ipc.sendTurn(sessionId, trimmed);
    const timings = turnTimings[sessionId] ?? {};
    turnTimings[sessionId] = { ...timings, [seq]: { startedAt, ...timings[seq], ...pendingEnds[sessionId] } };
    delete pendingEnds[sessionId];
    saveTimings();
    if (state.activeId === sessionId) set({ timings: turnTimings[sessionId] });
    // Show it immediately rather than waiting for a round trip.
    if (state.activeId === sessionId) appendLocalBlock({
      seq,
      kind: "user",
      text: trimmed,
      meta: null,
      createdAt: Date.now(),
    });
    // The title is derived from the first message, so refresh the list. A
    // folderless project is named after that same title, so the rail on the
    // far left has just gone stale too.
    void refreshSessions();
    if (state.project?.root === null) void refreshProjects();
  } catch (error) {
    // The turn never started, so nothing is working on our behalf.
    if (sessionId) {
      delete pendingStarts[sessionId];
      delete pendingEnds[sessionId];
      activity.transcript(sessionId, [{ kind: "failed", errorKind: "process", message: message(error) }]);
      publishActivity();
    }
    if (state.activeId === sessionId) set({ busy: false, error: message(error) });
  }
}

/** Turns the chosen agent into a real session. Returns its id. */
async function commitDraft(): Promise<string | null> {
  const { project, draft } = state;
  if (!project || !draft) return null;

  const session = await ipc.createSession(project.id, draft);
  registerActivitySession(session.id, project.id);
  set({
    activeId: session.id,
    draft: null,
    sessions: [session, ...state.sessions],
  });

  // A model chosen before the session existed is applied now, before the CLI
  // starts, so it takes effect on the very first turn.
  const chosen = state.draftModel;
  if (chosen) {
    await ipc
      .setSessionModel(session.id, chosen.model, chosen.effort)
      .catch(() => undefined);
    set({ draftModel: null });
    await refreshSessions();
    return session.id;
  }

  await ipc.startSession(session.id);
  return session.id;
}

export async function chooseApprovalMode(mode: ipc.ApprovalMode): Promise<void> {
  const id = state.activeId;
  try {
    if (id) await ipc.setApprovalMode(id, mode);
    if (state.activeId === id) set({ approvalMode: mode });
  } catch (error) { set({ error: message(error) }); }
}

export async function cancel(): Promise<void> {
  const { activeId } = state;
  if (!activeId) return;
  try {
    await ipc.cancelTurn(activeId);
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Saves a hand-dragged order for the open project's conversations. */
export async function reorderSessions(ids: string[]): Promise<void> {
  try {
    await ipc.reorderSessions(ids);
    await refreshSessions();
  } catch (error) {
    set({ error: message(error) });
  }
}

async function refreshSessions(): Promise<void> {
  const { project } = state;
  if (!project) return;
  try {
    const sessions = await ipc.listSessions(project.id);
    for (const session of sessions) registerActivitySession(session.id, project.id);
    publishActivity();
    if (state.project?.id === project.id) set({ sessions });
  } catch {
    // A stale session list is not worth an error banner.
  }
}

function appendLocalBlock(block: Block): void {
  if (state.blocks.some((b) => b.seq === block.seq)) return;
  set({ blocks: [...state.blocks, block] });
}

/** The harness a new or open conversation will use, if any. */
export function currentHarness(): HarnessId | null {
  if (state.draft) return state.draft;
  return state.sessions.find((s) => s.id === state.activeId)?.harness ?? null;
}

/** Fallback names, for before a model list has been fetched. */
const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * What to call the agent in the transcript.
 *
 * The model's name, not the harness's: "Claude Opus 5" says more than "Claude
 * Code". Falls back through what the CLI resolved to and then the harness, so
 * a message always has a speaker even before the catalog has loaded.
 */
export function agentName(): string {
  const harness = currentHarness();
  if (!harness) return "Agent";

  const { model } = currentModel();
  const models = state.catalogs[harness]?.models;
  const entry = model
    ? models?.find((m) => m.id === model)
    : models?.find((m) => m.isDefault);

  return entry?.displayName ?? model ?? state.runningModel ?? HARNESS_LABEL[harness];
}

/**
 * A chat's model, as a short name for lists: "Fable 5" rather than "Claude
 * Fable 5", since the provider's mark sits beside it. Falls back to the id the
 * CLI uses, then to the provider's recommended model.
 */
export function modelLabel(row: Pick<SessionRow, "harness" | "model">): string {
  const models = state.catalogs[row.harness]?.models;
  const entry = row.model ? models?.find(m => m.id === row.model) : models?.find(m => m.isDefault);
  const name = entry?.displayName ?? row.model ?? HARNESS_LABEL[row.harness];
  return name.replace(/^Claude\s+/i, "");
}

/** Fetches the model lists a set of chats needs to name their models. */
const requestedCatalogs = new Set<HarnessId>();
export function ensureCatalogs(harnesses: Iterable<HarnessId>): void {
  for (const harness of new Set(harnesses)) {
    if (state.catalogs[harness] || requestedCatalogs.has(harness)) continue;
    requestedCatalogs.add(harness);
    void loadModels(harness);
  }
}

/** The model choice in force, from the session or the pending draft. */
export function currentModel(): { model: string | null; effort: string | null } {
  if (state.draft) {
    return {
      model: state.draftModel?.model ?? null,
      effort: state.draftModel?.effort ?? null,
    };
  }
  const session = state.sessions.find((s) => s.id === state.activeId);
  return { model: session?.model ?? null, effort: session?.effort ?? null };
}

/** Fetches a harness's model list, from cache unless `refresh`. */
export async function loadModels(
  harness: HarnessId,
  refresh = false,
): Promise<void> {
  // Starred ids are a preference, not part of the catalog, so a failure to
  // read them must not stop the models arriving.
  void ipc
    .favouriteModels(harness)
    .then((ids) => set({ favourites: { ...state.favourites, [harness]: ids } }))
    .catch(() => undefined);

  try {
    const catalog = await ipc.listModels(harness, refresh);
    set({ catalogs: { ...state.catalogs, [harness]: catalog } });
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Stars a model, or unstars one already starred. */
export async function toggleFavourite(
  harness: HarnessId,
  model: string,
): Promise<void> {
  try {
    const ids = await ipc.toggleFavouriteModel(harness, model);
    set({ favourites: { ...state.favourites, [harness]: ids } });
  } catch (error) {
    set({ error: message(error) });
  }
}

/**
 * Chooses a model.
 *
 * For an open session this restarts the CLI, which resumes its history. For a
 * draft it is remembered and applied when the session is created.
 */
export async function chooseModel(
  harness: HarnessId,
  model: string,
  effort: string | null,
): Promise<void> {
  if (state.draft) {
    // The vendor comes with the model. Nothing has been created yet, so
    // switching between them here costs nothing and asks nothing.
    set({ draft: harness, draftModel: { model, effort } });
    return;
  }
  const { activeId } = state;
  if (!activeId) return;

  // The CLI is running with this conversation's history and the other vendor
  // was never told any of it. The picker greys these out; this is the guard
  // behind that, not a message anyone should see.
  const running = state.sessions.find((s) => s.id === activeId)?.harness;
  if (running && running !== harness) {
    set({ error: "Start a new chat to use a different agent." });
    return;
  }

  set({ busy: false, notice: null, error: null });
  try {
    await ipc.setSessionModel(activeId, model, effort);
    await refreshSessions();
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Answers the permission request on screen. */
export async function respondApproval(allow: boolean): Promise<void> {
  const { activeId, approval } = state;
  if (!activeId || !approval) return;

  // Clear it immediately. The confirmation comes back as an event, but the
  // button should not stay live while that round-trips.
  set({ approval: null });
  try {
    await ipc.respondApproval(activeId, approval.id, allow);
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Replaces one block, leaving every other block's identity untouched. */
function replaceBlock(seq: number, update: (block: Block) => Block): void {
  let changed = false;
  const blocks = state.blocks.map((block) => {
    if (block.seq !== seq) return block;
    changed = true;
    return update(block);
  });
  if (changed) set({ blocks });
}

// ------------------------------------------------------------------ events

function apply(event: TranscriptEvent): void {
  switch (event.kind) {
    case "sessionReady":
      set({ runningModel: event.model });
      return;

    case "blockAppended":
      appendLocalBlock({
        seq: event.seq,
        kind: event.blockKind,
        text: event.text,
        meta: null,
        createdAt: Date.now(),
      });
      return;

    case "blockDelta":
      replaceBlock(event.seq, (block) => ({
        ...block,
        text: block.text + event.text,
      }));
      return;

    case "blockFinal":
      replaceBlock(event.seq, (block) => ({ ...block, text: event.text }));
      return;

    case "toolStatusChanged":
      replaceBlock(event.seq, (block) => ({
        ...block,
        meta: JSON.stringify({ status: event.status, detail: event.detail }),
      }));
      return;

    case "picturesAttached":
      // Stored on the block rather than held beside it, so reopening the
      // conversation shows them without going back to the folder.
      replaceBlock(event.seq, (block) => ({
        ...block,
        meta: JSON.stringify({ images: event.paths }),
      }));
      return;

    case "approvalRequested":
      set({
        approval: {
          id: event.id,
          approvalKind: event.approvalKind,
          title: event.title,
          detail: event.detail,
        },
      });
      return;

    case "approvalResolved":
      // Only clear it if it is the one on screen. A late resolution for an
      // older request must not dismiss a newer question.
      if (state.approval?.id === event.id) set({ approval: null });
      return;

    case "turnEnded":
      set({
        busy: false,
        status: null,
        approval: null,
        notice: describeStop(event.stop),
      });
      void refreshSessions();
      return;

    case "usage":
      set({
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheWriteTokens: event.cacheWriteTokens,
          reasoningTokens: event.reasoningTokens,
        },
      });
      return;

    case "context":
      set({ context: { used: event.used, window: event.window } });
      return;

    case "rateLimits": {
      // Filed under whoever reported them, so switching between two Claude
      // conversations keeps the numbers and switching vendor does not mix
      // them up.
      const speaking = currentHarness();
      if (speaking) set({ limits: { ...state.limits, [speaking]: event.windows } });
      return;
    }

    case "status":
      set({ status: event.text });
      return;

    case "failed":
      set({ busy: false, approval: null, error: event.message });
      return;

    default:
      assertNever(event, "TranscriptEvent");
  }
}

/** Starts listening for transcript batches. Call once, at startup. */
export async function listen(): Promise<() => void> {
  const stopTranscript = await ipc.onTranscript((batch: TranscriptBatch) => {
    const events = batch.events.filter(isActivityEvent);
    if (events.length) {
      activity.view(viewedProject());
      if (activity.projectFor(batch.sessionId)) activity.transcript(batch.sessionId, events);
      else pendingActivity.set(batch.sessionId, [...(pendingActivity.get(batch.sessionId) ?? []), ...events]);
      publishActivity();
    }
    // Whether a turn has finished is read from every batch, not just the open
    // conversation's: the rails show which conversations are working, and one
    // you are not looking at is exactly the case that needs saying.
    for (const event of batch.events) {
      if (event.kind === "approvalRequested") {
        pendingApprovals.set(batch.sessionId, { id: event.id, approvalKind: event.approvalKind, title: event.title, detail: event.detail });
      } else if (event.kind === "approvalResolved" && pendingApprovals.get(batch.sessionId)?.id === event.id) {
        pendingApprovals.delete(batch.sessionId);
      }
      if (event.kind === "blockAppended" && event.blockKind === "user") {
        const timings = turnTimings[batch.sessionId] ?? {};
        turnTimings[batch.sessionId] = { ...timings, [event.seq]: { startedAt: pendingStarts[batch.sessionId] ?? Date.now() } };
      }
      if (event.kind === "turnEnded" || event.kind === "failed") {
        pendingApprovals.delete(batch.sessionId);
        const timings = turnTimings[batch.sessionId] ?? {};
        const seq = Math.max(-1, ...Object.keys(timings).map(Number).filter(seq => timings[seq]?.endedAt === undefined));
        const ending: Pick<TurnTiming, "endedAt" | "outcome"> = {
          endedAt: Date.now(),
          outcome: event.kind === "failed" || event.stop.kind === "failed" ? "failed" : event.stop.kind === "endTurn" ? "worked" : "stopped",
        };
        if (seq >= 0) {
          turnTimings[batch.sessionId] = { ...timings, [seq]: {
            ...timings[seq]!, ...ending,
          } };
          saveTimings();
        } else if (batch.sessionId in pendingStarts) pendingEnds[batch.sessionId] = ending;
        delete pendingStarts[batch.sessionId];
      }
    }
    const waiting = pendingApprovals.has(batch.sessionId);
    if (waiting !== batch.sessionId in state.waiting) {
      const { [batch.sessionId]: _was, ...rest } = state.waiting;
      set({ waiting: waiting ? { ...rest, [batch.sessionId]: true } : rest });
    }
    // The transcript itself is only rebuilt for the one on screen.
    if (batch.sessionId !== state.activeId) return;
    set({ timings: turnTimings[batch.sessionId] ?? {} });
    for (const event of batch.events) apply(event);
  });
  // The agent-written title replaces the first-line one wherever it shows.
  const stopTitles = await ipc.onSessionTitle(update => replaceChat(update.projectId, update.sessionId, row => ({ ...row, title: update.title })));
  let disposed = false;
  const visibility = () => { activity.view(viewedProject()); publishActivity(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", visibility);
  window.addEventListener("blur", visibility);
  // Subscribe before reading, so activity in any project reaches its badge
  // even before that project is opened. Reading history never invents a result.
  void ipc.listProjects().then(projects => Promise.all(projects.map(async project => {
    const sessions = await ipc.listSessions(project.id);
    if (disposed) return;
    for (const session of sessions) registerActivitySession(session.id, project.id);
    publishActivity();
  }))).catch(() => { /* Opening a project registers its own conversations. */ });
  return () => {
    disposed = true;
    stopTranscript();
    stopTitles();
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("focus", visibility);
    window.removeEventListener("blur", visibility);
  };
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
