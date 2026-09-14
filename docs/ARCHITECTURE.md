# kitty — Architecture

kitty is a desktop application that drives coding-agent CLIs you have already
installed and logged into. It does not call model APIs and it does not sell
tokens. You open a project, pick an agent, and talk to it.

This is the top-level design. Decisions with real trade-offs are in `adr/`.
The evidence behind them is in `LESSONS-FROM-MONOCODE.md`, a close read of the
closest existing product. Prototype scope is in `PROTOTYPE-1.md`.

Status: planning. No code exists yet. Types below illustrate boundaries; they
are not final signatures.

---

## 1. What kitty is

An agent is a vendor CLI: `claude`, `codex`, and later others. kitty spawns it
as a child process, speaks its wire protocol over stdio, normalizes what comes
back into one event vocabulary, and renders it.

This choice is the whole product. It means:

- **Auth is not our problem.** If `claude` and `codex` are logged in, kitty
  works. No API keys, no OAuth flow, no token storage.
- **Every model is available for free.** We ask each CLI what it can run. The
  answer is authoritative for that subscription, and it is current without us
  shipping an update.
- **Tools, sandboxing, permissions and context management belong to the CLI.**
  We render approvals and relay the user's answer. We do not execute tools.
- **The cost is coupling.** We depend on undocumented, unversioned CLI
  surfaces that change weekly. Containing that coupling is the central
  engineering problem, and §4 is mostly about it.

## 2. Goals

1. **Adding a harness is cheap and safe.** One manifest, one codec, fixtures.
   Not nineteen files and five hand-written if-chains.
2. **The UI never stutters.** Streaming at full rate must not drop frames, and
   a long transcript must not get slower as it grows.
3. **Nothing is silently lost.** Not a stream byte, not a settings key, not a
   session after a crash. Failures surface as errors, never as silence.
4. **Never touch another tool's credentials.** Read-only, or ask the CLI.
5. **Windows is the only target.** No macOS, no Linux, no abstraction layer
   anticipating them. Platform code is written directly against Win32.

Explicit non-goals for now: owning an agent loop, a plugin marketplace, mobile,
cloud sync, telemetry.

---

## 3. System shape

```
┌───────────────────────────────────────────────────────────────┐
│  Frontend (webview)                                           │
│    views/      presentational components, virtualized list    │
│    stores/     external stores + selectors (ADR-0006)         │
│    ipc/        typed command + event bindings (generated)     │
├───────────────────────────────────────────────────────────────┤
│  IPC boundary: typed commands, batched per-window events      │
├───────────────────────────────────────────────────────────────┤
│  Rust host                                                    │
│                                                               │
│    engine/     session lifecycle, turn queue, approvals,      │
│                cancellation, resume, idle park   ← generic    │
│    harness/    manifest + codec per CLI          ← thin       │
│      transport/  stdio-lines, jsonrpc, acp, loopback-sse      │
│    catalog/    model discovery + cache                        │
│    supervisor/ spawn, framing, kill trees, orphan reaping     │
│    store/      SQLite: projects, sessions, blocks, settings   │
│    vcs/        git, gh                                        │
│    files/      fs, search, watch                              │
│    probe/      CLI discovery, availability, usage             │
├───────────────────────────────────────────────────────────────┤
│  core/         domain types, the event vocabulary. No I/O.    │
└───────────────────────────────────────────────────────────────┘
```

Dependency rule: arrows point down. `core` depends on nothing. `engine`
depends on `core` and `harness`; `harness` depends on `core` and `transport`.
Nothing below the IPC boundary knows the frontend exists. Enforced by crate
boundaries, not convention.

The load-bearing decision is that **the engine is in Rust, not the frontend**
(ADR-0003). MonoCode puts all protocol and session logic in TypeScript, which
sends every raw CLI line across IPC to every window and re-implements the same
session state machine seven times. Putting it in Rust means the frontend
receives normalized, batched, already-persisted events and is purely
presentational, and it leaves the door open to a headless or remote mode later
without a rewrite.

---

## 4. The harness layer

### 4.1 One manifest per harness

Everything that varies between CLIs is data in one place, not branches spread
across the codebase.

```rust
struct HarnessManifest {
    id: HarnessId,                  // "claude"
    label: &'static str,            // "Claude Code"
    binary: BinarySpec,             // candidate paths, identity check
    transport: TransportKind,       // StdioLines | JsonRpc | Acp | LoopbackHttp
    launch: LaunchSpec,             // argv template, env, cwd rules
    capabilities: Capabilities,     // declarative, see 4.3
    catalog: CatalogSpec,           // how to enumerate models
    quirks: Vec<Quirk>,             // version gates, per-model overrides
}
```

Adding a harness is: one manifest, one codec, one fixture directory. The
registry is built by iterating manifests, so there is no `HarnessId` union to
extend in eleven other files and no icon record to forget.

### 4.2 The codec is the only hand-written part

```rust
trait Codec {
    /// Wire frame -> zero or more normalized events.
    fn decode(&mut self, frame: Frame, cx: &mut DecodeCx) -> Vec<SessionEvent>;
    /// A user turn, an approval answer, a cancel -> wire frames.
    fn encode(&mut self, action: Action, cx: &EncodeCx) -> Vec<Frame>;
}
```

A codec is a pure-ish function over JSON values with a small amount of
per-session decode state (in-flight tool calls, partial argument JSON). It owns
no process handles, no timers, no turn queue, no approval queue. Those belong
to the engine. This is the direct fix for MonoCode's biggest structural
problem: seven adapter files of roughly a thousand lines each, independently
re-implementing turn serialization, the "turn completed before the caller
registered its resolver" race, mute flags, and approval-queue bookkeeping.

### 4.3 Capabilities are declared, not discovered by probing for methods

```rust
struct Capabilities {
    steer: bool,             // inject into a running turn
    compact: bool,           // context compaction command
    attachments: Attachments,// None | LocalPath | Inline { mime: &[&str] }
    questions: bool,         // structured user questions
    plan_mode: bool,
    subagents: bool,
    resume: ResumeKind,      // None | ProviderId | ClientId
    delta: DeltaMode,        // Append | Snapshot  ← see 4.4
    effort: EffortSpec,
}
```

MonoCode expresses this as optional interface methods (`compactContext?`,
`canSteer?`) that callers probe for individually. A record is cheaper to read,
testable, and can be rendered directly into the UI's enabled/disabled states.

### 4.4 Delta semantics are declared, never inferred

Some CLIs stream incremental tokens. Some resend the whole message so far.
Whether a harness appends or snapshots is a fixed property of its protocol.

MonoCode infers it per chunk by comparing strings: equal means snapshot, a
longer string with the current text as a prefix means snapshot, otherwise
append. That heuristic is why two consecutive identical deltas silently
collapse, and it is the architectural cause behind upstream reports of dropped
spaces between words and lost blank lines between paragraphs.

kitty puts `DeltaMode` in the manifest and applies the matching rule with no
inspection of content. Whitespace-only chunks are content and are never
dropped. When a completed message arrives after tokens, the engine emits only
the suffix, computed by length, not by similarity.

### 4.5 Version gates and quirks are a table

CLI behaviour differs by version: a model needs a minimum CLI version, an
effort level maps to a different name, a warning line should be suppressed.
These go in `quirks` as data with an explicit version range. They do not go in
control flow, and a quirk never matches on an English message body, because
upstream rewording should not be able to break us.

We also record, per manifest, the CLI version range the codec was verified
against, and surface a warning in the UI when the installed CLI is outside it.
Unknown-but-newer is a warning, not a refusal.

---

## 5. The session engine

Generic, harness-independent, one implementation.

**Responsibilities.** Session lifecycle and readiness; a serialized turn queue
per session; cancellation, including the cancel-before-spawn race; the approval
and question queues, including a third `Cancelled` outcome for when the CLI
resolves a request itself; resume binding; idle parking; persistence; emitting
batched events to the owning window.

**Turn model.**

```
idle → starting → ready → turn{running} → turn{settling} → ready → parked
                                ↘ cancelled ↗
```

A turn settles only when the codec reports terminal status *and* the engine's
own bookkeeping agrees. The "completion arrived before we were listening" race
is solved once, here.

**Idle parking.** After a turn settles, the child stays warm for a few minutes,
then is stopped while its resume handle is retained. The next prompt respawns
and resumes. MonoCode's version of this has an open bug where parking kills a
session that still had background work running, so parking in kitty is gated on
the engine believing nothing is in flight, and the CLI's own background-task
signals feed that belief.

**Cancellation** is in-band first, by protocol interrupt. Killing the process
is the escalation, not the mechanism.

**Everything the engine emits is persisted before it is rendered**, so a crash
loses at most the current batch.

---

## 6. The event vocabulary

The single most important type in the system. The UI branches on event type,
never on harness id.

```rust
enum SessionEvent {
    // lifecycle
    Started, Ready { provider_session: Option<String> }, Ended { code },
    Error { kind: ErrorKind, message: String, retryable: bool },
    ConfigChanged { model, settings },

    // content
    MessageDelta { text }, MessageDone,
    ReasoningDelta { text }, ReasoningDone,

    // work
    ToolStarted { call, title, kind, paths, preview },
    ToolUpdated { call, status, detail, preview },
    AgentStep { parent: CallId, step: StepId, kind, text },

    // interaction
    ApprovalRequested { id, title, kind, preview },
    ApprovalResolved  { id, outcome: Allow | Deny | Cancelled },
    QuestionAsked { id, questions }, QuestionResolved { id, outcome },

    // structure
    TasksUpdated { items, merge }, Plan { text, streaming },

    // accounting
    Context { used, window },
    TurnMetrics { input, output, cache_read, cache_write },
    Status { text },
}
```

This mirrors MonoCode's `HarnessEvent`, which is the part of that codebase most
worth copying: seven very different wire protocols genuinely do collapse into
one vocabulary, and outside its harness directory the UI branches on harness id
only for icons.

Two deliberate additions. `Error` carries a structured kind and a retryable
flag, so the UI can say something useful rather than going quiet. And every
event carries the session id and a monotonic sequence number, so batching,
persistence and replay are all ordered without inference.

---

## 7. Process supervision

The part that is genuinely hard, especially on Windows.

- **Framing is byte-oriented with a hard cap**, not `lines()` over a `String`.
  A frame over the cap is truncated and reported as an error event; it never
  allocates without bound. Invalid UTF-8 is replaced lossily. A decode error
  never terminates the reader, because MonoCode's reader breaks its loop on the
  first error and the session goes mute with nothing surfaced.
- **Coalescing happens at the source.** Frames are batched on a short timer and
  emitted once per batch, targeted at the owning window with `emit_to`.
  MonoCode emits one app-wide event per line, so in a multi-window setup every
  webview deserializes every line belonging to every other window.
- **Writes are async** and never block an IPC worker on a child that has
  stopped draining its stdin.
- **Process trees are job objects.** Every child is assigned to a job at
  creation via `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so a CLI's startup script
  cannot spawn descendants that escape it. Killing a session closes the job
  handle; there is no signal escalation ladder and no `taskkill`. This is the
  one kill implementation in the codebase. MonoCode has two, written against
  signals with a Windows special case bolted on, and they have already drifted
  in timeout and signal choice.
- Children are created with `CREATE_NO_WINDOW`, so no console window flashes,
  and `CREATE_NEW_PROCESS_GROUP`.
- **Orphan reaping at launch**: children carry a parent-pid marker in their
  environment, and we sweep for markers whose parent is gone. This covers the
  case where kitty was killed hard enough that job cleanup did not run.
- **`PATH` is resolved at launch and refreshable on demand.** Windows hands a
  GUI process the `PATH` that existed when it started, so installing a CLI
  while kitty is running leaves it invisible. We re-read the user and machine
  environment on demand rather than making the user restart the app, and CLIs
  installed through npm land in `%APPDATA%\npm`, which is a candidate path in
  its own right.
- **CLI identity is established by structured means** — a version subcommand
  with parseable output, or a known path — not by running `--help` and
  string-matching its prose, which is what MonoCode does in three near-
  identical functions.

---

## 8. Storage

SQLite, WAL, one file. The frontend does not own durable state.

```
projects (id, root, name, created_at, last_opened_at, settings_json)
sessions (id, project_id, harness, model, model_settings, runtime_mode,
          title, provider_session, status, created_at, updated_at, ...)
blocks   (session_id, seq, kind, payload)      -- one row per block
blocks_fts                                      -- FTS5 over text
settings (scope, key, value)                    -- global | project | session
turns    (session_id, seq, metrics...)
```

Three decisions that differ from MonoCode, each fixing a measured problem:

1. **Blocks are rows, not one `blocks_json` column.** A blob column forces a
   full rewrite of a multi-megabyte array on every save. MonoCode fights this
   with a `WeakMap` fingerprint to avoid stringifying the transcript on the
   main thread, and with a fourteen-column covering index rebuilt three times
   to avoid walking past the blob's overflow pages. Rows make all of that
   unnecessary.
2. **Search is FTS5 from day one.** MonoCode's session search is a full-table
   `LIKE` over every lowercased transcript, capped by a scan limit and a
   `truncated` flag.
3. **Settings live in SQLite, not `localStorage`.** MonoCode keeps 56
   `localStorage` keys the Rust side cannot see, which is why session folders,
   archived projects and default models do not survive a window transfer and
   vanish if webview storage is cleared while the database survives.

Projects are first-class rows with a stable id. MonoCode identifies a project
by its path string, so renaming or moving a folder orphans its sessions.

Migrations are forward-only and version numbers are never reused. MonoCode
carries a repair loop and defensive column checks specifically because reused
version numbers corrupted real users' databases.

Connection access is pooled by role rather than one global mutex behind which
every command in the app queues.

---

## 9. Credentials

kitty never writes another tool's credential store and never impersonates
another client.

Concretely: no writing to `%USERPROFILE%\.claude\.credentials.json` or
`%USERPROFILE%\.codex\auth.json`, no performing the refresh-token grant, no
sending a vendor `User-Agent` or a vendor OAuth client id. MonoCode does all
four for its usage meter. Rotating a token in a file a running `claude` process
also owns is
a corruption and surprise-logout hazard, and upstream has an open pull request
titled "stop rotating Claude's OAuth token".

Usage and rate-limit data is obtained by asking the CLI, which is what MonoCode
already does for Codex via its app-server. Where no such command exists, kitty
reads the credential file read-only to display status, and if the token is
expired it says so and tells you which command refreshes it. Details in
ADR-0004.

---

## 10. Frontend

React with external stores and selector subscriptions. The frontend renders;
it does not own session state.

The failure mode to avoid is concrete and measured. MonoCode's `App.tsx` is a
single 6,500-line component with 36 `useState`, 57 `useRef`, 151 `useCallback`,
36 `useEffect` and zero `useReducer`; roughly sixty refs mirror state and are
written during render; the sidebar takes 76 props; the pane props are a
32-key object literal rebuilt inline on every render, which defeats the `memo`
on every pane below it. Any session update re-renders the whole monolith, and
that is the hot path during streaming.

kitty's rules:

- Session state lives in the Rust store and is mirrored into one frontend store
  updated by batched engine events. Components subscribe to selectors.
- The transcript is virtualized from the first commit, not retrofitted.
- Streaming text updates the smallest possible subtree.
- No component takes more than a handful of props. If it needs more, it should
  be reading from a store.
- No state mirrored into refs. If something needs a stable identity, it belongs
  in the store.

Worth copying from MonoCode: batching events on `requestAnimationFrame` with a
timer fallback when the document is hidden, letting approvals and questions
bypass the batch for latency, and using `content-visibility` on off-screen
transcript turns.

---

## 11. Model catalog

Ask each CLI what it can run. See `MODEL-CATALOG.md`. In short: live discovery
is authoritative, a small seed list covers first paint before a probe returns,
the catalog is cached per harness with a version stamp, and the user can always
type a model id the probe did not return, because new models ship faster than
either the CLIs or we do.

---

## 12. Errors and observability

- Errors are typed at the boundary and carry a retryable flag. Every failure
  path ends in a `SessionEvent::Error`, never in silence.
- A raw protocol log per session, off by default, viewable in-app. When the
  whole product is protocol adaptation across several CLIs, a user with a stuck
  turn needs to see the stream. MonoCode has no such view and its changelog
  shows diagnostics being deliberately hidden from the transcript.
- Structured logs to disk, tokens never logged.
- `kitty doctor`: resolved paths, which CLIs were found and at what version,
  which are logged in, catalog cache state.

---

## 13. Testing

- `core`, `engine`: unit tests. The engine's turn/cancel/approval state machine
  is table-driven and harness-free.
- `harness`: fixture-driven. Every codec ships recorded transcripts from a real
  CLI, replayed through `decode`, asserted against expected events. Recording
  new fixtures must be a single command, because this is where regressions will
  come from.
- `supervisor`: process lifecycle tests including job-object kill-tree and
  orphan reaping, exercised with a fixture CLI whose startup script spawns a
  grandchild.
- `store`: migration tests from every historical schema version.
- Frontend: store logic unit-tested; a small number of component tests.
- CI on Windows with `clippy -D warnings`, `fmt`, `tsc --noEmit`, and both test
  suites. MonoCode gates on exactly this set and it is clearly why a codebase
  that young is as coherent as it is.

---

## 14. Repository layout

Crates marked *planned* do not exist yet; they arrive with the slice that needs
them (`PROTOTYPE-1.md`).

```
kitty/
  Cargo.toml                   workspace
  crates/
    core/                      domain types, manifests, SessionEvent
    probe/                     CLI discovery, identity, login state
    transport/                 stdio framing, jsonrpc, acp        (planned)
    harness/                   manifests + codecs, one per CLI    (planned)
    engine/                    session lifecycle, turns, approvals (planned)
    supervisor/                spawn, job objects, orphan reaping (planned)
    catalog/                   model discovery + cache            (planned)
    store/                     SQLite, migrations, FTS            (planned)
    vcs/  files/                                                  (planned)
  src-tauri/                   Tauri host: commands, events, wiring
  src/                         frontend
    ipc/                       bindings.ts, contract.json, commands.ts
    stores/                    external stores (ADR-0006)
    views/                     presentational components
  scripts/                     check-contract.mjs
  fixtures/                    recorded CLI transcripts per harness (planned)
  docs/
```
