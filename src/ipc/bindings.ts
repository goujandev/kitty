/**
 * The wire types, mirroring `crates/core` and `crates/store`.
 *
 * Checked against the Rust definitions by `scripts/check-contract.mjs`, which
 * runs as part of `npm run check`. Rust writes `contract.json` from its own
 * types; the script proves every tag and field in that file appears here. So
 * renaming a field in Rust without touching this file fails the build.
 */

export type HarnessId = "claude" | "codex";

export interface Version {
  major: number;
  minor: number;
  patch: number;
}

/** Whether the binary is present and usable. */
export type InstallState =
  | { kind: "notFound" }
  | { kind: "found"; path: string; version: Version }
  | {
      kind: "unsupportedVersion";
      path: string;
      found: Version;
      required: Version;
    }
  | { kind: "unidentified"; path: string; output: string }
  | { kind: "probeFailed"; path: string; message: string };

/**
 * Whether the CLI appears to be signed in.
 *
 * `loggedIn` means the stored token has not expired. kitty never refreshes or
 * validates it; only the vendor CLI can do that (ADR-0004).
 */
export type LoginState =
  | { kind: "unknown"; reason: string }
  | { kind: "loggedOut" }
  | { kind: "loggedIn"; plan: string | null; expiresAtMs: number | null }
  | { kind: "expired"; expiredAtMs: number };

/** What to do about a harness that is not ready. */
export interface Hint {
  message: string;
  command: string | null;
  url: string | null;
}

export interface HarnessStatus {
  id: HarnessId;
  label: string;
  vendor: string;
  install: InstallState;
  login: LoginState;
  ready: boolean;
  hint: Hint | null;
  verifiedVersion: Version;
  newerThanVerified: boolean;
  checkedAtMs: number;
}

export interface Scan {
  harnesses: HarnessStatus[];
  durationMs: number;
  pathDirs: number;
}

// ------------------------------------------------------------- transcripts

export type BlockKind = "user" | "assistant" | "reasoning" | "tool";

export interface Block {
  seq: number;
  kind: BlockKind;
  text: string;
  /** JSON detail for rows that need more than a line, i.e. tool activity. */
  meta: string | null;
  createdAt: number;
}

/** How a tool call ended. */
export type ToolStatus = "running" | "ok" | "failed" | "denied";

/** What an agent is asking permission to do. */
export type ApprovalKind = "edit" | "command" | "network" | "other";

/**
 * How a permission request was settled.
 *
 * `cancelled` means resolved without us: the harness decided, or the turn
 * ended first. A real third case, not a synonym for denied.
 */
export type ApprovalOutcome = "allowed" | "denied" | "cancelled";

/** Parsed `Block.meta` for a tool row. */
export interface ToolMeta {
  status: ToolStatus;
  detail: string | null;
}

export function toolMeta(block: Block): ToolMeta {
  if (!block.meta) return { status: "running", detail: null };
  try {
    const parsed = JSON.parse(block.meta) as Partial<ToolMeta>;
    return {
      status: parsed.status ?? "running",
      detail: parsed.detail ?? null,
    };
  } catch {
    // A row we cannot read is still a row; showing it as running is better
    // than dropping it.
    return { status: "running", detail: null };
  }
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface RateLimitWindow {
  label: string;
  /** 0 to 1. */
  utilization: number;
  resetsAtMs: number | null;
}

export type ErrorKind =
  | "auth"
  | "rateLimited"
  | "transient"
  | "invalid"
  | "process"
  | "protocol";

/** Why a turn stopped. */
export type StopReason =
  | { kind: "endTurn" }
  | { kind: "maxTokens" }
  | { kind: "refusal"; category: string | null }
  | { kind: "cancelled" }
  | { kind: "interrupted" }
  | { kind: "failed"; message: string }
  | { kind: "other"; reason: string };

/**
 * What the transcript view is told.
 *
 * Block identity is already resolved by the host, so the UI only appends text
 * to a numbered row. It never has to decide what a transcript is (ADR-0003).
 */
export type TranscriptEvent =
  | { kind: "sessionReady"; model: string | null }
  | { kind: "blockAppended"; seq: number; blockKind: BlockKind; text: string }
  | { kind: "blockDelta"; seq: number; text: string }
  | { kind: "blockFinal"; seq: number; text: string }
  | {
      kind: "toolStatusChanged";
      seq: number;
      status: ToolStatus;
      detail: string | null;
    }
  | {
      kind: "approvalRequested";
      id: string;
      approvalKind: ApprovalKind;
      title: string;
      detail: string | null;
    }
  | { kind: "approvalResolved"; id: string; outcome: ApprovalOutcome }
  | { kind: "turnEnded"; stop: StopReason }
  | { kind: "usage"; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
  | { kind: "context"; used: number | null; window: number | null }
  | { kind: "rateLimits"; windows: RateLimitWindow[] }
  | { kind: "status"; text: string }
  | { kind: "failed"; errorKind: ErrorKind; message: string };

/** One batch of events for one session. */
export interface TranscriptBatch {
  sessionId: string;
  events: TranscriptEvent[];
}

// ------------------------------------------------------ projects & sessions

export interface Project {
  id: string;
  root: string;
  name: string;
  createdAt: number;
  lastOpenedAt: number;
}

export interface SessionRow {
  id: string;
  projectId: string;
  harness: HarnessId;
  model: string | null;
  /** Reasoning effort, when the chosen model accepts one. */
  effort: string | null;
  providerSession: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

/** One model, as its CLI describes it. */
export interface ModelInfo {
  /** What kitty passes back to the CLI to select this model. */
  id: string;
  displayName: string;
  description: string | null;
  /** Effort levels this model accepts. Empty is a real answer, not a gap. */
  efforts: string[];
  defaultEffort: string | null;
  /** The CLI's own default. */
  isDefault: boolean;
}

export interface ModelCatalog {
  harness: HarnessId;
  models: ModelInfo[];
  cliVersion: string;
  fetchedAtMs: number;
}

/** A project with enough context to decide whether to keep it. */
export interface ProjectSummary extends Project {
  sessionCount: number;
  /** False when the folder has been moved or deleted since it was opened. */
  exists: boolean;
}

export interface Hit {
  sessionId: string;
  seq: number;
  snippet: string;
}

// ------------------------------------------------------------------ helpers

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** Plain-English reason a turn stopped, or null when it simply finished. */
export function describeStop(stop: StopReason): string | null {
  switch (stop.kind) {
    case "endTurn":
      return null;
    case "maxTokens":
      return "Stopped at the output limit.";
    case "refusal":
      return stop.category
        ? `Declined (${stop.category}).`
        : "The model declined to answer.";
    case "cancelled":
      return "Stopped.";
    case "interrupted":
      return "The agent exited before finishing.";
    case "failed":
      return stop.message;
    case "other":
      return stop.reason;
    default:
      return assertNever(stop, "StopReason");
  }
}

/**
 * Makes a `switch` over a union exhaustive. If Rust gains a variant and it is
 * added here, every switch that does not handle it stops compiling.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`unhandled ${context}: ${JSON.stringify(value)}`);
}
