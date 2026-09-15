//! Codecs: one per CLI, each turning that vendor's wire frames into kitty's
//! event vocabulary and kitty's actions into that vendor's frames.
//!
//! A codec owns decode state and nothing else. No process handle, no timer, no
//! turn queue, no approval queue, no cancellation flag. Those belong to the
//! engine, and keeping them out of here is the whole point of ADR-0002:
//! `MonoCode` has seven adapter files of roughly a thousand lines each, every
//! one re-implementing the same turn-serialisation chain and the same
//! completion race.
//!
//! The protocols were recorded from the installed CLIs on 2026-09-15 and the
//! recordings are in `fixtures/`. Codecs are written against those, not
//! against documentation, and `tests/replay.rs` replays them.

pub mod claude;
pub mod codex;

use kitty_core::{HarnessId, SessionEvent};

/// What a codec did with one input.
///
/// Both halves matter. `events` goes up to the engine and the UI; `send` goes
/// back down to the child. A protocol whose handshake chains, like Codex's
/// `initialize` then `thread/start` then `turn/start`, drives itself by
/// returning the next request from the frame that answered the last one.
#[derive(Debug, Default, PartialEq)]
pub struct Step {
    pub events: Vec<SessionEvent>,
    pub send: Vec<String>,
}

impl Step {
    #[must_use]
    pub fn none() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn event(event: SessionEvent) -> Self {
        Self {
            events: vec![event],
            send: Vec::new(),
        }
    }

    #[must_use]
    pub fn send(line: String) -> Self {
        Self {
            events: Vec::new(),
            send: vec![line],
        }
    }

    #[must_use]
    pub fn with_event(mut self, event: SessionEvent) -> Self {
        self.events.push(event);
        self
    }

    #[must_use]
    pub fn with_send(mut self, line: String) -> Self {
        self.send.push(line);
        self
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty() && self.send.is_empty()
    }
}

/// What the session is for, handed to a codec when it starts.
#[derive(Debug, Clone)]
pub struct StartContext {
    pub cwd: String,
    /// Resume an existing vendor session or thread, when we have one.
    pub resume: Option<String>,
    pub model: Option<String>,
}

pub trait Codec: Send {
    /// Frames to send as soon as the child is up.
    fn start(&mut self, ctx: &StartContext) -> Step;

    /// One protocol frame in, events and follow-up frames out.
    ///
    /// A frame that cannot be decoded must never be fatal. Return
    /// [`Step::none`] for anything not understood; the engine keeps a raw log
    /// for the cases where a human needs to look.
    fn on_frame(&mut self, line: &str) -> Step;

    /// Ask the model something.
    fn send_turn(&mut self, text: &str) -> Step;

    /// Stop the running turn in-band. Killing the process is the engine's
    /// escalation, not the codec's business.
    fn cancel(&mut self) -> Step;

    /// Answer a permission request the codec raised.
    ///
    /// `id` is whatever the codec put on
    /// [`SessionEvent::ApprovalRequested`](kitty_core::SessionEvent). Mapping
    /// it back to the vendor's own identifier is the codec's job, because the
    /// engine deliberately knows nothing about either protocol.
    fn respond_approval(&mut self, id: &str, allow: bool) -> Step;
}

/// Builds a one-line summary of a tool call for the transcript.
///
/// Every harness names its tools differently and nests the interesting
/// argument somewhere different, so this is the one place that guesses. It
/// prefers a path, then a command, then a query, and falls back to the name.
pub(crate) fn summarize(name: &str, input: &serde_json::Value) -> String {
    for key in ["file_path", "path", "notebook_path", "filePath"] {
        if let Some(value) = str_field(input, key) {
            return format!("{name} {}", short_path(value));
        }
    }
    for key in ["command", "cmd"] {
        if let Some(value) = str_field(input, key) {
            return format!("{name}: {}", first_line(value, 80));
        }
    }
    for key in ["query", "pattern", "url", "prompt", "description"] {
        if let Some(value) = str_field(input, key) {
            return format!("{name}: {}", first_line(value, 80));
        }
    }
    name.to_owned()
}

/// Keeps the tail of a path, which is the part a human recognises.
pub(crate) fn short_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.rsplit('/').take(2).collect();
    if parts.len() < 2 {
        return path.to_owned();
    }
    format!("{}/{}", parts[1], parts[0])
}

/// One readable line, capped.
pub(crate) fn first_line(text: &str, cap: usize) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let trimmed = line.trim();
    if trimmed.chars().count() > cap {
        let kept: String = trimmed.chars().take(cap).collect();
        format!("{kept}…")
    } else {
        trimmed.to_owned()
    }
}

/// The argv a harness is launched with, after its resolved binary path.
#[must_use]
pub fn launch_args(id: HarnessId) -> Vec<String> {
    match id {
        HarnessId::Claude => claude::launch_args(),
        HarnessId::Codex => codex::launch_args(),
    }
}

#[must_use]
pub fn codec_for(id: HarnessId) -> Box<dyn Codec> {
    match id {
        HarnessId::Claude => Box::new(claude::ClaudeCodec::new()),
        HarnessId::Codex => Box::new(codex::CodexCodec::new()),
    }
}

/// The delta mode each harness uses. Declared, never inferred (ADR-0002).
///
/// Both append. Confirmed by recording: Claude sent `"Hello there"` then
/// `", friend"`, Codex sent `"Hello" "," " lovely" " human" "."`.
#[must_use]
pub const fn delta_mode(id: HarnessId) -> kitty_core::DeltaMode {
    match id {
        HarnessId::Claude | HarnessId::Codex => kitty_core::DeltaMode::Append,
    }
}

/// Shorthand for reading an optional string field.
pub(crate) fn str_field<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(serde_json::Value::as_str)
}

pub(crate) fn u64_field(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

#[cfg(test)]
mod tests {
    use super::{codec_for, delta_mode, launch_args, Step};
    use kitty_core::{DeltaMode, HarnessId, SessionEvent};

    #[test]
    fn every_harness_has_launch_args_and_a_codec() {
        for id in HarnessId::ALL {
            assert!(!launch_args(id).is_empty(), "{id} has no launch args");
            let _ = codec_for(id);
        }
    }

    #[test]
    fn both_harnesses_append() {
        for id in HarnessId::ALL {
            assert_eq!(delta_mode(id), DeltaMode::Append);
        }
    }

    #[test]
    fn step_builders_compose() {
        let step = Step::event(SessionEvent::TurnStarted).with_send("{}".into());
        assert_eq!(step.events.len(), 1);
        assert_eq!(step.send.len(), 1);
        assert!(!step.is_empty());
        assert!(Step::none().is_empty());
    }
}

#[cfg(test)]
mod summary_tests {
    use super::{first_line, short_path, summarize};
    use serde_json::json;

    #[test]
    fn a_path_argument_wins_and_is_shortened() {
        assert_eq!(
            summarize(
                "Write",
                &json!({"file_path": r"C:\GitHub\kitty\src\main.rs"})
            ),
            "Write src/main.rs"
        );
    }

    #[test]
    fn a_command_is_summarised_to_one_line() {
        assert_eq!(
            summarize("Bash", &json!({"command": "cargo test\nsecond line"})),
            "Bash: cargo test"
        );
    }

    #[test]
    fn a_tool_with_nothing_recognisable_keeps_its_name() {
        assert_eq!(summarize("Think", &json!({"unknown": 1})), "Think");
        assert_eq!(summarize("Think", &json!({})), "Think");
    }

    #[test]
    fn a_short_path_is_left_alone() {
        assert_eq!(short_path("main.rs"), "main.rs");
    }

    #[test]
    fn long_lines_are_capped_with_an_ellipsis() {
        let capped = first_line(&"x".repeat(200), 20);
        assert_eq!(capped.chars().count(), 21);
        assert!(capped.ends_with('…'));
    }
}
