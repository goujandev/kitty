# Lessons from MonoCode

kitty follows MonoCode's core idea: a desktop UI that drives already-installed,
already-logged-in coding-agent CLIs. This file records what a close read of
`hardbeat920/monocode` @ `478bc65` (v0.1.46, 2026-09-14) actually established,
so the design decisions in `adr/` have something concrete underneath them.

MonoCode at that commit: 938 stars, created 2026-08-20, ~100 commits in the six
days before the read, MIT, Tauri 2 + React 19, ~25k lines of Rust and ~147k of
TypeScript. CI runs `vitest`, `tsc --noEmit`, `cargo fmt --check`,
`cargo clippy -D warnings` and `cargo test` on a three-OS matrix. 193 TS test
files, 22 Rust modules with tests. It is a serious codebase, not a toy.

File references below are `path:line` in that repo at that commit.

---

## 1. The central fact: it never calls a model API

Inference is always a vendor CLI running as a child process of the Tauri host,
over plain pipes. There is no PTY involved (`pty.rs` is the integrated terminal,
a separate subsystem that agents never touch).

| CLI | argv | Source |
|---|---|---|
| Claude Code | `--output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --include-partial-messages --setting-sources=user,project,local --settings <json>` plus `--model`, `--effort`, `--permission-mode`, `--session-id`/`--resume` | `claudeProtocol.ts:231` |
| Codex | `app-server` | `codex.ts:385` |
| Cursor | `acp` | `cursor.ts:301` |
| fx | `acp [--model M]` | `fx.ts:434` |
| Grok | `--no-auto-update [--permission-mode plan] agent --no-leader [--model M] [--reasoning-effort E] stdio` | `grokProtocol.ts:89` |
| Pi / omp | `--mode rpc [--session\|--resume ID] [--model M]` | `piProtocol.ts:136` |
| OpenCode | `serve --hostname=127.0.0.1 --port=<free>` | `opencode.ts:344` |

Claude is not run with `--print`. It is a long-lived bidirectional stream-json
session; user turns are written as JSON lines onto stdin.

Consequence for us: subscription auth, model access, tool execution, sandboxing
and session storage are the CLI's problem, not ours. That is why the user
experience feels seamless, and it is why this approach gets to a working
product far faster than owning an agent loop.

## 2. Exactly two direct HTTP paths exist

- `rate_limits.rs:9-13` calls `api.anthropic.com/api/oauth/usage` and
  `platform.claude.com/v1/oauth/token` for the usage meter. It reads the Claude
  Code credentials file, performs the refresh-token grant itself, sends
  `User-Agent: claude-code/2.1.0` with Anthropic's Claude Code OAuth client id,
  and writes the rotated credentials back over the vendor's own store
  (`persist_claude_credentials`, `rate_limits.rs:180`).
- `harness_http` / `harness_sse_open` (`harness.rs:474`) serve OpenCode's local
  server and are hard-gated to loopback by `assert_loopback` (`harness.rs:620`).

The first one is the single riskiest thing in the codebase. Rotating a token in
a file that a running `claude` process also owns is a corruption and
surprise-logout hazard, and impersonating the vendor's user agent and client id
is the part most likely to draw a response from the provider. Upstream PR #26
is titled "stop rotating Claude's OAuth token", so this is a known concern
there too. Codex shows the alternative: MonoCode gets Codex usage by spawning
`codex app-server` and calling `account/rateLimits/read`, touching no
credential file at all.

## 3. The normalized event union is the load-bearing abstraction

`types.ts:13` defines `HarnessEvent`, a 24-variant union covering session
lifecycle, `message.delta`, `reasoning.delta`, `tool.started`/`tool.updated`,
`agent.step` for subagent activity, `approval.requested`/`resolved`,
`question.asked`/`updated`/`resolved`, `tasks.updated`, `plan`, `context`, and
`turn.metrics`. `apply.ts:25` reduces it into a `Session` with a pure switch.

This works. Outside `src/lib/harness/`, branching on harness id is essentially
cosmetic: icons, one hidden setting for OpenCode, and which usage footer to
show. Seven wildly different wire protocols genuinely do collapse into one
vocabulary. kitty should copy this idea and spend real effort getting the
vocabulary right, because everything above it depends on the union being
complete enough that the UI never needs to know who produced an event.

## 4. Where it hurts: seven hand-copied adapters

`registry.ts:25` defines a `HarnessAdapter` interface and a registry map, but
the interface only covers dispatch. All session state lives in module-level
`Map`s inside each adapter file, so every one of `claude.ts`, `codex.ts`,
`cursor.ts`, `opencode.ts`, `piFamily.ts`, `grok.ts` and `fx.ts` independently
re-implements:

- `liveByThread` / `resumeByThread` / `cancelledThreads` module maps
- a `turns: Promise<void>` chain to serialize turns
- `turnDone` / `turnFailed` / `turnEndPending` / `finishActiveTurn` /
  `settlePendingTurn`, solving the "turn completed before `runTurn` registered
  its resolver" race the same way in at least five files
- `muteUpdates`, `clearServerRequests`, and an approval/question queue with
  `nextApprovalUiId` / `visibleQuestionId` / `showNextQuestion`, 12 to 14
  references each in three of them
- a bespoke "wait for init with a timeout" idiom, three different ones across
  the codebase

`piFamily.ts` is the exception: Pi and omp share one core through a `PiFlavor`
descriptor. That proves the abstraction is possible and simply was not
extracted. **This is the single biggest thing kitty should do differently.**

Adding a harness to MonoCode touches about nineteen places: six new files, a
`HarnessId` union, `HARNESSES`, `HARNESS_LABEL`, `HARNESS_TITLE`, an
availability if-chain, a binary resolver, model defaults, an icon record, a
skills union, a text-harness preference order, a background component's record,
a Rust resolver plus identity predicate plus command registration, and an
orphan-reaping token list.

Capabilities are expressed as optional interface methods (`compactContext?`,
`respondQuestion?`, `refreshCatalog?`, `canSteer?: boolean`), so callers probe
for features with helpers like `canSteerHarness`. A declarative capability
record would be both cheaper and checkable.

## 5. Streaming: the guess that causes visible bugs

`streamText.ts` centralizes merging streamed body text in `joinStreamText`.
Its job is to decide whether an incoming chunk is a new token to append or a
resent snapshot of the whole message. It decides by inspecting the strings:
equal means snapshot, a longer string that starts with the current text means
snapshot, otherwise append. The file's own comment records that overlap
matching was tried and removed because it "ate blank lines, headings, table
rows, and doubled letters".

The heuristic still misfires. Two consecutive identical multi-character deltas
collapse into one, because equality is read as a snapshot. Upstream issue #219
reports dropped spaces between words and #218 reports lost blank lines between
paragraphs, both in streamed replies.

The root cause is architectural, not a typo: whether a harness appends or
resends is a fixed, knowable property of each protocol, and the code infers it
per chunk instead. kitty makes each adapter declare its delta semantics and
never guesses. A related detail MonoCode gets right and we should keep:
`streamTextDelta` deliberately preserves whitespace-only chunks, with the
comment "Whitespace is real content, not a missing field".

## 6. Process supervision: the hard parts, mostly solved

Worth copying:

- `isolate_child` (`harness.rs:747`) sets `MONOCODE_HARNESS_PARENT=<pid>` on the
  child and creates it with `CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP`.
- `reap_orphaned_harness_processes` (`harness.rs:932`) sweeps at launch for
  processes carrying that marker whose parent is gone.
- Windows needed a patched `portable-pty` to assign a child to a job object
  atomically during `CreateProcessW`, via `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so
  that startup scripts cannot spawn descendants outside the job
  (`vendor/portable-pty/UPSTREAM.md`). This is the correct fix and it is not
  obvious. Process-tree cleanup on Windows is a real cost centre, and since
  kitty targets only Windows it should be the mechanism rather than a special
  case bolted onto a signal-based design.
- GUI processes do not inherit a shell's `PATH`, so MonoCode resolves one at
  startup and caches it (`harness.rs:1958`).
- `harness_exec` is an escape hatch double-gated by an argv allow-list and a
  check that the path is one a resolver would return (`harness.rs:632`).

Worth fixing:

- `BufReader::lines()` with `let Ok(line) = line else { break };`
  (`harness.rs:389`) kills the reader thread permanently on the first invalid
  UTF-8 byte. The session goes mute with no error surfaced.
- No line-length cap on that reader, so one enormous patch line can allocate
  without bound. The control socket has explicit 256 KiB and 2 MiB caps, so the
  discipline exists elsewhere.
- Events go out with `app.emit`, app-wide. In a multi-window app every webview
  deserializes every line belonging to every other window and discards it by
  session id in `child.ts:74`. `control.rs:191` already uses `emit_to`.
- `harness_write` is a synchronous command holding a `Mutex<ChildStdin>` and
  doing a blocking write on an IPC worker thread.
- Harness stdout has no coalescing at all: one IPC emit per line. The PTY path
  does coalesce, on an 8 ms timer.
- `pushBounded` (`child.ts:43`) silently drops the oldest lines past 1000 when
  no handler is attached.
- CLI identity is established by running `--help` and string-matching its prose,
  in three near-identical functions (`harness.rs:1446`, `:1537`, `:1600`).
- Two separate process-kill implementations, in `harness.rs` and `pty.rs`, that
  have already drifted in signal choice and escalation delay. Both are written
  signal-first with Windows as a branch, which is backwards for our target.

## 7. Vendor coupling is unavoidable and must be contained

The layer is coupled to undocumented, unversioned CLI surfaces. It shows up as:

- hard-coded version gates such as `MINIMUM_CLAUDE_OPUS_5_VERSION = "2.1.219"`
  (`claudeProtocol.ts:24`) and per-model quirk tables like mapping effort `max`
  to `high` for one specific model
- suppressing an upstream notice by matching its English wording with a regex
- `piFlavor.ts` carrying comments like "Verified against omp 18.0.6 `--help`"
- Claude's `ExitPlanMode` being answered with a deny plus a fabricated
  instruction string, to steer the agent through its tool-result channel
  (`claude.ts:846`)

Only ACP pins a protocol version. kitty cannot avoid this coupling, but it can
put every version gate and quirk in one declarative table per harness rather
than scattering it through control flow.

## 8. Model catalogs are discovered live, and that is the right answer

`models.ts` ships a hardcoded fallback list, and each harness has a
`<x>Catalog.ts` that probes the CLI and calls `setHarnessModels` to overlay it.
Codex spawns `codex app-server`, runs `initialize`, checks `account/read`, then
pages `model/list`, reading `supportedReasoningEfforts`, `defaultReasoningEffort`
and `serviceTiers` per model (`codexCatalog.ts:110`). Claude asks the running
CLI over a control request, gated on CLI version.

This is how "every Anthropic model and every OpenAI model" is satisfied
honestly: whatever the subscription exposes, discovered at runtime. The
weakness is that the fallback list goes stale and there is no way to type in a
model id the probe did not return, which is upstream issue #196, Fable 5.1
missing from the selector, and PR #150, custom models.

## 9. Front end

`App.tsx` is 7,383 lines. `Sidebar.tsx` is 2,953 and `AgentTranscript.tsx` is
2,823. Harness events are batched into React state on `requestAnimationFrame`,
falling back to a 32 ms timer when the document is hidden (`App.tsx:491`);
approvals and questions deliberately bypass that queue and flush synchronously.
`models.ts` maintains hand-rolled caches with an explicit comment that
`modelsFor` and `findModel` are called from render bodies and must not rebuild
the catalog each time. Those are the fingerprints of performance work done
reactively, after a monolith was already in place.

## 10. What the users are actually complaining about

From the fifty open issues and pull requests at the time of reading, the
recurring themes are: streamed text rendering defects (#218, #219), the
integrated terminal dropping keystrokes under WKWebView with xterm.js (#115,
nine comments), only the default `~/.claude` login being reachable so multiple
accounts are impossible (#198, PR #227), new models not appearing in the picker
(#196, PR #150), project navigation gaps such as an "all projects" view and a
project chooser (#127, #128, PR #180), Windows behaviours like close-to-tray
and shell command display (#223, PR #224, PR #233), idle parking killing a
session that still had background work (#204), running sessions on another
machine (#113, #95), an extension engine (#112), and token cost in the status
bar (#85).

Read as design input rather than a bug list: transcript rendering, terminal
input, account identity, catalog freshness, project navigation and Windows
parity are the places where this product category is currently weakest.
