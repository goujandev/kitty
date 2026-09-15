/**
 * Typed wrappers over the Tauri commands.
 *
 * Every `invoke` in the app goes through here, so there is exactly one place
 * where a command name is spelled and one place where its result is typed.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  Block,
  HarnessId,
  Hit,
  Project,
  Scan,
  SessionRow,
  TranscriptBatch,
} from "./bindings";

/** The event the host emits for every session. */
const TRANSCRIPT_EVENT = "kitty://transcript";

// -------------------------------------------------------------- harnesses

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

// --------------------------------------------------------------- projects

/** Opens the native folder picker. Null means the user cancelled. */
export function pickFolder(): Promise<string | null> {
  return invoke<string | null>("pick_folder");
}

export function openProject(path: string): Promise<Project> {
  return invoke<Project>("open_project", { path });
}

export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

/** Drops sessions that were opened and never used. Returns how many. */
export function pruneSessions(projectId: string): Promise<number> {
  return invoke<number>("prune_sessions", { projectId });
}

// --------------------------------------------------------------- sessions

export function listSessions(projectId: string): Promise<SessionRow[]> {
  return invoke<SessionRow[]>("list_sessions", { projectId });
}

export function createSession(
  projectId: string,
  harness: HarnessId,
): Promise<SessionRow> {
  return invoke<SessionRow>("create_session", { projectId, harness });
}

export function sessionBlocks(sessionId: string): Promise<Block[]> {
  return invoke<Block[]>("session_blocks", { sessionId });
}

/** Starts the CLI for a session. Safe to call on an already-running one. */
export function startSession(sessionId: string): Promise<void> {
  return invoke<void>("start_session", { sessionId });
}

/** Sends a turn. Resolves with the sequence number of the user's block. */
export function sendTurn(sessionId: string, text: string): Promise<number> {
  return invoke<number>("send_turn", { sessionId, text });
}

/** Answers a permission request. */
export function respondApproval(
  sessionId: string,
  id: string,
  allow: boolean,
): Promise<void> {
  return invoke<void>("respond_approval", { sessionId, id, allow });
}

export function cancelTurn(sessionId: string): Promise<void> {
  return invoke<void>("cancel_turn", { sessionId });
}

export function stopSession(sessionId: string): Promise<void> {
  return invoke<void>("stop_session", { sessionId });
}

export function search(query: string): Promise<Hit[]> {
  return invoke<Hit[]>("search", { query });
}

/**
 * Subscribes to transcript batches.
 *
 * Events arrive pre-batched by the host on a short timer, so a burst of tokens
 * crosses IPC once rather than once per token.
 */
export function onTranscript(
  handler: (batch: TranscriptBatch) => void,
): Promise<UnlistenFn> {
  return listen<TranscriptBatch>(TRANSCRIPT_EVENT, (event) =>
    handler(event.payload),
  );
}
