# ADR-0003: The session engine lives in Rust

Status: accepted (confirmed by the user, 2026-09-14) — the highest-risk
decision in this plan, accepted with the reassessment point in the last section
kept live

## Context

Something has to own session lifecycle, the turn queue, cancellation, approval
and question queues, resume binding, idle parking, and protocol decode. It can
live in the webview or in the host.

MonoCode puts all of it in TypeScript. Rust spawns the child, reads stdout
line by line, and emits each line as an app-wide Tauri event; the frontend
parses, decodes, and runs the session state machine. That choice buys fast
iteration on undocumented protocols, and MonoCode iterates fast: 47 releases in
25 days with 193 frontend test files.

It also has measurable costs in that codebase:

- Every raw line crosses IPC as a string. Events are emitted app-wide, so in a
  multi-window setup every webview deserializes every line belonging to every
  other window and discards it by session id.
- Harness stdout gets no coalescing at all; one IPC emit per line. The PTY path
  does coalesce, on an 8 ms timer, so the technique was known and not applied.
- Session state ends up owned by the same component tree that renders it, which
  is a large part of how `App.tsx` reached 6,500 lines with sixty refs
  mirroring state.
- Persistence is a round trip back down to Rust, so the frontend hand-rolls
  write-ordering queues, debounces, and a `WeakMap` fingerprint to avoid
  stringifying the transcript on the main thread.
- A headless or remote mode is impossible without reimplementing everything.

## Decision

The engine, the codecs, and persistence live in Rust. The frontend receives
normalized, batched, already-persisted `SessionEvent`s and is presentational.

The IPC contract becomes small and stable: commands to start a session, send a
turn, answer an approval, cancel; events carrying batches of normalized session
events targeted at the owning window. Raw CLI output never crosses the
boundary except into the optional protocol log viewer.

### Why this is right for kitty specifically

- **Performance.** Decode, batch and persist happen once, off the UI thread,
  and the webview receives coalesced normalized events rather than a per-line
  IPC storm. The user named performance as a goal twice.
- **The duplication fix needs a single owner.** ADR-0002 moves turn queues,
  approval queues and cancellation races out of seven adapters into one engine.
  That engine is most useful where the process handles already are.
- **Persistence stops being a round trip.** The engine writes blocks as it
  decodes them. No write-ordering queue in the frontend, no debounce, no
  fingerprint hack, and a crash loses at most one batch.
- **Headless and remote stay possible.** A future daemon, a CLI, or a thin
  remote client is then a second frontend over the same engine rather than a
  rewrite. MonoCode has open requests for running sessions on another machine
  and for a tablet client, and cannot serve them from its current shape.

### What this costs, stated plainly

Protocol adaptation is the core competency of this product and it churns
constantly. Writing codecs in Rust is slower per iteration than in TypeScript,
and slower to debug against a misbehaving CLI. This is a real cost and it is
the main argument for the other choice.

Mitigations, which must actually be built or this decision is wrong:

1. Codecs operate on `serde_json::Value` with small helpers, not on generated
   types per protocol. Shape-matching stays cheap and tolerant.
2. Fixture-driven tests with one-command recording from a live CLI. A codec
   change is: record, run, diff the event stream.
3. A protocol log viewer in the app from early on, so diagnosing a stuck turn
   never requires a rebuild.
4. Unknown frames decode to a `Status` or a debug event and are never fatal.

If, after two codecs are written, iteration genuinely feels worse than the
TypeScript equivalent, the fallback is to move decode alone back to the
frontend while keeping lifecycle, persistence and framing in Rust. The engine
and codec boundary is drawn so that this is possible without touching the event
vocabulary.

## Consequences

- The frontend cannot invent session state; it can only render what the engine
  sent. This is the point.
- The IPC surface stays small. MonoCode has 164 Tauri commands in one flat
  registration block, with a single 6,550-line file holding 53 of them across
  four unrelated concerns; kitty groups commands per crate and keeps the
  session surface narrow.
- Rust is now on the critical path for every protocol fix. The fixture tooling
  is therefore not optional polish; it is a prerequisite.
