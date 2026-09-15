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
  type Block,
  type HarnessId,
  type Project,
  type RateLimitWindow,
  type SessionRow,
  type TranscriptBatch,
  type TranscriptEvent,
  type Usage,
  describeStop,
} from "../ipc/bindings";
import * as ipc from "../ipc/commands";

export interface ChatState {
  project: Project | null;
  sessions: SessionRow[];
  activeId: string | null;
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
  error: string | null;
  loading: boolean;
}

const EMPTY: ChatState = {
  project: null,
  sessions: [],
  activeId: null,
  blocks: [],
  busy: false,
  status: null,
  notice: null,
  usage: null,
  context: null,
  limits: [],
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

export async function restoreLastProject(): Promise<void> {
  try {
    const projects = await ipc.listProjects();
    if (projects.length > 0 && projects[0]) await useProject(projects[0]);
  } catch (error) {
    set({ error: message(error) });
  }
}

async function useProject(project: Project): Promise<void> {
  set({ project, error: null, sessions: [], activeId: null, blocks: [] });
  const sessions = await ipc.listSessions(project.id);
  set({ sessions });
  const first = sessions[0];
  if (first) await openSession(first.id);
}

export async function newSession(harness: HarnessId): Promise<void> {
  const { project } = state;
  if (!project) return;
  try {
    const session = await ipc.createSession(project.id, harness);
    set({ sessions: [session, ...state.sessions] });
    await openSession(session.id);
  } catch (error) {
    set({ error: message(error) });
  }
}

/** Switches to a session, reloading its transcript from the database. */
export async function openSession(sessionId: string): Promise<void> {
  set({
    activeId: sessionId,
    blocks: [],
    busy: false,
    status: null,
    notice: null,
    usage: null,
    context: null,
    error: null,
    loading: true,
  });

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
  const { activeId } = state;
  if (!activeId || state.busy) return;

  const trimmed = text.trimEnd();
  if (!trimmed) return;

  set({ busy: true, notice: null, error: null, status: null });
  try {
    const seq = await ipc.sendTurn(activeId, trimmed);
    // Show it immediately rather than waiting for a round trip.
    appendLocalBlock({
      seq,
      kind: "user",
      text: trimmed,
      createdAt: Date.now(),
    });
    // The title is derived from the first message, so refresh the list.
    void refreshSessions();
  } catch (error) {
    set({ busy: false, error: message(error) });
  }
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
      return;

    case "blockAppended":
      appendLocalBlock({
        seq: event.seq,
        kind: event.blockKind,
        text: event.text,
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

    case "turnEnded":
      set({ busy: false, status: null, notice: describeStop(event.stop) });
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
      set({ busy: false, error: event.message });
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
