# ADR-0006: Frontend state and rendering

Status: proposed

## Context

The frontend's hard problem is one screen: a transcript that grows to thousands
of blocks while text streams into its last block at high frequency, next to an
input the user is typing in, with a sidebar, file tree and diff panes on screen.

MonoCode is the cautionary example, and the numbers are specific. `App.tsx` is
a single 6,509-line component containing 36 `useState`, 57 `useRef`, 151
`useCallback`, 36 `useEffect`, 16 `useMemo` and zero `useReducer`. Roughly
sixty refs mirror state and are assigned during render. The session array's ref
mirror is updated before `setState`, making the ref authoritative and React
state a rendering artifact. The sidebar receives 76 props against an 82-field
props type; a session pane receives 73. Pane props are a 32-key object literal
built inline in JSX, which means the `memo` on every pane below it never hits.
Consequently any session update re-renders the monolith and re-evaluates all
151 callback dependency arrays, and that is the hot path during streaming.

The same codebase also shows what was done right: `useSyncExternalStore` is
used 45 times against about twenty module-level singleton stores for peripheral
state such as settings, models, file index and recents. The pattern was
reinvented twenty times but never applied to core state.

Its performance work is real and in places measured: events batched on
`requestAnimationFrame` with a 32 ms timer fallback when the document is
hidden, approvals bypassing the batch for latency, identity-stable sets so
referential equality survives unrelated renders, virtualization in the diff
view, and `content-visibility: auto` on transcript turns. All of it is applied
around the monolith rather than to it.

## Decision

### State

- One frontend store fed by batched `SessionEvent`s from the engine. It is a
  mirror of authoritative Rust state, not a second source of truth.
- Components subscribe through selectors and re-render only when their slice
  changes. Zustand or an equivalent with `useSyncExternalStore` semantics.
- **No state mirrored into refs.** A ref is for a DOM node or a genuinely
  mutable non-rendered value. If something needs stable identity, it belongs in
  the store.
- **No component takes more than roughly eight props.** Beyond that it should
  read from the store. This is a lint-enforceable rule and it is the single
  most effective guard against the 76-prop sidebar.
- No God component. The shell composes regions; regions own nothing.

### Rendering

- **The transcript is virtualized from the first commit.** Retrofitting
  virtualization onto a transcript that already has a dozen block types is
  where this kind of app goes to die.
- **Streaming updates the smallest possible subtree.** The in-progress text
  node subscribes to its own slice; appending a token must not re-render
  completed blocks.
- Completed blocks are immutable and memoized by block id. Markdown for a
  completed block is rendered once and cached; only the trailing block
  re-renders while streaming.
- Batch engine events per animation frame, with a timer fallback when the
  document is hidden. Approvals and questions bypass the batch, because
  latency on an interactive prompt is user-visible in a way a token is not.
- `content-visibility: auto` with an intrinsic size hint on off-screen turns.
- Measure before optimizing anything else. A scripted benchmark that replays a
  recorded session at full rate and reports dropped frames belongs in CI, so a
  regression is caught rather than reported.

### Framework

React 19, conditional on the rules above. The risk is honest: React makes
MonoCode's outcome the path of least resistance, and the discipline has to come
from the architecture rather than from the framework. Solid remains the
alternative worth reconsidering before the transcript is built, since
fine-grained signals make high-frequency streaming into a long list a
non-problem and both major dependencies, CodeMirror and xterm.js, are
framework-neutral. See ADR-0001.

## Consequences

- More indirection than reaching for `useState`: a store, selectors, and a
  rule about props. That indirection is the deliverable.
- The store is the testable seam. Navigation, session switching and event
  application become unit tests with no renderer.
- Because the engine owns session state, the frontend store can be rebuilt from
  scratch at any time by replaying from the database, which makes the whole
  layer disposable in a way MonoCode's is not.
