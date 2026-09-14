# ADR-0005: Storage

Status: proposed

## Context

kitty persists projects, sessions, transcripts, settings and model catalog
caches. Transcripts grow to megabytes, sessions number in the hundreds per
project, and search across them should be instant.

MonoCode's storage is the most instructive part of its codebase because its
comments record measurements. Three findings drive this ADR:

- Its transcript is a single `blocks_json` column, so every save rewrites the
  whole array. Reading a session's summary columns meant walking past the
  blob's overflow pages; the fix was a fourteen-column covering index, rebuilt
  across three migrations, with a recorded improvement from 7.3 ms to 0.24 ms
  for 120 sessions. A separate migration materialized a boolean column purely
  to avoid a `LIKE '%"role":"user"%'` scan over the blob.
- Its session search is a full-table `LIKE` over every lowercased transcript,
  bounded only by a scan cap and a `truncated` flag, despite SQLite FTS5 being
  available in the bundled build.
- Its UI state lives in 56 `localStorage` keys the Rust side cannot see. Session
  folders, archived projects and default model choices are therefore absent
  from its workspace snapshot, so they do not survive a window transfer and are
  lost if webview storage is cleared while the database survives.

Its migration system also carries a repair loop and defensive column checks,
with a comment explaining that a recorded version row can outlive the schema it
describes, because version numbers were reused across builds and corrupted real
users' databases.

## Decision

One SQLite database, WAL, owned by Rust. The frontend owns no durable state.

### Schema

```sql
projects (id, root UNIQUE, name, created_at, last_opened_at, archived)
sessions (id, project_id, harness, model, model_settings, runtime_mode,
          title, provider_session, status, pinned, archived,
          context_used, context_window, created_at, updated_at)
blocks   (session_id, seq, kind, payload, PRIMARY KEY (session_id, seq))
blocks_fts                                  -- FTS5 over block text
turns    (session_id, seq, input_tokens, output_tokens, cache_read, ...)
settings (scope, scope_id, key, value)      -- global | project | session
catalog  (harness, fetched_at, payload)
```

**Blocks are rows.** Appending a block is an insert, and updating the streaming
block is an update of one row. This removes the whole-array rewrite, removes
the need for a wide covering index to avoid blob overflow pages, and removes
the frontend's fingerprinting workaround for stringifying transcripts on the
main thread.

**FTS5 from the first migration.** Search is a query, not a scan.

**Settings are rows, not `localStorage`.** Scoped global, per project, or per
session. Everything the user configures survives a webview storage wipe, moves
with a window transfer, and can be exported and imported. The frontend may
cache settings in memory but never owns them.

**Projects are first-class rows with a stable id.** MonoCode identifies a
project by its normalized path string, which means renaming or moving a folder
orphans every session under it. A row with an id lets us re-point `root` and
keep history.

### Migrations

Forward-only. Version numbers are never reused, enforced by a test that hashes
each migration file and fails if a committed version's content changes. Tests
migrate a fixture database from every historical version to head. No repair
loops, because the failure mode they compensate for is made impossible.

### Concurrency

Connection access is pooled by role: a writer and several readers, with WAL
allowing readers to proceed during writes. MonoCode funnels every command in
the app through one global mutex on a single connection, so notes, reminders,
orchestration and session listing all queue behind each other.

### Files on disk

Anything large or naturally file-shaped stays a file under the app data
directory, referenced from the database by id: attachments, project images,
protocol logs. Checkpoints, if built, follow the same rule.

### Checkpoints (later, not in prototype 1)

MonoCode's design here is good and worth copying when the time comes: snapshot
files before an edit so the user can undo exactly what an agent changed, driven
by tool-start events, with git used only as an oracle for whether a path exists
in `HEAD` rather than as the storage mechanism. Its weak points to avoid are
re-reading and parsing every other session's manifest on each status check, and
copying up to 500 whole files per turn.

## Consequences

- Slightly more schema work up front than a JSON blob, and block payloads still
  need a serialized form. The difference is that the row is the unit of change.
- Transcript virtualization gets easier because pages of blocks can be queried
  by range.
- Export, import and a future sync story all become tractable, because there is
  one place state lives.
