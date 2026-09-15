//! Running sessions, and the bookkeeping between an engine event and a row in
//! the transcript.
//!
//! This is where ADR-0003 earns its keep. Events are decoded, persisted, and
//! resolved into block identities here in Rust; the frontend receives numbered
//! rows and text to append. It never decides what a transcript is, so it can
//! be rebuilt from the database at any time.
//!
//! Two throttles, for different reasons:
//!
//! * **Emit** on a short timer, so a burst of deltas crosses IPC once rather
//!   than once per token. `MonoCode` emits one app-wide message per line.
//! * **Persist** on a longer timer, plus always at a boundary. A crash loses
//!   at most the last fraction of a second of one block, and a long turn does
//!   not write to disk on every token.

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kitty_core::{BlockKind, SessionEvent, StopReason, ToolStatus, TranscriptEvent, Usage};
use kitty_engine::Session;
use kitty_store::Store;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Coalescing window for events going to the webview.
const EMIT_EVERY: Duration = Duration::from_millis(16);
/// How often a growing block is written to disk while it streams.
const PERSIST_EVERY: Duration = Duration::from_millis(300);

/// The event the frontend listens for.
pub const TRANSCRIPT_EVENT: &str = "kitty://transcript";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Batch<'a> {
    session_id: &'a str,
    events: &'a [TranscriptEvent],
}

/// A session the app is holding open.
pub struct Live {
    pub session: Session,
}

/// Every open session, by our session id.
pub type Registry = Arc<Mutex<HashMap<String, Live>>>;

/// Starts pumping a session's events into the store and the window.
pub fn pump(app: AppHandle, store: Arc<Store>, session_id: String, events: Receiver<SessionEvent>) {
    std::thread::spawn(move || {
        Transcript {
            app,
            store,
            session_id,
            open: HashMap::new(),
            tools: HashMap::new(),
            last_closed: HashMap::new(),
            pending: Vec::new(),
            usage: Usage::default(),
            last_emit: Instant::now(),
        }
        .run(&events);
    });
}

/// A block currently being written to.
struct OpenBlock {
    seq: i64,
    text: String,
    last_persisted: Instant,
    dirty: bool,
}

struct Transcript {
    app: AppHandle,
    store: Arc<Store>,
    session_id: String,
    /// At most one open block per kind: an assistant message and its reasoning
    /// can stream at the same time.
    open: HashMap<BlockKind, OpenBlock>,
    /// Tool rows in flight, from the harness's call id to our block sequence.
    tools: HashMap<String, i64>,
    /// Text of the last block closed for each kind.
    ///
    /// A tool starting closes the open text block, and the harness may then
    /// send its authoritative snapshot afterwards. Without this the snapshot
    /// would be written again as a second, identical bubble.
    last_closed: HashMap<BlockKind, String>,
    pending: Vec<TranscriptEvent>,
    usage: Usage,
    last_emit: Instant,
}

impl Transcript {
    fn run(mut self, events: &Receiver<SessionEvent>) {
        loop {
            match events.recv_timeout(EMIT_EVERY) {
                Ok(event) => self.on_event(event),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
            if self.last_emit.elapsed() >= EMIT_EVERY {
                self.flush_events();
            }
        }
        // The engine is gone. Close anything still open so a killed CLI does
        // not leave a half-written block behind.
        self.close_all();
        self.abandon_tools();
        self.flush_events();
    }

    fn on_event(&mut self, event: SessionEvent) {
        match event {
            SessionEvent::Started {
                provider_session,
                model,
            } => {
                if let Some(provider) = &provider_session {
                    let _ = self.store.set_provider_session(&self.session_id, provider);
                }
                if let Some(model) = &model {
                    let _ = self.store.set_model(&self.session_id, model);
                }
                self.pending.push(TranscriptEvent::SessionReady { model });
            }

            // A block is created on first text, not on turn start, so a turn
            // that produces nothing leaves no empty bubble.
            SessionEvent::MessageDelta { text } => self.delta(BlockKind::Assistant, &text),
            SessionEvent::ReasoningDelta { text } => self.delta(BlockKind::Reasoning, &text),

            SessionEvent::MessageDone { text } => self.finish(BlockKind::Assistant, Some(&text)),
            SessionEvent::ReasoningDone => self.finish(BlockKind::Reasoning, None),

            SessionEvent::Usage(usage) => {
                self.usage = usage;
                self.pending.push(TranscriptEvent::Usage(usage));
            }

            SessionEvent::Context { used, window } => {
                self.pending.push(TranscriptEvent::Context { used, window });
            }

            SessionEvent::RateLimits { windows } => {
                self.pending.push(TranscriptEvent::RateLimits { windows });
            }

            SessionEvent::Status { text } => {
                self.pending.push(TranscriptEvent::Status { text });
            }

            SessionEvent::ToolStarted { call_id, title, .. } => {
                self.tool_started(&call_id, title);
            }

            SessionEvent::ToolEnded {
                call_id,
                status,
                detail,
            } => {
                self.tool_ended(&call_id, status, detail);
            }

            SessionEvent::ApprovalRequested {
                id,
                approval_kind,
                title,
                detail,
            } => {
                self.pending.push(TranscriptEvent::ApprovalRequested {
                    id,
                    approval_kind,
                    title,
                    detail,
                });
                // A question on screen should not wait for the next tick.
                self.flush_events();
            }

            SessionEvent::ApprovalResolved { id, outcome } => {
                self.pending
                    .push(TranscriptEvent::ApprovalResolved { id, outcome });
                self.flush_events();
            }

            SessionEvent::TurnStarted => {}

            SessionEvent::TurnEnded { stop } => {
                self.close_all();
                self.abandon_tools();
                let _ = self
                    .store
                    .record_turn(&self.session_id, stop_label(&stop), self.usage);
                self.usage = Usage::default();
                self.last_closed.clear();
                self.pending.push(TranscriptEvent::TurnEnded { stop });
                // A finished turn is worth showing immediately.
                self.flush_events();
            }

            SessionEvent::Error {
                error_kind,
                message,
                ..
            } => {
                self.pending.push(TranscriptEvent::Failed {
                    error_kind,
                    message,
                });
                self.flush_events();
            }
        }
    }

    /// Opens a tool row.
    ///
    /// Text blocks close first, or the row would appear above the sentence
    /// that introduced it.
    fn tool_started(&mut self, call_id: &str, title: String) {
        self.close_all();
        let Ok(seq) = self
            .store
            .append_block(&self.session_id, BlockKind::Tool, &title)
        else {
            return;
        };
        let _ =
            self.store
                .set_block_meta(&self.session_id, seq, &tool_meta(ToolStatus::Running, None));
        self.tools.insert(call_id.to_owned(), seq);
        self.pending.push(TranscriptEvent::BlockAppended {
            seq,
            block_kind: BlockKind::Tool,
            text: title,
        });
        self.pending.push(TranscriptEvent::ToolStatusChanged {
            seq,
            status: ToolStatus::Running,
            detail: None,
        });
    }

    /// Closes a tool row with its outcome.
    fn tool_ended(&mut self, call_id: &str, status: ToolStatus, detail: Option<String>) {
        let Some(seq) = self.tools.remove(call_id) else {
            return;
        };
        let _ =
            self.store
                .set_block_meta(&self.session_id, seq, &tool_meta(status, detail.as_deref()));
        self.pending.push(TranscriptEvent::ToolStatusChanged {
            seq,
            status,
            detail,
        });
    }

    /// Appends streamed text to the open block of this kind, creating it if
    /// this is the first text of the turn.
    fn delta(&mut self, kind: BlockKind, text: &str) {
        if !self.open.contains_key(&kind) {
            let Ok(seq) = self.store.append_block(&self.session_id, kind, "") else {
                return;
            };
            self.open.insert(
                kind,
                OpenBlock {
                    seq,
                    text: String::new(),
                    last_persisted: Instant::now(),
                    dirty: false,
                },
            );
            self.pending.push(TranscriptEvent::BlockAppended {
                seq,
                block_kind: kind,
                text: String::new(),
            });
        }

        let Some(block) = self.open.get_mut(&kind) else {
            return;
        };
        block.text.push_str(text);
        block.dirty = true;
        self.pending.push(TranscriptEvent::BlockDelta {
            seq: block.seq,
            text: text.to_owned(),
        });

        if block.last_persisted.elapsed() >= PERSIST_EVERY {
            let (seq, text) = (block.seq, block.text.clone());
            block.last_persisted = Instant::now();
            block.dirty = false;
            let _ = self.store.set_block_text(&self.session_id, seq, &text);
        }
    }

    /// Closes a block, preferring the harness's authoritative text.
    fn finish(&mut self, kind: BlockKind, authoritative: Option<&str>) {
        let Some(mut block) = self.open.remove(&kind) else {
            // A snapshot with no stream behind it still deserves a row, unless
            // it is repeating the block we just closed.
            if let Some(text) = authoritative
                .filter(|t| !t.is_empty())
                .filter(|t| self.last_closed.get(&kind).map(String::as_str) != Some(*t))
            {
                if let Ok(seq) = self.store.append_block(&self.session_id, kind, text) {
                    self.pending.push(TranscriptEvent::BlockAppended {
                        seq,
                        block_kind: kind,
                        text: text.to_owned(),
                    });
                }
            }
            return;
        };

        if let Some(text) = authoritative {
            // The harness is authoritative about its own message, so a
            // disagreement is resolved in its favour rather than papered over.
            if text != block.text {
                text.clone_into(&mut block.text);
                block.dirty = true;
            }
        }

        if block.text.is_empty() {
            let _ = self
                .store
                .discard_block_if_empty(&self.session_id, block.seq);
            return;
        }

        if block.dirty {
            let _ = self
                .store
                .set_block_text(&self.session_id, block.seq, &block.text);
        }
        self.last_closed.insert(kind, block.text.clone());
        self.pending.push(TranscriptEvent::BlockFinal {
            seq: block.seq,
            text: block.text,
        });
    }

    fn close_all(&mut self) {
        for kind in [BlockKind::Assistant, BlockKind::Reasoning] {
            if self.open.contains_key(&kind) {
                self.finish(kind, None);
            }
        }
    }

    /// Marks any tool row still running as failed.
    ///
    /// Called when the session ends. A row left spinning forever is worse
    /// than one that admits it never finished.
    fn abandon_tools(&mut self) {
        for (_, seq) in std::mem::take(&mut self.tools) {
            let _ = self.store.set_block_meta(
                &self.session_id,
                seq,
                &tool_meta(ToolStatus::Failed, Some("the agent stopped first")),
            );
            self.pending.push(TranscriptEvent::ToolStatusChanged {
                seq,
                status: ToolStatus::Failed,
                detail: Some("the agent stopped first".to_owned()),
            });
        }
    }

    fn flush_events(&mut self) {
        self.last_emit = Instant::now();
        if self.pending.is_empty() {
            return;
        }
        let batch = Batch {
            session_id: &self.session_id,
            events: &self.pending,
        };
        // Targeted at nothing in particular yet because there is one window.
        // When there are several, this becomes `emit_to` so a webview does not
        // deserialize another window's traffic (ARCHITECTURE.md §7).
        let _ = self.app.emit(TRANSCRIPT_EVENT, &batch);
        self.pending.clear();
    }
}

/// A tool row's structured detail, stored alongside its title.
fn tool_meta(status: ToolStatus, detail: Option<&str>) -> String {
    serde_json::json!({ "status": status, "detail": detail }).to_string()
}

fn stop_label(stop: &StopReason) -> &'static str {
    match stop {
        StopReason::EndTurn => "endTurn",
        StopReason::MaxTokens => "maxTokens",
        StopReason::Refusal { .. } => "refusal",
        StopReason::Cancelled => "cancelled",
        StopReason::Interrupted => "interrupted",
        StopReason::Failed { .. } => "failed",
        StopReason::Other { .. } => "other",
    }
}
