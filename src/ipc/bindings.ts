/**
 * The wire types, mirroring `crates/core`.
 *
 * These are checked against the Rust definitions by `scripts/check-contract.mjs`,
 * which runs as part of `npm run check`. Rust writes `contract.json` from its
 * own types; the script proves every tag and field in that file appears here.
 * So renaming a field in Rust without touching this file fails the build.
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

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/**
 * Makes a `switch` over a union exhaustive. If Rust gains a variant and it is
 * added here, every switch that does not handle it stops compiling.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`unhandled ${context}: ${JSON.stringify(value)}`);
}
