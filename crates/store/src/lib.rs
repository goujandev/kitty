//! SQLite persistence.
//!
//! Owned by Rust. The frontend holds no durable state (ADR-0005), so a wiped
//! webview loses nothing and a second window sees the same data.
//!
//! The shape that matters is that a transcript is **rows**, not one JSON blob
//! per session. Appending is an insert; extending the streaming block is an
//! update of one row. `MonoCode` rewrites a multi-megabyte array on every save
//! and then works around the cost with a fourteen-column covering index and a
//! `WeakMap` fingerprint to avoid stringifying on the main thread. None of
//! that is needed here.

pub mod ids;
mod migrations;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub use ids::{new_id, now_ms};
pub use kitty_core::BlockKind;

#[derive(Debug)]
pub enum StoreError {
    Open { message: String },
    Query { message: String },
    Missing { what: String },
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open { message } | Self::Query { message } => f.write_str(message),
            Self::Missing { what } => write!(f, "{what} does not exist"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Query {
            message: e.to_string(),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub root: String,
    pub name: String,
    pub created_at: i64,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub project_id: String,
    pub harness: String,
    pub model: Option<String>,
    pub provider_session: Option<String>,
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub seq: i64,
    pub kind: BlockKind,
    pub text: String,
    pub created_at: i64,
}

/// A search hit, with the block it came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub session_id: String,
    pub seq: i64,
    pub snippet: String,
}

/// The database.
///
/// One writer, because SQLite has one writer anyway, and a small pool of
/// readers so a listing does not queue behind a transcript append. `MonoCode`
/// funnels every command in the app through a single connection mutex.
pub struct Store {
    path: Option<PathBuf>,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
}

impl Store {
    /// Opens, creating the file and schema if needed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| StoreError::Open {
                message: format!("could not create {}: {e}", parent.display()),
            })?;
        }
        let writer = Connection::open(&path).map_err(|e| StoreError::Open {
            message: format!("could not open {}: {e}", path.display()),
        })?;
        configure(&writer)?;
        migrations::migrate(&writer)?;

        Ok(Self {
            path: Some(path),
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
        })
    }

    /// An ephemeral database. Tests use this; so does a first run that has
    /// nowhere to write.
    pub fn in_memory() -> Result<Self> {
        let writer = Connection::open_in_memory().map_err(|e| StoreError::Open {
            message: e.to_string(),
        })?;
        configure(&writer)?;
        migrations::migrate(&writer)?;
        Ok(Self {
            path: None,
            writer: Mutex::new(writer),
            readers: Mutex::new(Vec::new()),
        })
    }

    /// Runs a read. Uses a pooled reader when there is a file to open; an
    /// in-memory database has only the one connection to read from.
    fn read<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let Some(path) = &self.path else {
            let guard = self.writer.lock().map_err(poisoned)?;
            return f(&guard);
        };

        let conn = {
            let mut pool = self.readers.lock().map_err(poisoned)?;
            pool.pop()
        };
        let conn = if let Some(conn) = conn {
            conn
        } else {
            let conn = Connection::open(path).map_err(|e| StoreError::Open {
                message: e.to_string(),
            })?;
            configure(&conn)?;
            conn
        };

        let result = f(&conn);

        if let Ok(mut pool) = self.readers.lock() {
            // A handful is plenty; the app reads from a few places at once.
            if pool.len() < 4 {
                pool.push(conn);
            }
        }
        result
    }

    fn write<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let guard = self.writer.lock().map_err(poisoned)?;
        f(&guard)
    }

    /// Finds or creates the project for a directory, and marks it opened.
    pub fn open_project(&self, root: &Path) -> Result<Project> {
        let root_text = root.to_string_lossy().into_owned();
        let name = root
            .file_name()
            .map_or_else(|| root_text.clone(), |n| n.to_string_lossy().into_owned());
        let now = now_ms();

        self.write(|conn| {
            conn.execute(
                "INSERT INTO projects (id, root, name, created_at, last_opened_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)
                 ON CONFLICT(root) DO UPDATE SET last_opened_at = ?4",
                params![new_id(), root_text, name, now],
            )?;
            let project = conn.query_row(
                "SELECT id, root, name, created_at, last_opened_at FROM projects WHERE root = ?1",
                params![root_text],
                project_from_row,
            )?;
            Ok(project)
        })
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, root, name, created_at, last_opened_at
                 FROM projects ORDER BY last_opened_at DESC",
            )?;
            let rows = stmt
                .query_map([], project_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn create_session(
        &self,
        project_id: &str,
        harness: &str,
        model: Option<&str>,
    ) -> Result<SessionRow> {
        let id = new_id();
        let now = now_ms();
        self.write(|conn| {
            conn.execute(
                "INSERT INTO sessions (id, project_id, harness, model, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![id, project_id, harness, model, now],
            )?;
            Ok(())
        })?;
        self.session(&id)
    }

    pub fn session(&self, id: &str) -> Result<SessionRow> {
        self.read(|conn| {
            conn.query_row(
                "SELECT id, project_id, harness, model, provider_session, title, created_at, updated_at
                 FROM sessions WHERE id = ?1",
                params![id],
                session_from_row,
            )
            .optional()?
            .ok_or_else(|| StoreError::Missing {
                what: format!("session {id}"),
            })
        })
    }

    pub fn list_sessions(&self, project_id: &str) -> Result<Vec<SessionRow>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT id, project_id, harness, model, provider_session, title, created_at, updated_at
                 FROM sessions WHERE project_id = ?1 ORDER BY updated_at DESC",
            )?;
            let rows = stmt
                .query_map(params![project_id], session_from_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Records the vendor's own session id, which is what resume needs.
    pub fn set_provider_session(&self, session_id: &str, provider: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "UPDATE sessions SET provider_session = ?2, updated_at = ?3 WHERE id = ?1",
                params![session_id, provider, now_ms()],
            )?;
            Ok(())
        })
    }

    pub fn set_model(&self, session_id: &str, model: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "UPDATE sessions SET model = ?2, updated_at = ?3 WHERE id = ?1",
                params![session_id, model, now_ms()],
            )?;
            Ok(())
        })
    }

    /// The first user message makes a serviceable title until slice 4 asks a
    /// model for a better one.
    pub fn set_title_if_unset(&self, session_id: &str, title: &str) -> Result<()> {
        let trimmed: String = title.trim().chars().take(80).collect();
        if trimmed.is_empty() {
            return Ok(());
        }
        self.write(|conn| {
            conn.execute(
                "UPDATE sessions SET title = ?2, updated_at = ?3
                 WHERE id = ?1 AND (title IS NULL OR title = '')",
                params![session_id, trimmed, now_ms()],
            )?;
            Ok(())
        })
    }

    /// Appends a block and returns its sequence number.
    pub fn append_block(&self, session_id: &str, kind: BlockKind, text: &str) -> Result<i64> {
        let now = now_ms();
        self.write(|conn| {
            let seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM blocks WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO blocks (session_id, seq, kind, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![session_id, seq, kind.as_str(), text, now],
            )?;
            conn.execute(
                "INSERT INTO blocks_fts (text, session_id, seq) VALUES (?1, ?2, ?3)",
                params![text, session_id, seq],
            )?;
            conn.execute(
                "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
                params![session_id, now],
            )?;
            Ok(seq)
        })
    }

    /// Replaces a block's text. One row, whatever the transcript's size.
    pub fn set_block_text(&self, session_id: &str, seq: i64, text: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "UPDATE blocks SET text = ?3 WHERE session_id = ?1 AND seq = ?2",
                params![session_id, seq, text],
            )?;
            conn.execute(
                "UPDATE blocks_fts SET text = ?3 WHERE session_id = ?1 AND seq = ?2",
                params![session_id, seq, text],
            )?;
            conn.execute(
                "UPDATE sessions SET updated_at = ?2 WHERE id = ?1",
                params![session_id, now_ms()],
            )?;
            Ok(())
        })
    }

    /// Drops a block that never received any text, so an interrupted turn
    /// does not leave an empty bubble in the transcript.
    pub fn discard_block_if_empty(&self, session_id: &str, seq: i64) -> Result<bool> {
        self.write(|conn| {
            let removed = conn.execute(
                "DELETE FROM blocks WHERE session_id = ?1 AND seq = ?2 AND text = ''",
                params![session_id, seq],
            )?;
            if removed > 0 {
                conn.execute(
                    "DELETE FROM blocks_fts WHERE session_id = ?1 AND seq = ?2",
                    params![session_id, seq],
                )?;
            }
            Ok(removed > 0)
        })
    }

    pub fn blocks(&self, session_id: &str) -> Result<Vec<Block>> {
        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT seq, kind, text, created_at FROM blocks
                 WHERE session_id = ?1 ORDER BY seq",
            )?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    let kind: String = row.get(1)?;
                    Ok(Block {
                        seq: row.get(0)?,
                        kind: BlockKind::parse(&kind).unwrap_or(BlockKind::Assistant),
                        text: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn record_turn(
        &self,
        session_id: &str,
        stop: &str,
        usage: kitty_core::Usage,
    ) -> Result<()> {
        self.write(|conn| {
            let seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), -1) + 1 FROM turns WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )?;
            conn.execute(
                "INSERT INTO turns
                     (session_id, seq, stop, input_tokens, output_tokens,
                      cache_read, cache_write, ended_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session_id,
                    seq,
                    stop,
                    i64::try_from(usage.input_tokens).unwrap_or(i64::MAX),
                    i64::try_from(usage.output_tokens).unwrap_or(i64::MAX),
                    i64::try_from(usage.cache_read_tokens).unwrap_or(i64::MAX),
                    i64::try_from(usage.cache_write_tokens).unwrap_or(i64::MAX),
                    now_ms(),
                ],
            )?;
            Ok(())
        })
    }

    /// Full-text search across every transcript. An index, not a scan.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        // FTS5 treats punctuation as syntax. Quote each word so a user typing
        // `foo(bar` gets results rather than a syntax error.
        let safe: String = trimmed
            .split_whitespace()
            .map(|word| format!("\"{}\"", word.replace('"', "")))
            .collect::<Vec<_>>()
            .join(" ");

        self.read(|conn| {
            let mut stmt = conn.prepare(
                "SELECT session_id, seq, snippet(blocks_fts, 0, '[', ']', '…', 12)
                 FROM blocks_fts WHERE blocks_fts MATCH ?1
                 ORDER BY rank LIMIT ?2",
            )?;
            let rows = stmt
                .query_map(params![safe, i64::try_from(limit).unwrap_or(50)], |row| {
                    Ok(Hit {
                        session_id: row.get(0)?,
                        seq: row.get(1)?,
                        snippet: row.get(2)?,
                    })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn set_setting(&self, scope: &str, scope_id: &str, key: &str, value: &str) -> Result<()> {
        self.write(|conn| {
            conn.execute(
                "INSERT INTO settings (scope, scope_id, key, value) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(scope, scope_id, key) DO UPDATE SET value = ?4",
                params![scope, scope_id, key, value],
            )?;
            Ok(())
        })
    }

    pub fn setting(&self, scope: &str, scope_id: &str, key: &str) -> Result<Option<String>> {
        self.read(|conn| {
            let value = conn
                .query_row(
                    "SELECT value FROM settings WHERE scope = ?1 AND scope_id = ?2 AND key = ?3",
                    params![scope, scope_id, key],
                    |row| row.get(0),
                )
                .optional()?;
            Ok(value)
        })
    }
}

fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA foreign_keys = ON;
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}

fn poisoned<T>(_: T) -> StoreError {
    StoreError::Query {
        message: "the database lock was poisoned by a panic".to_owned(),
    }
}

fn project_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        root: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        last_opened_at: row.get(4)?,
    })
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRow> {
    Ok(SessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        harness: row.get(2)?,
        model: row.get(3)?,
        provider_session: row.get(4)?,
        title: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}
