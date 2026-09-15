//! The event vocabulary.
//!
//! The single most important type in the system. Every harness decodes into
//! this, and the UI switches on the event type, never on which CLI produced it
//! (ARCHITECTURE.md §6).
//!
//! Slice 2 implements the streaming-text subset. Tool, approval and question
//! variants arrive in slice 3. The names here match the full vocabulary in the
//! architecture document so that growth is additive.
//!
//! ## Why there is no "guess the delta mode" here
//!
//! Recorded from the installed CLIs on 2026-09-15:
//!
//! ```text
//! claude  "Hello there" then ", friend"           -> "Hello there, friend"
//! codex   "Hello" "," " lovely" " human" "."      -> "Hello, lovely human."
//! ```
//!
//! Both append. Both also send an authoritative snapshot when the message
//! finishes, which arrives as [`SessionEvent::MessageDone`]. Note Codex's
//! leading-space chunks: that is exactly the shape `MonoCode`'s
//! compare-the-strings heuristic mangles, and it is why [`DeltaMode`] is
//! declared per harness rather than inferred per chunk (ADR-0002).

use serde::{Deserialize, Serialize};

/// Whether a harness streams incremental chunks or resends the whole message.
///
/// A fixed property of each protocol, declared in the manifest. Never inferred
/// from content.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DeltaMode {
    /// Each chunk is new text to append. Both current harnesses.
    Append,
    /// Each chunk is the whole message so far and replaces what came before.
    Snapshot,
}

impl DeltaMode {
    /// Applies one streamed chunk to the text accumulated so far.
    ///
    /// Whitespace is content. A chunk of `" "` is a real space, and an empty
    /// chunk is a no-op rather than a signal.
    pub fn apply(self, accumulated: &mut String, chunk: &str) {
        match self {
            Self::Append => accumulated.push_str(chunk),
            Self::Snapshot => {
                accumulated.clear();
                accumulated.push_str(chunk);
            }
        }
    }
}

/// How much of a final snapshot still needs emitting after chunks streamed.
///
/// Computed by length, never by similarity. If the snapshot extends what we
/// streamed, the suffix is new. If it disagrees, the snapshot wins, because
/// the harness is authoritative about its own message.
#[must_use]
pub fn snapshot_remainder<'a>(streamed: &str, snapshot: &'a str) -> Option<&'a str> {
    if snapshot == streamed {
        return None;
    }
    if let Some(rest) = snapshot.strip_prefix(streamed) {
        return Some(rest);
    }
    Some(snapshot)
}

/// What a transcript is made of.
///
/// Slice 2 has three kinds. Tool activity joins them in slice 3, which is an
/// added variant rather than a schema change, because `kind` is a string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockKind {
    User,
    Assistant,
    Reasoning,
}

impl BlockKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Reasoning => "reasoning",
        }
    }

    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "reasoning" => Some(Self::Reasoning),
            _ => None,
        }
    }
}

/// Why a turn stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StopReason {
    /// The model finished normally.
    EndTurn,
    /// The output cap was hit mid-thought.
    MaxTokens,
    /// A safety classifier declined. Carries the vendor's category when given.
    Refusal { category: Option<String> },
    /// The user cancelled. The partial message is kept.
    Cancelled,
    /// The stream ended without a terminal signal, e.g. the child died.
    Interrupted,
    /// The harness reported a failure.
    Failed { message: String },
    /// Something terminal we do not model yet, kept verbatim.
    Other { reason: String },
}

/// Token accounting for one turn.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
}

/// One subscription rate-limit window, as the vendor reports it.
///
/// Both CLIs hand this over themselves: Claude Code emits `rate_limit_event`
/// in its stream, Codex answers `account/rateLimits/read`. kitty never reads a
/// credential file for this (ADR-0004).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitWindow {
    /// Vendor's own label, e.g. `five_hour`, `seven_day`.
    pub label: String,
    /// Fraction of the window consumed, 0.0 to 1.0.
    pub utilization: f64,
    pub resets_at_ms: Option<i64>,
}

/// What went wrong, classified once at the harness boundary so the retry
/// policy is written once (ARCHITECTURE.md §12).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// The CLI is not signed in, or the provider rejected its credentials.
    Auth,
    /// A quota or rate limit was hit.
    RateLimited,
    /// Worth retrying: a dropped connection, a 5xx.
    Transient,
    /// We sent something the CLI would not accept. A bug on our side.
    Invalid,
    /// The child process failed: spawn, crash, unexpected exit.
    Process,
    /// The CLI said something we could not decode. Also a bug on our side.
    Protocol,
}

/// Everything that can happen in a session, in one vocabulary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    /// The CLI is up and has told us who it is.
    Started {
        /// The vendor's own session or thread id, needed to resume later.
        provider_session: Option<String>,
        /// The model the CLI actually chose, which may not be what we asked.
        model: Option<String>,
    },
    /// A turn began.
    TurnStarted,
    /// Visible assistant text. Apply with the harness's [`DeltaMode`].
    MessageDelta {
        text: String,
    },
    /// The authoritative full text of the message that just finished.
    MessageDone {
        text: String,
    },
    /// Reasoning summary text, where the CLI exposes it.
    ReasoningDelta {
        text: String,
    },
    ReasoningDone,
    /// Context-window level after the harness's latest request.
    Context {
        used: Option<u64>,
        window: Option<u64>,
    },
    Usage(Usage),
    RateLimits {
        windows: Vec<RateLimitWindow>,
    },
    /// Human-readable progress, for the status line. Never part of the
    /// transcript.
    Status {
        text: String,
    },
    TurnEnded {
        stop: StopReason,
    },
    Error {
        error_kind: ErrorKind,
        message: String,
        retryable: bool,
    },
}

#[cfg(test)]
mod tests {
    use super::{snapshot_remainder, DeltaMode, SessionEvent, StopReason};

    #[test]
    fn append_mode_concatenates_real_claude_chunks() {
        let mut text = String::new();
        for chunk in ["Hello there", ", friend"] {
            DeltaMode::Append.apply(&mut text, chunk);
        }
        assert_eq!(text, "Hello there, friend");
    }

    #[test]
    fn append_mode_concatenates_real_codex_chunks() {
        let mut text = String::new();
        for chunk in ["Hello", ",", " lovely", " human", "."] {
            DeltaMode::Append.apply(&mut text, chunk);
        }
        assert_eq!(text, "Hello, lovely human.");
    }

    #[test]
    fn repeated_identical_chunks_both_survive() {
        // MonoCode reads a chunk equal to what came before as a snapshot and
        // drops it, which is one cause of its dropped-word reports.
        let mut text = String::new();
        DeltaMode::Append.apply(&mut text, "very");
        DeltaMode::Append.apply(&mut text, "very");
        assert_eq!(text, "veryvery");
    }

    #[test]
    fn whitespace_only_chunks_are_content() {
        let mut text = String::new();
        for chunk in ["Now", " ", "let", " ", "me"] {
            DeltaMode::Append.apply(&mut text, chunk);
        }
        assert_eq!(text, "Now let me");
    }

    #[test]
    fn blank_lines_between_paragraphs_survive() {
        let mut text = String::new();
        for chunk in ["one", "\n", "\n", "two"] {
            DeltaMode::Append.apply(&mut text, chunk);
        }
        assert_eq!(text, "one\n\ntwo");
    }

    #[test]
    fn empty_chunks_change_nothing() {
        let mut text = String::from("abc");
        DeltaMode::Append.apply(&mut text, "");
        assert_eq!(text, "abc");
    }

    #[test]
    fn snapshot_mode_replaces() {
        let mut text = String::new();
        for chunk in ["Hel", "Hello", "Hello world"] {
            DeltaMode::Snapshot.apply(&mut text, chunk);
        }
        assert_eq!(text, "Hello world");
    }

    #[test]
    fn remainder_is_empty_when_the_snapshot_matches() {
        assert_eq!(snapshot_remainder("Hello there", "Hello there"), None);
    }

    #[test]
    fn remainder_is_the_suffix_when_the_snapshot_extends() {
        assert_eq!(snapshot_remainder("Hello", "Hello there"), Some(" there"));
    }

    #[test]
    fn remainder_is_the_whole_snapshot_when_they_disagree() {
        // The harness is authoritative about its own message.
        assert_eq!(snapshot_remainder("Hi", "Hello"), Some("Hello"));
    }

    #[test]
    fn remainder_handles_an_empty_stream() {
        assert_eq!(snapshot_remainder("", "Hello"), Some("Hello"));
    }

    #[test]
    fn events_round_trip_through_json() {
        let events = vec![
            SessionEvent::MessageDelta {
                text: " lovely".into(),
            },
            SessionEvent::TurnEnded {
                stop: StopReason::EndTurn,
            },
            SessionEvent::TurnEnded {
                stop: StopReason::Refusal {
                    category: Some("cyber".into()),
                },
            },
        ];
        for event in events {
            let json = serde_json::to_string(&event).expect("serialize");
            let back: SessionEvent = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, event, "round trip changed the event: {json}");
        }
    }
}

/// What the transcript view is told, after the host has done the bookkeeping.
///
/// [`SessionEvent`] is what a codec produces; this is what the frontend
/// consumes. The difference is that block identity has already been resolved,
/// so the UI only has to append text to a numbered row. Keeping that
/// resolution in Rust is ADR-0003: the frontend renders, it does not decide
/// what a transcript is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TranscriptEvent {
    /// The CLI is up. Carries the model it actually chose.
    SessionReady {
        model: Option<String>,
    },
    /// A new row. `text` is whatever it starts with, usually empty.
    BlockAppended {
        seq: i64,
        block_kind: BlockKind,
        text: String,
    },
    /// Text to append to a row. Never a replacement.
    BlockDelta {
        seq: i64,
        text: String,
    },
    /// The authoritative full text of a row that just finished.
    BlockFinal {
        seq: i64,
        text: String,
    },
    TurnEnded {
        stop: StopReason,
    },
    Usage(Usage),
    Context {
        used: Option<u64>,
        window: Option<u64>,
    },
    RateLimits {
        windows: Vec<RateLimitWindow>,
    },
    Status {
        text: String,
    },
    Failed {
        error_kind: ErrorKind,
        message: String,
    },
}
