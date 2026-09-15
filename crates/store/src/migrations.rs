//! Forward-only schema migrations.
//!
//! ADR-0005: version numbers are never reused. `MonoCode` carries a repair
//! loop and defensive column checks, with a comment explaining that a recorded
//! version row can outlive the schema it describes, because versions *were*
//! reused across builds and corrupted real users' databases. The test at the
//! bottom of this file makes that impossible here: every migration's text is
//! pinned by a checksum, so editing a released one fails the build rather than
//! silently diverging from what shipped.

use rusqlite::{Connection, Result};

/// One migration: a version, a name for humans, and the SQL.
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

/// Every migration, in order. Append only.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial",
    sql: r"
CREATE TABLE projects (
    id             TEXT PRIMARY KEY,
    root           TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
);

CREATE TABLE sessions (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    harness          TEXT NOT NULL,
    model            TEXT,
    provider_session TEXT,
    title            TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

CREATE INDEX sessions_by_project ON sessions(project_id, updated_at DESC);

-- One row per block, not one JSON blob per session (ADR-0005). Appending is
-- an insert and updating the streaming block touches one row, so a long
-- transcript never has to be rewritten to add a word to it.
CREATE TABLE blocks (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE turns (
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    stop           TEXT NOT NULL,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_read     INTEGER NOT NULL DEFAULT 0,
    cache_write    INTEGER NOT NULL DEFAULT 0,
    ended_at       INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

-- Settings live here rather than in the webview's localStorage, so they
-- survive a storage wipe and are visible to the Rust side (ADR-0005).
CREATE TABLE settings (
    scope    TEXT NOT NULL,
    scope_id TEXT NOT NULL DEFAULT '',
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (scope, scope_id, key)
) WITHOUT ROWID;

-- Search is an index, not a scan over every transcript.
CREATE VIRTUAL TABLE blocks_fts USING fts5(
    text,
    session_id UNINDEXED,
    seq        UNINDEXED,
    tokenize = 'unicode61'
);
",
}];

/// Applies anything not yet recorded. Safe to call on every open.
pub fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
             version    INTEGER PRIMARY KEY,
             name       TEXT NOT NULL,
             applied_at INTEGER NOT NULL
         )",
    )?;

    let applied: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    for migration in MIGRATIONS {
        if migration.version <= applied {
            continue;
        }
        // One transaction per migration: a failure leaves the database at the
        // last good version rather than half-way through this one.
        conn.execute_batch("BEGIN")?;
        match conn.execute_batch(migration.sql).and_then(|()| {
            conn.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![migration.version, migration.name, crate::ids::now_ms()],
            )
            .map(|_| ())
        }) {
            Ok(()) => conn.execute_batch("COMMIT")?,
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(e);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{migrate, MIGRATIONS};
    use rusqlite::Connection;

    /// Cheap content hash. Not cryptographic; it only has to notice an edit.
    fn checksum(text: &str) -> u64 {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in text.bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        hash
    }

    /// Pins every released migration. Changing one is the mistake that
    /// corrupted `MonoCode` users' databases, so it fails here instead.
    ///
    /// To add a schema change, append a new migration. Never edit an old one.
    /// If you are changing version 1 before anyone has a database, update the
    /// expected value deliberately.
    #[test]
    fn released_migrations_are_immutable() {
        let expected: &[(i64, u64)] = &[(1, 0xfad9_77ac_286d_e926)];

        assert_eq!(
            MIGRATIONS.len(),
            expected.len(),
            "a migration was added; pin its checksum here"
        );
        for (migration, (version, sum)) in MIGRATIONS.iter().zip(expected) {
            assert_eq!(migration.version, *version);
            assert_eq!(
                checksum(migration.sql),
                *sum,
                "migration {} was edited after release; append a new one instead",
                migration.version
            );
        }
    }

    #[test]
    fn versions_are_unique_and_ascending() {
        let mut last = 0;
        for migration in MIGRATIONS {
            assert!(
                migration.version > last,
                "migration versions must ascend and never repeat"
            );
            last = migration.version;
        }
    }

    #[test]
    fn migrating_a_fresh_database_creates_every_table() {
        let conn = Connection::open_in_memory().expect("open");
        migrate(&conn).expect("migrate");

        for table in [
            "projects",
            "sessions",
            "blocks",
            "turns",
            "settings",
            "blocks_fts",
            "schema_migrations",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query");
            assert_eq!(count, 1, "{table} is missing");
        }
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let conn = Connection::open_in_memory().expect("open");
        migrate(&conn).expect("first");
        migrate(&conn).expect("second must not fail");

        let applied: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .expect("query");
        assert_eq!(
            applied,
            i64::try_from(MIGRATIONS.len()).expect("migration count")
        );
    }
}
