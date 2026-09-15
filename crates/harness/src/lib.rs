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
