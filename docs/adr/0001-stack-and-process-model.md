# ADR-0001: Stack and process model

Status: accepted (confirmed by the user, 2026-09-14)

## Context

kitty is a desktop GUI that drives coding-agent CLIs. It needs native child
process control including process-tree kill on Windows, a rich text and code
surface (transcript, diffs, editor, terminal), SQLite, and low idle cost.

The user confirmed two things directly: kitty should be a desktop GUI, and it
should get inference the way MonoCode does, by driving the vendor CLIs.

## Decision

**Tauri 2, with a Rust host and a TypeScript webview frontend.**

- Rust: `tokio`, `rusqlite` (bundled, WAL), `serde`, `thiserror`, `tracing`.
- Frontend: TypeScript, React 19, Vite, Tailwind.
- CodeMirror 6 for editing, xterm.js for terminals. Both are framework-neutral.
- Native child processes via `std::process` / `tokio::process` plus
  platform-specific job-object and process-group handling.

The alternative stacks were Electron, which costs a bundled Chromium and gives
no benefit here since the heavy work is native, and a native toolkit, which
costs far more UI work for a text-dense app. Tauri is what MonoCode uses, and
that choice is validated by a 25k-line Rust host and a 147k-line TypeScript
frontend shipping as a real product.

On Windows, Tauri renders through WebView2. The installer must bootstrap the
runtime when it is missing, which MonoCode's NSIS bundle already does.

### Frontend framework

React is the recommendation, but it is the weakest part of this ADR and worth
revisiting before the transcript is built. The specific risk is that React
makes it easy to build exactly what MonoCode built: a God component whose every
update re-renders the world during streaming.

Solid is the credible alternative. Fine-grained signals would make
high-frequency streaming into a long transcript a non-issue without
memoization discipline, and the two big dependencies here, CodeMirror and
xterm.js, are vanilla and work either way. It loses on ecosystem, hiring and
familiarity.

The decision is React **conditional on ADR-0006**: an external store with
selector subscriptions, a virtualized transcript from the first commit, and no
component holding session state. If those rules are not honoured, the framework
choice will not save us. MonoCode's problem was never React; it was that core
state never left the component that first held it.

### Process model

One host process. Each agent session is a child process over pipes, never a
PTY. The PTY subsystem exists separately for the user's integrated terminal,
and no agent ever runs on it. This mirrors MonoCode and is correct: agent CLIs
in stream/RPC mode want clean pipes, and a PTY would inject terminal control
sequences into the protocol.

### Windows is the only target

kitty targets Windows and nothing else. There is no macOS or Linux support, no
abstraction layer anticipating them, and no CI matrix. Platform code is written
directly against the Win32 APIs that do the job.

That means: job objects assigned at process creation via
`PROC_THREAD_ATTRIBUTE_JOB_LIST`, `CREATE_NO_WINDOW` so no console flashes,
`CREATE_NEW_PROCESS_GROUP`, and tree termination by closing the job handle
rather than shelling out to `taskkill`. MonoCode needed a patched
`portable-pty` to get atomic job assignment during `CreateProcessW`; we treat
that as a known requirement rather than a discovery.

If another platform is ever wanted, the places that would need work are named
in ARCHITECTURE.md §7 and ADR-0004. Nothing else in the design assumes Windows,
so that port is a contained job rather than a rewrite. We are simply not paying
for it now.

## Consequences

- Two languages and one IPC boundary to keep typed. We generate the TypeScript
  command and event bindings from the Rust definitions so they cannot drift.
- Rust compile times are the main friction; a workspace split keeps rebuilds
  local to the crate being edited.
- Lints: `clippy::pedantic` warn, `unwrap`/`expect` denied outside tests,
  `cargo deny` for licences and advisories, `rustfmt` and `tsc --noEmit`
  enforced in CI. CI runs on Windows only.
- Bundle size and cold start stay close to native, which is most of why Tauri
  was chosen over Electron.
