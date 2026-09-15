# Prototype 1 — scope, slices, acceptance

## Scope

The four things requested, plus the minimum needed to prove they work.

1. **Project selector.** Open a folder, list known projects, reopen, remove.
2. **Agent picker inside each project.** Choose which harness a session runs on.
3. **Every Anthropic and OpenAI model**, discovered live from the CLIs, with
   per-model settings such as reasoning effort, plus a custom model id field.
4. **Subscription only.** No API keys. If `claude` and `codex` are logged in,
   kitty works.
5. **A working chat session**: send a turn, stream the reply, render tool
   activity, answer approval prompts, cancel, and have it survive a restart.

Item 5 is not scope creep. Items 1 to 4 cannot be demonstrated or tested
without it, and it is the thing that proves the harness abstraction is real
rather than theoretical.

Out, deliberately, until the foundation holds: file editor, git panel, diffs,
integrations, inbox, notes, skills, checkpoints, orchestration, terminals,
multi-window, notifications, themes.

## Two harnesses, not one

Claude Code and Codex are built together, from the start. They differ in every
dimension that matters: bespoke NDJSON versus JSON-RPC, client-generated
session id versus server-issued thread id, stdio permission tool versus
server-initiated approval requests, control-request model listing versus a
paginated RPC. Building one first would produce an abstraction shaped like that
one, which is exactly how MonoCode ended up with seven near-copies. The second
harness is the test of ADR-0002.

---

## Slices

Each slice ends in something you can run and judge. There is no scaffold-only
milestone; the scaffolding is absorbed into the first slice that needs it.

### S1 — kitty sees your agents

**What you can do:** launch kitty and see Claude Code and Codex listed, each
with its install path, version, and whether it is logged in. A rescan button
picks up a CLI you installed a minute ago. A CLI that is missing, logged out,
or too old says which, and shows the exact command that fixes it.

**What gets built:** the Cargo workspace and crate boundaries, the Tauri shell,
generated IPC bindings, the NSIS installer that bootstraps WebView2, CI. Binary
discovery including the npm shim locations, structured version probing,
availability states, read-only credential status checks, environment rescan.

**Why first:** it is the smallest thing that is genuinely useful, and it proves
the whole premise of the product, that subscription auth costs us nothing.

**Status: built.** Verified on the development machine against Claude Code
2.1.270 and Codex 0.153.4, both signed in. The signed-out path was verified by
pointing `CLAUDE_CONFIG_DIR` at an empty directory. The same scan runs headless
via `cargo run -p kitty-probe --example probe`.

### S2 — a reply streams in, and it is still there tomorrow

**What you can do:** pick a folder, type a message, watch a reply stream in
from either CLI. Close kitty, reopen it, and the conversation is exactly as you
left it.

**What gets built:** the supervisor, meaning spawn with job objects, byte
framing with caps, lossy UTF-8, coalescing, async writes. The event vocabulary.
The engine skeleton: lifecycle, turn queue, resume. Both codecs, text and
reasoning only. The SQLite store with blocks as rows, written by the engine as
it decodes. The transcript view, virtualized from its first commit. The fixture
recorder and fixtures for both CLIs.

**Why here:** persistence and virtualization are both far more expensive to
retrofit than to build in, so they arrive with the first transcript rather than
after it. This is the biggest slice and where most of the technical risk lives.

**Status: done.** Protocols proven against the installed CLIs and recorded to
`fixtures/`, alongside the vendor's own schema for the Codex app-server. The
supervisor, event vocabulary, both codecs, the engine, the SQLite store and the
virtualized transcript are all in place. Verified in the app: a reply streams
in, the window is closed and reopened, the conversation is still there, and a
follow-up turn resumes the same vendor session.

Headless, the same path runs without the GUI:

```
cargo run -p kitty-engine --example chat -- claude "Say hello in three words."
cargo run -p kitty-engine --example chat -- codex  "Say hello in three words."
```

### S3 — real work happens

**What you can do:** ask an agent to change a file. Tool activity appears as it
runs. An approval prompt appears, you answer it, the tool proceeds. Escape
cancels mid-turn and leaves a sane transcript. A protocol log viewer shows raw
frames when something looks wrong.

**What gets built:** tool events, the approval and question queues including the
cancelled outcome, in-band cancellation and the cancel-before-spawn race, idle
parking, orphan reaping, the protocol log viewer.

**Why here:** this is where the generic-engine bet from ADR-0002 either holds or
does not. The two CLIs handle approvals completely differently, so if one
engine can serve both, the abstraction is real.

**Status: done.** Tool activity and permission prompts work on both harnesses,
recorded to `fixtures/*/tools.jsonl` and replayed in tests. The bet held: the
approval queue lives once in the engine, and the codecs only translate. Claude
asks over a `control_request` on its own stream; Codex asks with a
server-initiated JSON-RPC call. Neither codec tracks what is outstanding.

The engine now has tests that need no real agent, driven by a fake CLI that
replays canned frames: turn lifecycle, a mid-turn death, garbage on the wire,
a tool round-trip, answering a request, and cancelling with one outstanding.

### S4 — you can choose

**What you can do:** switch harness and model per session. The model list comes
from the CLIs themselves, so every model your subscription allows is there,
with reasoning effort where the CLI reports it. Type a model id the probe never
returned and it still works.

**What gets built:** the catalog probes for both CLIs, caching stamped with the
CLI version, the seed list used only for first paint, per-model settings
rendered generically, the custom model id path, model resolution that stores
the CLI's own native id.

### S5 — projects

**What you can do:** a real project selector. Open a folder, see your projects,
reopen one and find its sessions. Rename, remove, search across conversations.

**What gets built:** projects as first-class rows, the session list, FTS5
search, per-project settings.

**Why last:** it is organizational rather than technical, it is the cheapest
work in the prototype, and it only becomes meaningful once there are sessions
to organize. S2 already lets you pick a folder, which is all a session needs.

---

## Acceptance criteria

**S1**
1. Cold start to a usable window is under 400 ms with no network access and no
   CLI probing on the startup path.
2. Both CLIs are detected with correct versions; an unavailable one shows the
   reason and the command that fixes it.
3. No credential file is ever opened for writing, enforced by a test.

**S2**
4. A turn streams into the transcript while you type in the composer with no
   dropped frames, verified by a benchmark that replays a recorded session at
   full rate, not by eye.
5. Streamed text is byte-identical to what the CLI produced. Whitespace-only
   chunks, repeated identical chunks and blank lines between paragraphs all
   survive, with a regression test per harness. This is the defect class behind
   MonoCode issues #218 and #219, and it is an acceptance criterion rather than
   a bug to fix later.
6. Closing and reopening kitty restores the conversation in full.
7. Killing the process mid-stream loses at most the last batch.
8. Both codecs replay their fixtures identically, and the engine's state machine
   has table-driven tests with no real process.

**S3**
9. An approval prompt appears, the answer reaches the CLI, and the tool
   proceeds, on both harnesses.
10. Cancelling mid-turn stops the turn in-band and leaves a valid transcript.
11. Closing kitty leaves no orphaned CLI processes, verified with a CLI whose
    startup script spawns a grandchild, and no console window ever flashes when
    a child starts.

**S4**
12. The model picker lists every model each CLI reports, with per-model
    reasoning effort where the CLI reports it, and a custom model id can be
    typed and used.

**S5**
13. Opening a folder, running a session, closing kitty and reopening restores
    the project, the session and its transcript.

---

## Risks

- **The engine-in-Rust bet (ADR-0003).** Iterating on undocumented protocols in
  Rust may prove slower than in TypeScript. Reassess at the end of S2, when
  both codecs exist. The fallback is moving decode alone to the frontend.
- **CLI protocol churn.** Both vendors change these surfaces without notice.
  Fixture re-recording must be one command, built in S2, not deferred.
- **Codex `app-server` contract.** Undocumented. MonoCode's implementation is
  the working reference; pin the version verified against and record it in the
  manifest.
- **Windows process trees.** Budget real time in S2 and S3. MonoCode needed a
  patched `portable-pty` for atomic job assignment and that is the known-good
  answer. Windows is the only target (ADR-0001), so this gets solved properly
  once rather than hidden behind a cross-platform abstraction.
- **S2 is large.** If it starts to sprawl, the cut line is reasoning summaries
  and the fixture recorder's polish, not persistence or virtualization.

---

## Explicitly deferred, with a reason

MonoCode's feature set is large and much of it is good. These are the ones
worth taking next, roughly in order: session checkpoints with keep and undo,
the git changes panel with hunk and line staging, the file editor and tree, a
command palette, which MonoCode lacks entirely, and remappable keybindings,
which MonoCode also lacks. The inbox and the integrations are a second product
and should be treated as one.
