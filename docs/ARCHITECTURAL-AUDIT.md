# Architectural audit

Date: 2026-09-15

Scope: the current working tree, including existing uncommitted changes, at the time of review. References below identify source files, symbols, and line numbers in that reviewed version; line numbers may move as the code changes.

No source files were changed during the audit. Diagnostics used synthetic subprocesses, temporary databases, and the actual frontend store with mocked IPC. They did not invoke paid model runs. Native installer behavior and end-to-end WebView responsiveness were not measured.

## Executive assessment

The main weakness is session ownership. Rust can keep several agents running, but the frontend models one active conversation and cannot reliably recover its live state. That mismatch causes lost approvals, incorrect busy indicators, and navigation races.

There are also confirmed cancellation stalls, subprocess-output loss, silent persistence failures, and Windows command-quoting problems. These deserve attention before adding more providers.

The current crate boundaries are useful. Fixing the ownership and lifecycle contracts does not require rewriting the architecture.

## Runtime map

| Boundary | Current implementation |
|---|---|
| UI | React 19, custom transcript virtualization, Markdown sanitization |
| State | Module-level external stores using `useSyncExternalStore` |
| IPC | TypeScript command wrappers to Tauri commands; transcript events flow back |
| Agent execution | Rust `kitty-engine`; one session pump per CLI process |
| Providers | Claude stream-JSON and Codex JSON-RPC codecs |
| Processes | Rust supervisor, stdio reader/writer threads, Windows Job Objects |
| Workspace access | Vendor CLIs execute tools in the project directory |
| Persistence | SQLite WAL, one writer connection, reusable reader connections, FTS5 |
| Packaging | Vite to Tauri; Windows NSIS installer; system WebView2 |

There is no application-owned terminal emulator, repository indexer, or file-watching service yet. Filesystem edits and tool subprocesses belong to the vendor CLIs.

### Flows traced

- **Start:** `chatStore.send` → session creation/start → CLI discovery → engine → supervisor.
- **Stream:** stdout → framing → provider codec → engine → transcript persistence/batching → frontend store → virtualized rows.
- **Concurrency:** host registry retains sessions; frontend filters events by active session.
- **Cancel/retry:** cancellation is queued into the engine; recovery after failure is incomplete.
- **Workspace tools:** CLI requests permission; GUI returns a boolean decision.
- **Cleanup:** removing a registry entry queues shutdown; supervisor terminates its Job Object.
- **Restore:** load stored blocks, then start/resume the vendor session.
- **Build:** TypeScript/contract checks, Vite compilation, Rust/Tauri, NSIS configuration.

## Checks performed

| Check | Result |
|---|---|
| TypeScript and IPC contract (`npm.cmd run check`) | Passed |
| Rust workspace tests (`cargo test --workspace --locked --offline`) | Passed |
| Rust formatting (`cargo fmt --all --check`) | Passed |
| Clippy (`cargo clippy --workspace --all-targets --locked --offline -- -D warnings`) | Passed |
| Production frontend build, output directed to a temporary directory | Passed |
| Dependency-tree inspection | No obvious major frontend duplication |
| Isolated failure/concurrency diagnostics | Reproduced issues below |

Frontend output: **373.79 kB JavaScript**, **117.13 kB gzipped**, **23.65 kB CSS**, and a **1.71 MB source map**.

Diagnostic sources and executables were retained outside the repository in `%TEMP%\kitty-architecture-audit-20260915` (`frontend.cjs`, `engine.rs`, `store.rs`, `supervisor.rs`, `quoting.rs`, and `protocol.rs`). These are temporary audit artifacts, not a committed regression suite. Rust diagnostics linked the workspace libraries built during the audit.

---

# Confirmed issues

## F01. Background sessions lose their actionable state

- **Severity:** High.
- **Likelihood:** High when switching between running agents.
- **Finding:** Background approvals are discarded. Returning to a running conversation resets it to idle. Multiple outstanding approvals also overwrite each other.
- **Evidence:**
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `listen`, lines 772–777: ignores every batch outside `activeId`.
  - Same file, `openSession`, lines 400–434: resets `busy` and `approval`.
  - Same file, `apply`, lines 711–725: stores only one approval.
  - [`src-tauri/src/sessions.rs`](../src-tauri/src/sessions.rs), `Transcript::on_event`, lines 200–222: only emits approvals and discards `TurnStarted`.
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `start_session`, lines 850–863: returns immediately for registered sessions without replaying their state.
- **Impact:** An agent can wait indefinitely for an approval the user cannot see. A running conversation appears idle, allowing additional queued prompts and hiding its stop control.
- **Recommendation:** Maintain host-owned runtime snapshots per session, including phase and an approval queue. Subscribe to those independently of which transcript is visible.
- **Validation:** Reproduced both lost background approvals and overwritten simultaneous approvals using the actual frontend store. Regression test: run A, switch to B, deliver an approval to A, return to A, and verify both busy state and the approval remain available. Also deliver two approvals and resolve them independently.

## F02. Cancellation and request failures can permanently stall the engine

- **Severity:** High.
- **Likelihood:** Medium; reproducible during startup and provider errors.
- **Finding:** The engine sets `busy` before the provider accepts a turn, but several failure/cancellation paths never clear it.
- **Evidence:**
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Pump::begin`, lines 330–334: sets `busy = true`.
  - [`crates/harness/src/codex.rs`](../crates/harness/src/codex.rs), `CodexCodec::cancel`, lines 170–185: returns no terminal event when a turn ID is unavailable.
  - Same file, `CodexCodec::on_response`, lines 215–223: emits only `Error` for rejected requests.
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Pump::dispatch`, lines 368–372: clears the turn only after `TurnEnded`.
  - Same file, `Pump::run`, lines 238–327: has no cancellation deadline.
- **Impact:** Later prompts enter the queue and never execute. Cancellation between sending `turn/start` and receiving the turn ID can also fail to stop the forthcoming run.
- **Recommendation:** Model starting, running, cancelling, and failed states explicitly. Settle rejected starts; remember cancellation across handshake transitions; escalate an unacknowledged interrupt after a deadline.
- **Validation:** Actual-engine diagnostics reproduced:
  - Early cancel: no terminal event; subsequent prompt never reached the child.
  - Rejected start: error displayed; subsequent prompt never reached the child.
  - Add tests for cancellation before spawn, during handshake, after sending a start request but before receiving the turn ID, and while waiting on a tool.

## F03. Process exit can overtake the final stdout frames

- **Severity:** High.
- **Likelihood:** Medium; high in the synthetic burst test.
- **Finding:** `Exited` is documented as the last event, but the supervisor does not enforce that ordering.
- **Evidence:**
  - [`crates/supervisor/src/lib.rs`](../crates/supervisor/src/lib.rs), `spawn`, lines 222–230: launches independent stdout and stderr readers.
  - Same file, reaping thread, lines 253–258: sends `Exited` without joining the readers.
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Pump::run`, lines 275–277: returns immediately on `Exited`.
- **Impact:** Final answers, tool results, usage, or completion notifications can be dropped. Successful output can be persisted as interrupted.
- **Recommendation:** Deliver exit only after stdout and stderr are drained. Bound drain time for descendants that keep inherited pipes open.
- **Validation:** **142 of 150** immediate-exit burst processes delivered stdout frames after their exit event. The engine would discard those late frames. This is a stress reproduction, not a measured production failure rate. Add a regression test asserting all output and the terminal protocol frame arrive before the exit event.

## F04. Persistence failures can be invisible to the user

- **Severity:** High.
- **Likelihood:** Low normally; certain under relevant storage failures.
- **Finding:** The app can display successful-looking output without saving it, or run entirely in memory without a visible warning.
- **Evidence:**
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `open_store`, lines 1044–1064: falls back to an in-memory database.
  - Same file, `run::setup`, lines 1127–1130: sends the warning only to stderr.
  - [`src-tauri/src/main.rs`](../src-tauri/src/main.rs), line 3: release builds have no console.
  - [`src-tauri/src/sessions.rs`](../src-tauri/src/sessions.rs), `Transcript::delta`, lines 306–310: ignores failed writes and clears `dirty`.
  - Same file, `Transcript::finish`, lines 387–396: emits final text despite failed persistence.
  - Same file, lines 152–154: provider-session persistence also ignores errors.
- **Impact:** Lost conversation text or resume IDs may only become apparent after restarting.
- **Recommendation:** Expose durable-storage status to the UI. Propagate write failures; retain dirty state until a successful commit; provide a visible unsaved/retry state.
- **Validation:** Inject failed writes and database-open failures. Verify the UI cannot claim normal persistence and that unsaved content remains recoverable.

## F05. Slow work runs inside synchronous Tauri commands

- **Severity:** High.
- **Likelihood:** High with slow CLI startup, storage, or network folders.
- **Finding:** Commands invoked from routine navigation perform blocking discovery, database work, and filesystem access on the host's synchronous IPC path.
- **Evidence:**
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `start_session`, lines 850–918: synchronously probes and starts a CLI.
  - [`crates/probe/src/lib.rs`](../crates/probe/src/lib.rs), `VERSION_TIMEOUT`, line 27, and `resolve_install`, lines 98–108: can wait **15 seconds per candidate**.
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `session_blocks`, lines 837–841: loads the complete transcript synchronously.
  - Same file, `list_project_summaries`, lines 286–309: synchronously checks every project directory.
  - Same file, `list_models`, lines 363–388: performs blocking discovery inside an async function, before its `spawn_blocking` section.
  - The installed Tauri macro implementation (`tauri-macros-2.6.3/src/command/wrapper.rs`, `body_blocking`, lines 429–433) confirms synchronous commands call their handlers directly.
- **Impact:** Native-window responsiveness and IPC handling can stall. Model discovery also occupies async runtime workers unnecessarily.
- **Recommendation:** Move blocking command bodies into `spawn_blocking`, reuse validated discovery results, and start historical sessions lazily when needed.
- **Validation:** Use a CLI shim with a delayed version response and an unavailable network project. Measure window responsiveness and unrelated-command latency throughout. End-to-end UI latency was not profiled during this audit.

## F06. Async navigation can mix conversations or overwrite live output

- **Severity:** High.
- **Likelihood:** Medium during rapid navigation or slow IPC.
- **Finding:** Several asynchronous completions mutate whichever conversation is currently selected.
- **Evidence:**
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `send`, lines 453–461: appends its completed send into current `state.blocks` without checking session identity.
  - Same file, `commitDraft`, lines 473–497: changes selection after awaiting creation and reads model selection afterward.
  - Same file, `useProject`, lines 260–290, and `refreshSessions`, lines 510–517: lack navigation-generation guards.
  - Same file, `openSession`, lines 424–429: replaces blocks with a snapshot while live events can already arrive.
- **Impact:** A message for A can appear in B. A snapshot can erase an already-delivered live block, leaving subsequent deltas without a target.
- **Recommendation:** Capture session/project/model identity before awaiting. Guard completions with navigation generations. Synchronize snapshots and live events using an event watermark or buffered handoff.
- **Validation:** Reproduced both cross-chat message insertion and snapshot replacement of live output. Add deferred-IPC tests that resolve requests in a different order from their initiation.

## F07. Approval prompts omit information needed to approve safely

- **Severity:** High.
- **Likelihood:** High for multiline commands and file edits.
- **Finding:** The approval display contains shortened summaries rather than the complete action.
- **Evidence:**
  - [`crates/harness/src/lib.rs`](../crates/harness/src/lib.rs), `summarize`, lines 115–130: reduces commands to the first 80 characters of their first line.
  - [`crates/harness/src/claude.rs`](../crates/harness/src/claude.rs), `on_control_request`, lines 343–362: discards the structured tool input.
  - [`crates/harness/src/codex.rs`](../crates/harness/src/codex.rs), `on_server_request`, lines 378–394: uses shortened titles and reasons.
  - [`src/views/ApprovalPrompt.tsx`](../src/views/ApprovalPrompt.tsx), `ApprovalPrompt`, line 11 onward: has no full-command or patch preview.
- **Impact:** A user may approve a command whose later lines perform materially different work. File approvals do not expose the complete proposed change.
- **Recommendation:** Carry structured approval details separately from compact transcript summaries. Provide the full command, working directory, affected paths, and patch where supplied.
- **Validation:** A synthetic two-line command produced only **“Bash: echo harmless”** in the approval event; its second command was absent. Test multiline commands, long commands, multiple file edits, and paths with identical trailing components.

## F08. Windows batch quoting permits shell-command injection

- **Severity:** High.
- **Likelihood:** Low with normal vendor values.
- **Finding:** The batch launcher escapes embedded quotes using backslashes, which does not safely delimit arguments for `cmd.exe`.
- **Evidence:**
  - [`crates/supervisor/src/lib.rs`](../crates/supervisor/src/lib.rs), `build_command`, lines 322–339: constructs a raw shell command.
  - Same file, `quote`, lines 360–367: applies the unsafe escaping.
  - [`crates/probe/src/exec.rs`](../crates/probe/src/exec.rs), `quote`, lines 176–183: duplicates it.
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Session::start`, lines 83–96: model, effort, and resume values enter launch arguments.
- **Impact:** A crafted launch value can execute additional commands with the application's privileges. Ordinary prompt text travels over stdin; exposure here is launch arguments and their upstream sources.
- **Recommendation:** Prefer direct executable launches. Consolidate batch launching into one rigorously tested implementation and reject unsupported shell syntax in constrained model/effort values.
- **Validation:** A harmless argument containing an embedded quote and `& echo …` executed an extra `echo` outside the test batch file. Add argument round-trip tests covering quotes, whitespace, shell metacharacters, percent expansion, and Unicode.

## F09. Codex server requests are incorrectly treated as one boolean approval protocol

- **Severity:** High.
- **Likelihood:** Depends on the requested tool or permission.
- **Finding:** Different request types require different responses, but all receive `decision: accept/decline`.
- **Evidence:**
  - [`crates/harness/src/codex.rs`](../crates/harness/src/codex.rs), `respond_approval`, lines 152–167: sends the same response shape.
  - Same file, `on_server_request`, lines 364–376: treats unknown methods as generic approvals.
  - [`fixtures/codex/schema/PermissionsRequestApprovalResponse.json`](../fixtures/codex/schema/PermissionsRequestApprovalResponse.json), lines 298–318: requires `permissions`.
  - [`fixtures/codex/schema/ToolRequestUserInputResponse.json`](../fixtures/codex/schema/ToolRequestUserInputResponse.json), lines 22–30: requires `answers`.
  - [`crates/harness/src/codex.rs`](../crates/harness/src/codex.rs), `on_frame`, lines 193–199: accepts only unsigned numeric IDs, although [`fixtures/codex/schema/RequestId.json`](../fixtures/codex/schema/RequestId.json), lines 3–11, also permits strings.
- **Impact:** Permission escalation and interactive questions can fail or stall. Valid string-ID requests are silently ignored.
- **Recommendation:** Store the request method and typed payload alongside its ID. Implement method-specific responses; return an explicit unsupported-method error where appropriate.
- **Validation:** Reproduced an invalid permission response and silent rejection of a string-ID approval request. Validate every emitted response against its checked-in vendor schema, including legacy approval methods and question responses.

## F10. Opening conversations accumulates processes; exited sessions remain registered

- **Severity:** High.
- **Likelihood:** High over long sessions.
- **Finding:** Reading a historical conversation starts its CLI, with no idle parking or automatic registry removal after exit.
- **Evidence:**
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `openSession`, line 429: starts the agent on every open.
  - [`src-tauri/src/sessions.rs`](../src-tauri/src/sessions.rs), `Live` and `Registry`, lines 63–68: retain session handles.
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `start_session`, lines 855–863: treats registry membership as proof of liveness.
  - [`src/ipc/commands.ts`](../src/ipc/commands.ts), `stopSession`, line 243: has no frontend caller.
  - [`src-tauri/src/sessions.rs`](../src-tauri/src/sessions.rs), `Transcript::run`, lines 128–137: wakes every 16 ms even while idle.
  - Thread creation: supervisor `spawn` has four threads, engine `Session::start` has three, and transcript `pump` adds one.
- **Impact:** Browsing history accumulates vendor processes and roughly **eight host threads per live session**. After a CLI exits, reopening its conversation does not restart it because its registry entry remains.
- **Recommendation:** Separate viewing from execution. Remove exited entries through a completion callback, and implement bounded warm-session retention with explicit close/park behavior.
- **Validation:** Open 30 historical conversations without sending; count processes, threads, and idle CPU. Kill one CLI and verify reopening can recover.

## F11. Multi-statement storage operations are not atomic

- **Severity:** Medium.
- **Likelihood:** Low normally; relevant during crashes and I/O failures.
- **Finding:** Transcript, search-index, and session-metadata changes commit independently.
- **Evidence:**
  - [`crates/store/src/lib.rs`](../crates/store/src/lib.rs), `Store::append_block`, lines 415–437: performs three writes without a transaction.
  - Same file, `set_block_text`, lines 452–467, and `delete_session`, lines 487–495: have the same problem.
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `send_turn`, lines 931–950: saves a prompt before verifying it can be delivered.
- **Impact:** A failed operation can leave committed partial state, stale search results, or saved-but-unsent prompts. Retrying can create duplicates.
- **Recommendation:** Wrap each logical database mutation in a transaction. Give submitted turns an ID and delivery state so retries are explicit and idempotent.
- **Validation:** Injecting failure into the session-update statement made `append_block` return an error while **one block remained committed**. Add failure-injection tests between every related write and verify rollback and retry behavior.

## F12. Streaming persistence scans the entire FTS table

- **Severity:** High at scale.
- **Likelihood:** High as stored history grows.
- **Finding:** FTS updates locate rows through unindexed metadata columns.
- **Evidence:**
  - [`crates/store/src/migrations.rs`](../crates/store/src/migrations.rs), lines 82–86: marks `session_id` and `seq` as `UNINDEXED`.
  - [`crates/store/src/lib.rs`](../crates/store/src/lib.rs), `set_block_text`, lines 458–460: updates using those columns.
  - [`src-tauri/src/sessions.rs`](../src-tauri/src/sessions.rs), `Transcript::delta`, lines 306–310: invokes this approximately every 300 ms during streaming.
  - [`crates/store/src/lib.rs`](../crates/store/src/lib.rs), `Store::write`, lines 182–184: all writes share the writer mutex.
- **Impact:** Each active stream repeatedly scans application-wide history while holding the shared writer. Multiple agents amplify the contention.
- **Recommendation:** Map blocks to stable FTS row IDs and update by `rowid`; consider indexing text only at completion or on a separate controlled schedule.
- **Validation:** Using the bundled SQLite library and synthetic in-memory rows, `EXPLAIN QUERY PLAN` reported `SCAN blocks_fts VIRTUAL TABLE INDEX 0:`. Twenty updates were averaged for each measurement:

| Stored blocks | Current update | Update by row ID |
|---:|---:|---:|
| 1,000 | 0.233 ms | 0.026 ms |
| 10,000 | 2.020 ms | 0.031 ms |
| 100,000 | 19.538 ms | 0.029 ms |

These measurements isolate lookup cost; real text and disk writes add work. Add a multi-stream benchmark tracking writer-lock time and persistence lag.

## F13. Streaming updates still scale with total transcript length

- **Severity:** Medium.
- **Likelihood:** High for long conversations.
- **Finding:** Virtualization limits mounted rows, but store and layout work still traverses the complete transcript.
- **Evidence:**
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `replaceBlock`, lines 656–663: maps the full block array for each delta.
  - Same file, `listen`, line 776: applies each event separately.
  - Same file, `useChat`, lines 137–138: subscribes to the whole state.
  - [`src/views/Transcript.tsx`](../src/views/Transcript.tsx), lines 56–121: recomputes attribution and offsets after block changes; viewport lookup is linear.
- **Impact:** Large histories cause allocation, subscription, and layout work throughout the UI. Several components subscribe to the same broad state, including the app root.
- **Recommendation:** Coalesce deltas per block and publish once per batch. Add selectors, indexed block access, and layout bookkeeping that changes only when structure or measurements change.
- **Validation:** One batch containing 100 deltas over 50,000 blocks produced **100 store notifications and 42.9 ms of store work**, without React mounted. End-to-end frame timing still needs measurement.

## F14. Search performs application-wide follow-up queries per keystroke

- **Severity:** Medium.
- **Likelihood:** High with many projects.
- **Finding:** A bounded FTS result is decorated by loading every project's sessions sequentially.
- **Evidence:**
  - [`src/views/ChatRail.tsx`](../src/views/ChatRail.tsx), search input, line 94: searches on every input change.
  - [`src/stores/projectStore.ts`](../src/stores/projectStore.ts), `search`, lines 85–105: launches decoration after the query.
  - Same file, `decorate`, lines 108–133: calls `listSessions` for every project, even when there are no hits.
- **Impact:** Search creates unnecessary IPC and database work. Stale-result guards prevent incorrect display but do not stop decoration already underway.
- **Recommendation:** Return joined session/project metadata directly from the search query. Skip decoration for empty results and debounce input modestly.
- **Validation:** With 100 projects, count IPC calls for one search and for typing a short word. The target should be approximately one search request per debounced query.

---

# Risks requiring further measurement or reproduction

These risks have concrete code evidence, but their workload-dependent impact or full failure scenario was not established by an end-to-end reproduction during this review.

## R01. Unbounded queues

- **Severity:** High under sustained overload.
- **Likelihood:** Frequency unmeasured; depends on producer/consumer rates.
- **Evidence:** [`crates/supervisor/src/lib.rs`](../crates/supervisor/src/lib.rs), lines 215–216; [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), lines 108–121 and `Pump::queued`: channels and queued prompts have no capacity limits.
- **Impact:** A stalled writer or database can accumulate memory. Per-frame size limits do not bound aggregate queued bytes.
- **Recommendation:** Add byte/count budgets and a separate responsive cancellation path. Bound admission without dropping required protocol events silently.
- **Validation:** Flood synthetic streams while delaying persistence and track queue depth, queued bytes, cancellation latency, and RSS.

## R02. Probe timeouts do not fully contain processes

- **Severity:** Medium.
- **Likelihood:** Conditional on a hung or unusual CLI/shim.
- **Evidence:** [`crates/probe/src/exec.rs`](../crates/probe/src/exec.rs), `run_capture`, lines 99–114: kills only the immediate child; the final `wait` is unbounded. `drain`, lines 128–134, uses `read_to_end` without a byte cap.
- **Impact:** A batch shim's descendants or a process that closes pipes before exiting can outlive the advertised timeout. Captured output can grow excessively.
- **Recommendation:** Reuse supervision, cap captured bytes, and cover the entire process lifetime with a deadline.
- **Validation:** Test a shim spawning a descendant, a process closing stdout/stderr before sleeping, and a process continuously emitting output.

## R03. Shared workspace editing has no coordination

- **Severity:** High if agents edit overlapping files.
- **Likelihood:** Depends on concurrent task overlap.
- **Evidence:** [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `start_session`, lines 900–904: sessions receive the same project directory.
- **Impact:** Separate processes do not isolate filesystem changes. Agents can overwrite edits or observe partially changing files.
- **Recommendation:** Decide between shared editing, exclusive editing, and per-agent worktrees. Make the chosen ownership model explicit.
- **Validation:** Test two agents applying conflicting patches and running repository operations concurrently.

## R04. Restart/shutdown generations are unspecified

- **Severity:** Medium.
- **Likelihood:** Timing-dependent.
- **Evidence:** [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Session::drop`, lines 196–199: queues shutdown. [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `set_session_model`, lines 973–982: starts replacement work without joining the old pump.
- **Impact:** Old events can overlap a replacement using the same session ID. Deletion and replacement do not await full pump cleanup.
- **Recommendation:** Add run-generation IDs and acknowledged shutdown. Reject events from superseded generations.
- **Validation:** Switch models or delete a session while old output and persistence work are draining; verify no old event changes the replacement state.

## R05. Job assignment occurs after spawn

- **Severity:** Medium.
- **Likelihood:** Low normally.
- **Evidence:** [`crates/supervisor/src/lib.rs`](../crates/supervisor/src/lib.rs), lines 200–206: starts the process before assigning its Job Object. [`crates/supervisor/src/job.rs`](../crates/supervisor/src/job.rs), lines 14–27, acknowledges the race.
- **Impact:** An early descendant can escape containment.
- **Recommendation:** Use creation-time Job Object assignment if containment is a hard guarantee.
- **Validation:** Stress immediate grandchild creation and verify all descendants terminate when the session or application exits.

## R06. Image handling has no size budget

- **Severity:** Medium.
- **Likelihood:** Image-dependent.
- **Evidence:** [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `picture_response`, line 103: reads the full file. `read_background`, lines 786–791: additionally base64-encodes the complete file.
- **Impact:** Large images can cause memory spikes and blocking work, including browser decoding and IPC serialization costs.
- **Recommendation:** Cap input bytes/dimensions, generate thumbnails, and move blocking work off responsive execution paths.
- **Validation:** Measure decoding, IPC, and peak memory with large images and several image-bearing replies.

## R07. Crash/update recovery lacks explicit policy

- **Severity:** Medium.
- **Likelihood:** Conditional on crashes, migrations, or rollback builds.
- **Evidence:** [`crates/store/src/migrations.rs`](../crates/store/src/migrations.rs), turn schema, lines 59–69: records completed turns. Migration runner, lines 199–250: has no newer-schema rejection or backup step.
- **Impact:** Crashed tools may retain “running” metadata; rollback builds may open newer databases. Recovery cannot reliably distinguish pending, delivered, and interrupted work.
- **Recommendation:** Add startup reconciliation, schema compatibility checks, and upgrade tests against populated databases.
- **Validation:** Terminate the application mid-turn and during upgrades; reopen with the same and an older supported build and verify explicit recovery behavior.

### Workspace-isolation clarification

A rootless chat's scratch directory is a working directory, not a security boundary. [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `scratch_dir` at line 683 and `start_session` at lines 894–904, chooses a location for the CLI. The host does not itself enforce that the CLI can read only that directory. Access guarantees must come from explicit vendor sandbox/permission policy rather than the choice of current directory.

---

# General engineering improvements

These suggestions are secondary to the confirmed failures.

## G01. Keep the useful crate boundaries

- **Priority:** Informational.
- Separating codecs, supervision, storage, and core types is useful. A rewrite is unnecessary.
- Keep fixes concentrated around the contracts between these boundaries.

## G02. Make session lifecycle ownership explicit

- **Priority:** Medium maintenance improvement.
- Lifecycle currently spans `chatStore`, Tauri commands, the registry, engine, codecs, and transcript pump.
- One session manager should own start/stop/recovery and runtime snapshots, with documented transitions and event ordering.
- Validate ownership through lifecycle integration tests instead of relying on UI assumptions.

## G03. Preserve bounded diagnostics

- **Priority:** Medium reliability improvement.
- [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), lines 262–265, discards stderr, while codecs silently ignore malformed/unrecognized frames.
- A redacted ring buffer would make provider failures diagnosable without retaining unlimited raw prompt or tool content.
- Test that failure reports contain actionable diagnostics and that sensitive values and memory budgets remain controlled.

## G04. Strengthen contract verification

- **Priority:** Medium maintenance improvement.
- [`scripts/check-contract.mjs`](../scripts/check-contract.mjs) checks field/tag presence, not their types, ownership, or command signatures.
- Generate bindings or validate schemas before expanding providers.
- Add negative tests proving that a changed field type or a field moved to the wrong variant fails validation.

## G05. Update architecture documentation

- **Priority:** Low.
- Several guarantees in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) and related ADRs remain plans: idle parking, selector subscriptions, creation-time containment, and fully authoritative runtime restoration.
- Clearly distinguish implemented behavior from planned behavior so future changes do not rely on guarantees that are absent.

## G06. Keep bundle optimization proportionate

- **Priority:** Low.
- The frontend dependency set is small. Dependency inspection did not establish a major duplicated-runtime problem.
- [`vite.config.ts`](../vite.config.ts), line 19, enables production source maps; the measured map adds 1.71 MB to frontend output. Disable shipping it unless needed.
- The opener's mixed static/dynamic imports produce a build warning but are not a significant bottleneck.
- Rust dependency duplication should be evaluated by actual release-binary contribution; build dependencies and platform support crates are not automatically application bloat.

## G07. Add installer testing

- **Priority:** Medium release-reliability improvement.
- [CI](../.github/workflows) compiles/tests the app and builds the frontend, but does not exercise NSIS install, upgrade, uninstall, or WebView2 bootstrapping.
- [`src-tauri/tauri.conf.json`](../src-tauri/tauri.conf.json), line 33, explicitly targets NSIS. Windows-only targeting is intentional; missing macOS/Linux support is not a current defect.
- Test upgrades against populated installations and verify data retention, process cleanup, and startup with the supported WebView2 configuration.

---

# Five highest-priority issues

1. **F01: Recoverable per-session runtime state and approval queues.**
2. **F02: Cancellation/rejection paths that leave the engine permanently busy.**
3. **F03: Subprocess exit arriving before final stdout is drained.**
4. **F04: Silent persistence failure and invisible in-memory fallback.**
5. **F05: Blocking CLI/filesystem/database work in synchronous IPC commands.**

The shell-quoting defect (F08) should also be fixed before broad distribution, despite its lower normal-use likelihood.

# Most valuable low-effort improvements

- Display persistent storage failures prominently.
- Guard asynchronous UI completions with captured session IDs.
- Remove dead sessions from the registry.
- Settle rejected or cancelled starts explicitly.
- Publish frontend state once per transcript batch.
- Return search metadata in one joined query.
- Stop truncating approval details.
- Retain bounded, redacted subprocess diagnostics.

# Measurements and tests to add next

- **Concurrency:** 1, 4, and 8 simultaneous streams; switch chats while approvals arrive.
- **Lifecycle:** cancel before spawn, during handshake, before turn-ID receipt, during tools, and after completion.
- **Recovery:** rejected start, closed stdin, CLI crash, disk-full/write failure, app termination mid-turn.
- **Performance:** 1,000/10,000/100,000 blocks; IPC latency, frame time, writer-lock time, queue bytes, RSS, threads, and child counts.
- **Protocol:** validate emitted responses against the checked-in vendor schemas.
- **Packaging:** upgrade a populated installation and verify conversations, settings, and child cleanup.

The existing tests provide good codec and storage coverage, but no frontend behavior tests currently guard the reproduced races.

# Decisions to make before the app grows

- What is the authoritative session state, and how is it restored after UI reconnect?
- Can agents share a writable workspace, or should each receive a worktree?
- How many sessions remain warm, and what are the process/memory limits?
- Which permission and question types must every provider support?
- How are saved, queued, delivered, failed, and retried prompts distinguished?
- Is one application instance enforced, or must multiple instances coordinate?
- What recovery and schema-compatibility guarantees accompany releases?

---

# Second-pass audit (Claude Fable 5.1)

Date: 2026-09-15, same working tree as above.

An independent review of the same eight flows. Most of what it found is already recorded above; those overlaps are listed in the cross-reference table at the end rather than repeated. This section adds the measurements that calibrate existing findings and the items the first pass did not cover.

Checks re-run on the working tree: `cargo clippy --workspace --all-targets -- -D warnings`, `npm run check`, and `cargo test --workspace`, which passed **215 tests across 22 binaries** with zero failures. No source files were changed.

## Measurements that calibrate existing findings

- **F05, probe cost.** On this machine `claude.cmd --version` takes **42–49 ms** through `cmd.exe` and `codex --version` takes **52–59 ms**, both warm. `claude.cmd` wraps a native `claude.exe`, so the "Node boot" the code comments assume no longer applies. Today's cost per session open is a short hitch; the 15 s timeout in `crates/probe/src/lib.rs:27` remains the worst case.
- **F10, thread count.** Confirmed at eight host threads per live session: `crates/supervisor/src/lib.rs:224-255` (four), `crates/engine/src/lib.rs:113-138` (three), `src-tauri/src/sessions.rs:71` (one). Idle memory per child was not measured because no agent was running during the review; that number should decide how aggressive session parking needs to be.
- **R07, live database.** The app data folder holds a 168 KB `kitty.db` beside a 2.6 MB `kitty.db-wal`, and a `recovered-transcripts.txt` left by the migration-4 incident that migration 5 repairs. The backup-before-migrate recommendation in R07 is therefore not hypothetical.

## Additional confirmed issues

### S01. A failed resume leaves the conversation unusable

- **Severity:** High. **Likelihood:** Certain after a vendor CLI upgrade drops or archives old sessions.
- **Finding:** Neither codec falls back to a fresh session when the stored provider id is rejected.
- **Evidence:**
  - [`crates/harness/src/codex.rs`](../crates/harness/src/codex.rs), `open_thread`, lines 101–121: sends `thread/resume` whenever a thread id is stored. `on_response`, lines 215–224, turns the rejection into a non-retryable `Error` and stops the handshake.
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), `Session::start`, lines 83–86: passes `--resume` to Claude unconditionally; an unknown id makes the CLI exit, which reaches the UI only as "exited with code N" (see G03).
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `start_session`, line 860: the dead session then stays registered (F10), so retrying is impossible.
- **Impact:** The only recovery is deleting the conversation. The transcript is still in the database, so the loss is avoidable.
- **Recommendation:** On a resume rejection, clear `provider_session`, restart without it, and show a one-line notice that the vendor forgot the earlier context.
- **Validation:** Store a bogus provider id on a session and open it. Expect a fresh session and a notice, not a stuck conversation.

### S02. The same CLI is probed repeatedly and concurrently

- **Severity:** Medium. **Likelihood:** Certain on every session switch and at every startup.
- **Finding:** Discovery results are never reused. F05 covers where the probes block; this covers how many run.
- **Evidence:**
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `list_models`, line 364: spawns `--version` on every call, cached catalog or not, only to build the cache key.
  - Same file, `start_session`, line 886: probes again instead of reading `AppState.scan`.
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `openSession`, line 411, and `newSession`: call `loadModels` on every open. `loadModels`, lines 570–586, has no in-flight guard, unlike `rescan` in `harnessStore.ts`.
  - [`src/App.tsx`](../src/App.tsx), lines 51–52: `initialise`, `restoreLastProject`, and the resulting `loadModels` run together, so one CLI can be probed four times within the first second. A cache-miss catalog probe additionally spawns the CLI for up to 45 s (`crates/catalog/src/lib.rs:33`), and two such probes for one harness can overlap.
- **Impact:** Wasted process spawns and duplicated work; compounds F05.
- **Recommendation:** Keep one resolved install per harness in `AppState`, refreshed only by `harness_rescan`, and read the version from it. Add an in-flight promise guard to `loadModels`.
- **Validation:** Count child process creations during startup and during ten session switches. Target is zero probes outside an explicit rescan.

### S03. The frontend clears `busy` on non-terminal errors while the engine's turn continues

- **Severity:** Medium. **Likelihood:** Low, but the result looks like a hang.
- **Finding:** F02 describes the engine staying busy after a failure. The inverse also happens: the UI goes idle while the engine is still mid-turn.
- **Evidence:**
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), lines 247–256 and 267–273: an oversized frame or a read failure emits `Error` without ending the turn; `busy` stays true.
  - [`src/stores/chatStore.ts`](../src/stores/chatStore.ts), `apply`, lines 762–764: the `failed` event sets `busy: false`.
- **Impact:** The next message is accepted by the UI and queued silently behind the still-running turn (`Pump::queued`), with no Stop button and no status.
- **Recommendation:** Derive `busy` only from `TurnStarted` and `TurnEnded`, and forward `TurnStarted` to the frontend (it is dropped at `sessions.rs:229`). This is a sub-case of the host-owned runtime snapshot in F01.
- **Validation:** Feed an oversized frame mid-turn through the fake CLI and assert the UI still shows the turn as running.

### S04. Adding a third harness touches the engine and the host

- **Severity:** Low today, Medium for the stated goal of cheap harness additions (ADR-0002).
- **Evidence:**
  - [`crates/engine/src/lib.rs`](../crates/engine/src/lib.rs), lines 83–97: `if spec.harness == HarnessId::Claude` builds resume, model, and effort flags inside the engine rather than the manifest or codec.
  - [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `parse_harness`, lines 571–577, and `start_session`, lines 877–881: two hand-written string matches.
  - [`crates/core/src/harness.rs`](../crates/core/src/harness.rs), `HarnessId::ALL`, line 25, and `descriptor`, line 36.
  - [`crates/harness/src/lib.rs`](../crates/harness/src/lib.rs), `launch_args` and `codec_for`, lines 158–171.
- **Impact:** A new vendor is five edits across three crates, and the launch-flag special case is the kind of drift the ADR set out to prevent.
- **Recommendation:** Move launch-flag construction into the codec's `start` context or the descriptor, and derive the string parsing from `HarnessId::ALL` with a single `FromStr`.

### S05. Scratch folders for folderless chats are never removed

- **Severity:** Low. **Likelihood:** Certain over time.
- **Evidence:** [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `scratch_dir`, lines 683–692, creates `chats/<project_id>` under the app data directory. `prune_chats` (line 242) and `remove_project` (line 315) delete rows only. Four such folders exist in the live data directory now.
- **Impact:** Orphaned directories, and anything an agent wrote into them, accumulate indefinitely.
- **Recommendation:** Remove the directory when the project row is deleted, and sweep directories with no matching project at startup.

### S06. Project roots are matched as raw strings

- **Severity:** Low. **Likelihood:** Medium on Windows.
- **Evidence:** [`crates/store/src/lib.rs`](../crates/store/src/lib.rs), `open_project`, lines 189–199: the upsert key is `root.to_string_lossy()` with no canonicalisation. `C:\Repo`, `c:\repo`, and `C:\Repo\` become three projects with separate conversation lists.
- **Recommendation:** Canonicalise in `open_project` before the upsert, with a one-off migration that merges existing duplicates by canonical path.

### S07. Finished replies are re-parsed every time they scroll into view

- **Severity:** Low. **Likelihood:** High when scrolling long, code-heavy transcripts.
- **Evidence:** [`src/views/Markdown.tsx`](../src/views/Markdown.tsx), lines 36–48: `marked.parse` plus `DOMPurify.sanitize` run in a per-instance `useMemo`. The virtualiser in `Transcript.tsx` unmounts rows that leave the viewport, so each row re-parses on every re-entry.
- **Recommendation:** Cache sanitised HTML by block sequence and text length in the store, or in a small least-recently-used map outside React.
- **Validation:** Scroll a 500-block transcript end to end and profile time in `marked.parse`.

### S08. Small items

- [`package.json`](../package.json), line 26: `@types/dompurify` is redundant; DOMPurify 3 ships `dist/purify.cjs.d.ts`.
- [`src/main.tsx`](../src/main.tsx), line 11: `React.StrictMode` double-runs the startup effect in `App.tsx:47-59` in development, so `restoreLastProject` and `initialise` execute twice. Harmless in release, but it doubles the probe count from S02 during dev testing.
- [`crates/store/src/lib.rs`](../crates/store/src/lib.rs), `configure`, lines 650–659: no `journal_size_limit` and no checkpoint on close, which is why the WAL is sixteen times the database size. Add `PRAGMA wal_checkpoint(TRUNCATE)` on shutdown.
- [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs), `run`, line 1081: the `kitty://` picture handler uses the synchronous `register_uri_scheme_protocol`, so the file read in `picture_response` (line 103) runs on the main thread. Switch to `register_asynchronous_uri_scheme_protocol`. R06 covers the size budget; this is the thread.

## Cross-reference: second-pass findings already recorded above

| Second-pass observation | Recorded as |
|---|---|
| Every opened conversation keeps its CLI and eight threads alive; `stopSession` has no caller; 16 ms idle wake | F10 |
| Background approvals lost, `busy` reset on switch, model change kills a mid-turn CLI | F01 |
| Snapshot reload overwrites live deltas when opening a streaming session | F06 |
| `start_session`, `session_blocks`, `search`, `list_project_summaries`, and `background` block the main thread | F05 |
| Cancel sends one interrupt and never escalates; `cancelling` is never read | F02 |
| CLI stderr discarded, failures reported as a bare exit code | G03 |
| `append_block` and `set_block_text` are not transactional; `send_turn` persists before checking liveness | F11 |
| FTS re-indexed on every 300 ms streaming persist | F12 |
| Unbounded channels, one `set` per event, O(n) block copy per delta | R01, F13 |
| Search fires per keystroke and decorates with one `listSessions` call per project | F14 |
| `cmd.exe` quoting escapes quotes with backslashes and leaves `%VAR%` expansion live | F08 |
| No database backup before migrations | R07 |
| Production build ships a 1.7 MB source map | G06 |
| No frontend test runner; no multi-session or cancel-timeout tests | "Measurements and tests to add next" |

## Additions to the priority lists

- **Highest priority:** S01 belongs alongside F10, since together they make a conversation permanently unrecoverable after a routine CLI upgrade.
- **Low-effort improvements:** reuse the scan result instead of re-probing (S02); forward `TurnStarted` and derive `busy` from turn events (S03); delete scratch folders with their project (S05); checkpoint the WAL on exit (S08).
- **Decision to add:** whether launch configuration belongs to the codec, the descriptor, or the engine (S04). Answer this before the third harness, not during it.
