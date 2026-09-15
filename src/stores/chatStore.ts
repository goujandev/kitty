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
import { refresh as refreshProjects } from "./projectStore";
import { readyHarnesses } from "./harnessStore";

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
  status: null,
  notice: null,
  usage: null,
  context: null,
  limits: {},
  running: {},
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
  for (const listener of listeners) listener();
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

export async function chooseProject(): Promise<void> {
  try {
    const path = await ipc.pickFolder();
    if (!path) return;
    await useProject(await ipc.openProject(path));
    // The rail is a separate store and has no idea this happened. Without
    // this a folder you just opened is not in the list of folders.
    await refreshProjects();
  } catch (error) {
    set({ error: message(error) });
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
export async function forgetProject(projectId: string): Promise<void> {
  const wasOpen = state.project?.id === projectId;
  try {
    await ipc.removeProject(projectId);
    await refreshProjects();
    if (wasOpen) await newChat();
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Opens a project kitty already knows about, with or without a folder. */
export async function openById(projectId: string): Promise<void> {
  try {
    await useProject(await ipc.openStoredProject(projectId));
    // Opening one moves it to the top, and the rail sorts by that.
    await refreshProjects();
  } catch (error) {
    set({ error: message(error) });
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
    set({ error: message(error) });
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
  try {
    if (state.project?.id !== projectId) {
      const project = (await ipc.listProjects()).find((p) => p.id === projectId);
      if (!project) return;
      // Deliberately not `useProject`: that would open the newest session, and
      // the point here is to open a specific one.
      set({
        project,
        error: null,
        draft: null,
        draftModel: null,
        usage: null,
        context: null,
        approval: null,
      });
      set({ sessions: await ipc.listSessions(projectId) });
    }
    await openSession(sessionId);
  } catch (error) {
    set({ error: message(error) });
  }
}

export async function restoreLastProject(): Promise<void> {
  try {
    // Sweep first, keeping nothing. A chat with no folder and no messages is
    // one that was asked for and walked away from, and restoring it would put
    // the user back in front of a box they already decided not to type into.
    await ipc.pruneChats("").catch(() => 0);
    const projects = await ipc.listProjects();
    if (projects.length > 0 && projects[0]) await useProject(projects[0]);
  } catch (error) {
    set({ error: message(error) });
  }
}

async function useProject(project: Project): Promise<void> {
  set({
    project,
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
  set({ sessions });
  const first = sessions[0];
  if (first) {
    await openSession(first.id);
    return;
  }
  // A project with no folder holds exactly one conversation and has no rail
  // beside it to start one from, so the draft is opened here and the box is
  // ready to type into.
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
  const start = opening();

  if (start) void loadModels(start.harness);
  set({
    draft: start?.harness ?? null,
    draftModel:
      start?.model != null
        ? { model: start.model, effort: start.effort }
        : null,
    activeId: null,
    blocks: [],
    busy: false,
    status: null,
    notice: null,
    usage: null,
    context: null,
    approval: null,
    error: null,
  });
}

/**
 * Forgets one conversation.
 *
 * If it was the one on screen, the next one in the project takes its place --
 * or the project is left empty rather than showing a transcript that is no
 * longer anywhere.
 */
export async function removeSession(sessionId: string): Promise<void> {
  try {
    await ipc.deleteSession(sessionId);
    const left = state.sessions.filter((s) => s.id !== sessionId);
    set({ sessions: left });

    if (state.activeId !== sessionId) return;
    const next = left[0];
    if (next) {
      await openSession(next.id);
      return;
    }
    set({ activeId: null, blocks: [], busy: false, approval: null });
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Switches to a session, reloading its transcript from the database. */
export async function openSession(sessionId: string): Promise<void> {
  set({
    activeId: sessionId,
    draft: null,
    draftModel: null,
    blocks: [],
    busy: false,
    status: null,
    notice: null,
    usage: null,
    context: null,
    approval: null,
    runningModel: null,
    error: null,
    loading: true,
  });

  const harness = state.sessions.find((s) => s.id === sessionId)?.harness;
  if (harness === "claude" || harness === "codex") void loadModels(harness);

  try {
    const blocks = await ipc.sessionBlocks(sessionId);
    // Guard against a slower load landing after the user moved on.
    if (state.activeId !== sessionId) return;
    set({ blocks, loading: false });

    await ipc.startSession(sessionId);
  } catch (error) {
    if (state.activeId === sessionId) {
      set({ error: message(error), loading: false });
    }
  }
}

export async function send(text: string): Promise<void> {
  if (state.busy) return;

  const trimmed = text.trimEnd();
  if (!trimmed) return;

  set({ busy: true, notice: null, error: null, status: null });
  try {
    // A draft becomes a real session here, on the first message and not
    // before.
    const sessionId = state.activeId ?? (await commitDraft());
    if (!sessionId) {
      set({ busy: false });
      return;
    }

    // Marked before the round trip, not after. A turn that finished first
    // would otherwise clear a flag that had not been set yet, and then the
    // flag would be set, and the row would spin for ever.
    if (state.project) {
      set({ running: { ...state.running, [sessionId]: state.project.id } });
    }
    const seq = await ipc.sendTurn(sessionId, trimmed);
    // Show it immediately rather than waiting for a round trip.
    appendLocalBlock({
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
    if (state.activeId) markIdle(state.activeId);
    set({ busy: false, error: message(error) });
  }
}

/** Marks a conversation as no longer working. */
function markIdle(sessionId: string): void {
  if (!(sessionId in state.running)) return;
  const running = { ...state.running };
  delete running[sessionId];
  set({ running });
}

/** Turns the chosen agent into a real session. Returns its id. */
async function commitDraft(): Promise<string | null> {
  const { project, draft } = state;
  if (!project || !draft) return null;

  const session = await ipc.createSession(project.id, draft);
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
    set({ sessions: await ipc.listSessions(project.id) });
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
  return ipc.onTranscript((batch: TranscriptBatch) => {
    // Whether a turn has finished is read from every batch, not just the open
    // conversation's: the rails show which conversations are working, and one
    // you are not looking at is exactly the case that needs saying.
    for (const event of batch.events) {
      if (event.kind === "turnEnded" || event.kind === "failed") {
        markIdle(batch.sessionId);
      }
    }
    // The transcript itself is only rebuilt for the one on screen.
    if (batch.sessionId !== state.activeId) return;
    for (const event of batch.events) apply(event);
  });
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
