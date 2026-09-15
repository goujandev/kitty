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
  type Project,
  type RateLimitWindow,
  type SessionRow,
  type TranscriptBatch,
  type TranscriptEvent,
  type Usage,
  describeStop,
} from "../ipc/bindings";
import * as ipc from "../ipc/commands";

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
  limits: RateLimitWindow[];
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
  limits: [],
  approval: null,
  catalogs: {},
  favourites: {},
  runningModel: null,
  draftModel: null,
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
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Opens a folder kitty already knows about. */
export async function openByRoot(root: string): Promise<void> {
  try {
    await useProject(await ipc.openProject(root));
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
        limits: [],
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
    limits: [],
    usage: null,
    context: null,
    approval: null,
  });
  // Tidy before listing, so abandoned sessions never appear at all.
  await ipc.pruneSessions(project.id).catch(() => 0);
  const sessions = await ipc.listSessions(project.id);
  set({ sessions });
  const first = sessions[0];
  if (first) await openSession(first.id);
}

/**
 * Chooses an agent for a conversation that does not exist yet.
 *
 * Nothing is written until the first message, so clicking through the agents
 * leaves no empty sessions behind.
 */
export function newSession(harness: HarnessId): void {
  if (!state.project) return;
  void loadModels(harness);
  set({
    draft: harness,
    draftModel: null,
    activeId: null,
    blocks: [],
    busy: false,
    status: null,
    notice: null,
    usage: null,
    context: null,
    limits: [],
    approval: null,
    error: null,
  });
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
    // Usage windows belong to whichever agent is speaking. Carrying Claude's
    // numbers into a Codex session is worse than showing none.
    limits: [],
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

    const seq = await ipc.sendTurn(sessionId, trimmed);
    // Show it immediately rather than waiting for a round trip.
    appendLocalBlock({
      seq,
      kind: "user",
      text: trimmed,
      meta: null,
      createdAt: Date.now(),
    });
    // The title is derived from the first message, so refresh the list.
    void refreshSessions();
  } catch (error) {
    set({ busy: false, error: message(error) });
  }
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
  model: string,
  effort: string | null,
): Promise<void> {
  if (state.draft) {
    set({ draftModel: { model, effort } });
    return;
  }
  const { activeId } = state;
  if (!activeId) return;

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

    case "rateLimits":
      set({ limits: event.windows });
      return;

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
    // Batches for other sessions are the host's business, not ours.
    if (batch.sessionId !== state.activeId) return;
    for (const event of batch.events) apply(event);
  });
}
