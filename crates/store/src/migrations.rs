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
pub const MIGRATIONS: &[Migration] = &[
    Migration {
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
    },
    Migration {
        version: 2,
        name: "block_meta",
        sql: r"
-- Tool rows need more than a line of text: what ran, how it ended, and what
-- it produced. Kept as JSON in one column rather than a table, because the
-- shape is the harness's and will change with it.
ALTER TABLE blocks ADD COLUMN meta TEXT;
",
    },
    Migration {
        version: 3,
        name: "session_effort",
        sql: r"
-- Reasoning effort is chosen per session alongside the model, and both CLIs
-- report which levels each model accepts.
ALTER TABLE sessions ADD COLUMN effort TEXT;
",
    },
    Migration {
        version: 4,
        name: "projects_without_a_folder",
        sql: r"
-- A project is a folder, or it is nothing at all. One with no root is a single
-- conversation with nothing behind it: no codebase, no working directory worth
-- the name, and so nothing for the agent to read that was not typed into it.
--
-- Rebuilt rather than altered, because `root` was declared NOT NULL and SQLite
-- cannot relax that in place. This is the order the SQLite manual gives for
-- rebuilding a table other tables point at: copy, drop, rename -- never rename
-- first. A rename rewrites every foreign key that named the old table so it
-- names the new one, which here would leave `sessions` pointing at the copy and
-- dropping the copy would cascade every transcript in the database into
-- nothing. The runner has foreign keys switched off around this.
CREATE TABLE projects_new (
    id             TEXT PRIMARY KEY,
    root           TEXT UNIQUE,
    name           TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    last_opened_at INTEGER NOT NULL
);

INSERT INTO projects_new (id, root, name, created_at, last_opened_at)
    SELECT id, root, name, created_at, last_opened_at FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
",
    },
    Migration {
        version: 5,
        name: "repair_sessions_foreign_key",
        sql: r"
-- Repairs a database that ran the first version of migration 4.
--
-- That version renamed `projects` out of the way before building its
-- replacement, and SQLite helpfully rewrote every foreign key naming it so
-- they named the copy instead. `sessions` then pointed at `projects_old`, the
-- copy was dropped, and the drop cascaded every session -- and through them
-- every block and turn -- out of the database. What was left was a `sessions`
-- table referencing a table that no longer existed, so creating a new one
-- failed with `no such table: main.projects_old`.
--
-- The rows are gone and nothing here can bring them back. This puts the schema
-- right so the app works again, and is a harmless rebuild on a database that
-- never saw the bad version.
CREATE TABLE sessions_new (
    id               TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    harness          TEXT NOT NULL,
    model            TEXT,
    provider_session TEXT,
    title            TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    effort           TEXT
);

INSERT INTO sessions_new
       (id, project_id, harness, model, provider_session, title,
        created_at, updated_at, effort)
    SELECT id, project_id, harness, model, provider_session, title,
           created_at, updated_at, effort
      FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;

-- Dropped with the table it indexed.
CREATE INDEX IF NOT EXISTS sessions_by_project
    ON sessions(project_id, updated_at DESC);

-- `blocks_fts` is a virtual table with no foreign key, so the cascade went
-- around it and left rows describing conversations that no longer exist.
-- Search would offer them and open nothing.
DELETE FROM blocks_fts WHERE session_id NOT IN (SELECT id FROM sessions);
",
    },
    Migration {
        version: 6,
        name: "manual_order",
        sql: r"
-- Lists stay where they are put.
--
-- Projects were ordered by `last_opened_at` and conversations by `updated_at`,
-- so opening one or replying in one moved it. A list that reshuffles under the
-- cursor cannot be learned: the row you were about to click is somewhere else
-- by the time you get there.
--
-- Two plain ALTERs and two UPDATEs. No table is rebuilt and nothing references
-- these columns, which after migration 4 is a property worth stating out loud.
ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

-- Seeded from creation time so the first ordering is the order things were
-- made, newest first, and nothing appears to jump on the upgrade.
UPDATE projects SET sort_order = created_at;
UPDATE sessions SET sort_order = created_at;
",
    },
];

/// Applies anything not yet recorded. Safe to call on every open.
pub fn migrate(conn: &Connection) -> Result<()> {
    migrate_through(conn, i64::MAX)
}

/// Applies everything up to and including `highest`.
///
/// The bound exists for the tests: a migration that rewrites a table can only
/// be shown to carry the old rows across if the old rows are there first.
fn migrate_through(conn: &Connection, highest: i64) -> Result<()> {
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

    // Off for the duration, on everywhere else, which is what the SQLite
    // manual's table-rebuild procedure opens with. A migration that replaces a
    // table has to drop the old one out from under the rows that reference it,
    // and SQLite answers a DROP on a parent table by cascading its children
    // into oblivion. Enforcement cannot be toggled inside a transaction, so it
    // is toggled around the whole run.
    conn.execute_batch("PRAGMA foreign_keys = OFF")?;
    let result = apply(conn, applied, highest);
    conn.execute_batch("PRAGMA foreign_keys = ON")?;
    result
}

fn apply(conn: &Connection, applied: i64, highest: i64) -> Result<()> {
    for migration in MIGRATIONS {
        if migration.version <= applied || migration.version > highest {
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
    use super::{migrate, migrate_through, MIGRATIONS};
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
        let expected: &[(i64, u64)] = &[
            (1, 0xfad9_77ac_286d_e926),
            (2, 0xef7a_aac6_fcfc_d9e1),
            (3, 0x2ee3_cea9_5d56_6d62),
            (4, 0xf898_216c_1d8a_28bc),
            (5, 0xc76e_dc4c_7eab_a7b4),
            (6, 0x927c_1f8b_f544_650e),
        ];

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

    /// The rebuild in migration 4 drops the table every session points at.
    ///
    /// This is the test that made it safe to write: a database is taken to
    /// version 3, filled the way a real one would be, and then pushed the rest
    /// of the way. If the pragmas were wrong the commit fails on a foreign key
    /// and the rows are gone, which is a thing you want to find out here.
    #[test]
    fn the_project_rebuild_carries_sessions_across() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
        migrate_through(&conn, 3).expect("up to 3");

        conn.execute_batch(
            "INSERT INTO projects (id, root, name, created_at, last_opened_at)
                 VALUES ('p1', 'C:\\code\\thing', 'thing', 1, 2);
             INSERT INTO sessions (id, project_id, harness, created_at, updated_at)
                 VALUES ('s1', 'p1', 'claude', 1, 2);
             INSERT INTO blocks (session_id, seq, kind, text, created_at)
                 VALUES ('s1', 0, 'user', 'still here?', 1);",
        )
        .expect("seed");

        migrate(&conn).expect("the rebuild must not lose the folder projects");

        let (root, name): (Option<String>, String) = conn
            .query_row("SELECT root, name FROM projects WHERE id = 'p1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("the project survived");
        assert_eq!(root.as_deref(), Some("C:\\code\\thing"));
        assert_eq!(name, "thing");

        let text: String = conn
            .query_row(
                "SELECT b.text FROM blocks b
                   JOIN sessions s ON s.id = b.session_id
                  WHERE s.project_id = 'p1'",
                [],
                |r| r.get(0),
            )
            .expect("the transcript survived");
        assert_eq!(text, "still here?");

        // The point of the whole exercise.
        conn.execute_batch(
            "INSERT INTO projects (id, root, name, created_at, last_opened_at)
                 VALUES ('p2', NULL, 'image ideas', 1, 2);
             INSERT INTO projects (id, root, name, created_at, last_opened_at)
                 VALUES ('p3', NULL, 'why is my dns broken', 1, 2);",
        )
        .expect("a project with no folder, twice, because UNIQUE ignores NULL");

        // And the cascade still reaches the blocks through the rebuilt table.
        conn.execute("DELETE FROM projects WHERE id = 'p1'", [])
            .expect("delete");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))
            .expect("count");
        assert_eq!(left, 0, "the foreign key survived the swap");
    }

    /// Reproduces the database the first version of migration 4 produced, and
    /// proves migration 5 makes it usable again.
    ///
    /// The symptom was `no such table: main.projects_old` on every attempt to
    /// start a conversation, which is what a foreign key pointing at a table
    /// that was dropped looks like from the outside.
    #[test]
    fn a_session_table_pointing_at_the_dropped_copy_is_repaired() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch("PRAGMA foreign_keys = ON").expect("fk");
        migrate_through(&conn, 4).expect("up to 4");

        // Exactly the schema found in the wild: `sessions` naming a table that
        // is not there, and no rows left because dropping it cascaded.
        conn.execute_batch(
            r#"PRAGMA foreign_keys = OFF;
               DROP TABLE sessions;
               CREATE TABLE sessions (
                   id               TEXT PRIMARY KEY,
                   project_id       TEXT NOT NULL
                                    REFERENCES "projects_old"(id) ON DELETE CASCADE,
                   harness          TEXT NOT NULL,
                   model            TEXT,
                   provider_session TEXT,
                   title            TEXT,
                   created_at       INTEGER NOT NULL,
                   updated_at       INTEGER NOT NULL
               , effort TEXT);
               INSERT INTO projects (id, root, name, created_at, last_opened_at)
                   VALUES ('p1', 'C:\left', 'left', 1, 2);
               INSERT INTO sessions (id, project_id, harness, created_at, updated_at)
                   VALUES ('s1', 'p1', 'claude', 1, 2);
               INSERT INTO blocks_fts (text, session_id, seq)
                   VALUES ('a conversation that is gone', 'ghost', 0);
               PRAGMA foreign_keys = ON;"#,
        )
        .expect("break it the way it was broken");

        // The failure the user saw, before the repair.
        let before = conn.execute(
            "INSERT INTO sessions (id, project_id, harness, created_at, updated_at)
                 VALUES ('s2', 'p1', 'claude', 1, 2)",
            [],
        );
        assert!(before.is_err(), "this is the bug; it must reproduce");

        migrate(&conn).expect("repair");

        // Whatever was still in the table is carried across.
        let kept: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions WHERE id = 's1'", [], |r| {
                r.get(0)
            })
            .expect("count");
        assert_eq!(kept, 1);

        conn.execute(
            "INSERT INTO sessions (id, project_id, harness, created_at, updated_at)
                 VALUES ('s3', 'p1', 'claude', 1, 2)",
            [],
        )
        .expect("a new conversation can be created again");

        // And the cascade reaches through the rebuilt table.
        conn.execute("DELETE FROM projects WHERE id = 'p1'", [])
            .expect("delete");
        let left: i64 = conn
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .expect("count");
        assert_eq!(left, 0, "the foreign key names projects again");

        // Search rows for conversations that no longer exist are swept, or
        // search offers hits that open nothing.
        let ghosts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM blocks_fts WHERE session_id = 'ghost'",
                [],
                |r| r.get(0),
            )
            .expect("count");
        assert_eq!(ghosts, 0);
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
