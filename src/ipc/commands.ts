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
  ModelCatalog,
  ModelChoice,
  Project,
  ProjectSummary,
  RailWidths,
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

// ------------------------------------------------------------- appearance

/** How the window is painted. */
export type Theme = "system" | "light" | "dark";

export function theme(): Promise<Theme> {
  return invoke<Theme>("theme");
}

export function setTheme(next: Theme): Promise<void> {
  return invoke<void>("set_theme", { theme: next });
}

/** How far the window is zoomed. 1 is unscaled. */
export function zoom(): Promise<number> {
  return invoke<number>("zoom");
}

/** Saves a zoom level, clamped by the host. Resolves with what was stored. */
export function setZoom(factor: number): Promise<number> {
  return invoke<number>("set_zoom", { factor });
}

/** How wide each rail is. Clamped by the host. */
export function railWidths(): Promise<RailWidths> {
  return invoke<RailWidths>("rail_widths");
}

export function setRailWidths(widths: RailWidths): Promise<void> {
  return invoke<void>("set_rail_widths", { widths });
}

/** Opens the picker for a background image. Null means the user cancelled. */
export function pickImage(): Promise<string | null> {
  return invoke<string | null>("pick_image");
}

/**
 * Adopts an image as the background, returning it as a data URL.
 *
 * The file is copied into kitty's own folder, so moving or deleting the
 * original afterwards does not take the background with it.
 */
export function setBackground(path: string): Promise<string> {
  return invoke<string>("set_background", { path });
}

/** The background as a data URL, or null if there is not one. */
export function background(): Promise<string | null> {
  return invoke<string | null>("background");
}

export function clearBackground(): Promise<void> {
  return invoke<void>("clear_background");
}

// --------------------------------------------------------------- projects

export function openProject(path: string): Promise<Project> {
  return invoke<Project>("open_project", { path });
}

/** Opens a project already in the list. Works with or without a folder. */
export function openStoredProject(projectId: string): Promise<Project> {
  return invoke<Project>("open_stored_project", { projectId });
}

/**
 * Starts a conversation with no codebase behind it.
 *
 * It is a project like any other as far as the rest of the app is concerned;
 * it just has no folder, so nothing is read from disk that was not typed in.
 */
export function newChat(): Promise<Project> {
  return invoke<Project>("new_chat");
}

/** Forgets folderless chats that were opened and never used. */
export function pruneChats(keep: string): Promise<number> {
  return invoke<number>("prune_chats", { keep });
}

export function listProjects(): Promise<Project[]> {
  return invoke<Project[]>("list_projects");
}

/** Projects with session counts, for the projects screen. */
export function listProjectSummaries(): Promise<ProjectSummary[]> {
  return invoke<ProjectSummary[]>("list_project_summaries");
}

/** Saves the order a rail was dragged into, top first. */
export function reorderProjects(ids: string[]): Promise<void> {
  return invoke<void>("reorder_projects", { ids });
}

export function reorderSessions(ids: string[]): Promise<void> {
  return invoke<void>("reorder_sessions", { ids });
}

/** Forgets a project and every conversation in it. */
export function removeProject(projectId: string): Promise<void> {
  return invoke<void>("remove_project", { projectId });
}

/** Drops sessions that were opened and never used. Returns how many. */
export function pruneSessions(projectId: string): Promise<number> {
  return invoke<number>("prune_sessions", { projectId });
}

// ----------------------------------------------------------------- models

/**
 * Lists the models a harness can run.
 *
 * Served from a cache stamped with the CLI's version, so upgrading the CLI
 * picks up models it added. `refresh` forces a fresh probe.
 */
export function listModels(
  harness: HarnessId,
  refresh = false,
): Promise<ModelCatalog> {
  return invoke<ModelCatalog>("list_models", { harness, refresh });
}

/** The model a new conversation starts with, or null if none is chosen. */
export function defaultModel(): Promise<ModelChoice | null> {
  return invoke<ModelChoice | null>("default_model");
}

/** Sets that model, or clears it with null. */
export function setDefaultModel(choice: ModelChoice | null): Promise<void> {
  return invoke<void>("set_default_model", { choice });
}

/** Model ids the user has starred, for this harness. */
export function favouriteModels(harness: HarnessId): Promise<string[]> {
  return invoke<string[]>("favourite_models", { harness });
}

/** Stars a model, or unstars one already starred. Returns the new list. */
export function toggleFavouriteModel(
  harness: HarnessId,
  model: string,
): Promise<string[]> {
  return invoke<string[]>("toggle_favourite_model", { harness, model });
}

/** Changes a session's model. Restarts the CLI, resuming its history. */
export function setSessionModel(
  sessionId: string,
  model: string,
  effort: string | null,
): Promise<void> {
  return invoke<void>("set_session_model", { sessionId, model, effort });
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

/** Forgets one conversation and its transcript. */
export function deleteSession(sessionId: string): Promise<void> {
  return invoke<void>("delete_session", { sessionId });
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
