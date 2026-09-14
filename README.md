# kitty

A desktop UI for the coding agents you already have.

kitty drives the vendor CLIs you have installed and logged into. It holds no
API keys and sells no tokens. If `claude` and `codex` work in your terminal,
kitty works.

Windows only. See [ADR-0001](docs/adr/0001-stack-and-process-model.md).

## Status

Slice 1 of the first prototype: **kitty sees your agents.** It finds Claude Code
and Codex, identifies them by version, reports whether each is signed in, and
tells you the exact command to fix anything that is not ready.

There is no chat yet. That is slice 2 (see [PROTOTYPE-1.md](docs/PROTOTYPE-1.md)).

## Running it

Needs Node 20+ and a stable Rust toolchain.

```bash
npm install
npm start          # tauri dev
```

Without the GUI, the same scan runs headless:

```bash
cargo run -p kitty-probe --example probe
```

```text
Claude Code (Anthropic)  [ready]
  install   2.1.270 at C:\Users\you\AppData\Roaming\npm\claude.cmd
  login     signed in (max), token valid for 2h
```

## Checks

```bash
npm run check                                        # wire contract + tsc
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

CI runs all of these on Windows.

`src/ipc/contract.json` is generated from the Rust types by a test. If you
change a wire type, regenerate it and update `src/ipc/bindings.ts`:

```bash
UPDATE_CONTRACT=1 cargo test -p kitty-core
```

## A note on your credentials

kitty reads the login files that Claude Code and Codex already keep, so it can
tell you whether you are signed in. It never writes to them, never refreshes a
token, and never identifies itself as another vendor's client. That rule is
enforced by a test, not just by intent. See
[ADR-0004](docs/adr/0004-credentials-and-cli-discovery.md).

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design |
| [PROTOTYPE-1.md](docs/PROTOTYPE-1.md) | First prototype: scope, slices, acceptance |
| [MODEL-CATALOG.md](docs/MODEL-CATALOG.md) | How models are discovered |
| [LESSONS-FROM-MONOCODE.md](docs/LESSONS-FROM-MONOCODE.md) | What a close read of the closest existing product established |
| [adr/](docs/adr/) | Decisions with trade-offs |

### Decisions

- [0001](docs/adr/0001-stack-and-process-model.md) — Tauri, Rust host, TypeScript frontend, Windows only
- [0002](docs/adr/0002-harness-model.md) — Manifests, codecs, declared capabilities
- [0003](docs/adr/0003-session-engine-in-rust.md) — The session engine lives in Rust
- [0004](docs/adr/0004-credentials-and-cli-discovery.md) — Never write another tool's credentials
- [0005](docs/adr/0005-storage.md) — SQLite, blocks as rows, FTS5
- [0006](docs/adr/0006-frontend-state-and-rendering.md) — External stores, virtualized transcript

## Credit

The design owes a great deal to [MonoCode](https://github.com/hardbeat920/monocode)
(MIT), which proved this product shape works. Where kitty differs, the reasons
are recorded with evidence in `docs/LESSONS-FROM-MONOCODE.md`.

## Licence

MIT.
