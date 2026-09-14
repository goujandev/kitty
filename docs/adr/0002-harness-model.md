# ADR-0002: Harness model — manifests, codecs, capabilities

Status: proposed

## Context

kitty drives several vendor CLIs that differ in every dimension: transport
(bespoke NDJSON, JSON-RPC over stdio, ACP, a local HTTP server with SSE),
vocabulary, resume mechanism, approval mechanism, model discovery, attachment
support, and flag spelling. None of them publish a stable protocol contract.
Only one of the protocols MonoCode speaks pins a version at all.

MonoCode proves the normalization is possible: seven protocols collapse into a
24-variant event union, and above its harness directory the UI branches on
harness id essentially only for icons.

It also shows the cost of getting the factoring wrong. Its `HarnessAdapter`
interface covers dispatch only; all session state lives in module-level maps
inside each adapter file. So each of seven adapters, around a thousand lines
apiece, independently re-implements a turn-serialization promise chain, the
race where a turn-completed notification arrives before the caller registered
its resolver (solved identically in at least five files), mute flags, and an
approval and question queue. Its own `piFamily.ts` shares one core between two
CLIs through a descriptor struct, which proves the abstraction was available
and simply was not extracted. Adding a harness touches about nineteen places,
five of them hand-written if-chains the compiler cannot check.

## Decision

Split a harness into three parts and make only the smallest one hand-written.

### 1. Manifest — data

```rust
struct HarnessManifest {
    id, label, icon,
    binary: BinarySpec,        // candidate paths + structured identity check
    transport: TransportKind,
    launch: LaunchSpec,        // argv template, env additions, cwd rules
    capabilities: Capabilities,
    catalog: CatalogSpec,
    quirks: Vec<Quirk>,        // version-ranged, see below
    verified_against: VersionRange,
}
```

The registry is built by iterating manifests. There is no harness id union to
extend in eleven places, no label map, no icon record, no availability
if-chain. Everything that is currently a scattered branch becomes a field.

### 2. Codec — the only hand-written logic

```rust
trait Codec {
    fn decode(&mut self, frame: Frame, cx: &mut DecodeCx) -> Vec<SessionEvent>;
    fn encode(&mut self, action: Action, cx: &EncodeCx) -> Vec<Frame>;
}
```

A codec maps wire frames to normalized events and user actions to wire frames.
It may hold small decode state, such as in-flight tool calls and accumulating
partial argument JSON. It owns no process handle, no timer, no turn queue, no
approval queue, no cancellation flag. All of that is the engine's (ADR-0003).

Target size is a few hundred lines. If a codec starts growing a promise chain
or a pending-request map, that is a signal the engine is missing a feature, and
the fix goes in the engine.

### 3. Capabilities — declared

```rust
struct Capabilities {
    steer: bool, compact: bool, questions: bool, plan_mode: bool,
    subagents: bool,
    attachments: Attachments,    // None | LocalPath | Inline { mime }
    resume: ResumeKind,          // None | ProviderId | ClientId
    delta: DeltaMode,            // Append | Snapshot
    effort: EffortSpec,
}
```

MonoCode encodes capability as optional interface methods (`compactContext?`,
`respondQuestion?`, `canSteer?`) that callers probe for individually with
helper predicates. A record is cheaper to read, can be asserted in tests, and
renders straight into the UI's enabled and disabled states.

### Delta semantics are declared, never inferred

Whether a harness streams incremental tokens or resends the message so far is
a fixed property of its protocol, knowable when the manifest is written.

MonoCode infers it per chunk by comparing strings: equality means snapshot, a
longer string having the current text as a prefix means snapshot, otherwise
append. Its own source comments record that an earlier overlap-matching
approach "ate blank lines, headings, table rows, and doubled letters". The
current rule still collapses two consecutive identical multi-character deltas,
and upstream has open reports of dropped spaces between words and lost blank
lines between paragraphs.

kitty reads `DeltaMode` from the manifest and applies the matching rule without
inspecting content. Whitespace-only chunks are content. When a completed
message arrives after tokens have streamed, the engine emits the suffix by
length, not by similarity. This is a correctness property with a test per
harness.

### Quirks are version-ranged data

Minimum CLI version for a model, an effort level that must be renamed for one
model, a startup notice to suppress. Each is a `Quirk` with an explicit version
range. Two rules: a quirk never lives in control flow, and a quirk never
matches on an English message body, because an upstream rewording must not be
able to break us. MonoCode suppresses one notice by regex-matching its prose.

`verified_against` records the CLI version range the codec was tested with.
Outside it the UI shows a warning; newer than tested is a warning, not a
refusal.

### Transports are a separate axis

`transport/` provides byte framing, JSON-RPC, ACP, and loopback HTTP+SSE as
reusable pieces. A codec that speaks JSON-RPC does not implement request
correlation or timeouts. MonoCode has three separate "wait for init with a
timeout" idioms and a JSON-RPC client whose framing assumptions differ per
harness.

## Consequences

- Adding a harness: one manifest, one codec, one fixture directory. The
  compiler enforces the manifest; fixtures enforce the codec.
- The engine gets more complex, because behaviour previously duplicated seven
  times now has to be general enough for all of them. That is the trade and it
  is the right one; generality here is tested once.
- Some harness will eventually need something the engine cannot express. The
  escape hatch is an explicit extension point on the manifest, reviewed as a
  design change, not a private map inside a codec file.
- Fixture recording must be one command. This layer's regressions will come
  from upstream CLI changes, and the only defence is cheap re-recording.
