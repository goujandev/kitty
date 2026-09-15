//! Replays recorded CLI sessions through the codecs.
//!
//! This is the regression net for prototype-1 acceptance criterion 5:
//! *streamed text is byte-identical to what the CLI produced*. Each fixture is
//! real traffic captured from the installed CLI, so a codec change that
//! mangles a delta fails here rather than in front of a user.
//!
//! The fixtures were recorded by `scripts/probe-{claude,codex}-protocol.py`
//! and are line-per-message JSON: `{"dir": "in"|"out", "raw": "<frame>"}`.

use std::path::PathBuf;

use kitty_core::{HarnessId, SessionEvent};
use kitty_harness::{codec_for, delta_mode, StartContext};
use serde_json::Value;

struct Replay {
    streamed: String,
    authoritative: Option<String>,
    reasoning: String,
    events: Vec<SessionEvent>,
}

fn fixture(harness: &str) -> Vec<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures")
        .join(harness)
        .join("hello.jsonl");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));

    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let row: Value = serde_json::from_str(line).ok()?;
            (row.get("dir")?.as_str()? == "in")
                .then(|| row.get("raw")?.as_str().map(str::to_owned))?
        })
        .collect()
}

fn replay(id: HarnessId, harness: &str) -> Replay {
    let mut codec = codec_for(id);
    let mode = delta_mode(id);

    let mut out = Replay {
        streamed: String::new(),
        authoritative: None,
        reasoning: String::new(),
        events: Vec::new(),
    };

    // The recorded session already answered our handshake, so we start the
    // codec and then feed it exactly what the CLI said, in order.
    let _ = codec.start(&StartContext {
        cwd: r"C:\GitHub\kitty".into(),
        resume: None,
        model: None,
    });

    for frame in fixture(harness) {
        let step = codec.on_frame(&frame);
        for event in step.events {
            match &event {
                SessionEvent::MessageDelta { text } => mode.apply(&mut out.streamed, text),
                SessionEvent::MessageDone { text } => {
                    out.authoritative = Some(text.clone());
                }
                SessionEvent::ReasoningDelta { text } => mode.apply(&mut out.reasoning, text),
                _ => {}
            }
            out.events.push(event);
        }
    }
    out
}

fn kinds(events: &[SessionEvent]) -> Vec<&'static str> {
    events
        .iter()
        .map(|e| match e {
            SessionEvent::Started { .. } => "Started",
            SessionEvent::TurnStarted => "TurnStarted",
            SessionEvent::MessageDelta { .. } => "MessageDelta",
            SessionEvent::MessageDone { .. } => "MessageDone",
            SessionEvent::ReasoningDelta { .. } => "ReasoningDelta",
            SessionEvent::ReasoningDone => "ReasoningDone",
            SessionEvent::Context { .. } => "Context",
            SessionEvent::Usage(_) => "Usage",
            SessionEvent::RateLimits { .. } => "RateLimits",
            SessionEvent::Status { .. } => "Status",
            SessionEvent::TurnEnded { .. } => "TurnEnded",
            SessionEvent::Error { .. } => "Error",
        })
        .collect()
}

#[test]
fn claude_replay_streams_the_recorded_text() {
    let result = replay(HarnessId::Claude, "claude");

    assert_eq!(result.streamed, "Hello there, friend");
    assert_eq!(
        result.authoritative.as_deref(),
        Some("Hello there, friend"),
        "the assistant snapshot must agree with the stream"
    );
}

#[test]
fn codex_replay_streams_the_recorded_text() {
    let result = replay(HarnessId::Codex, "codex");

    assert_eq!(result.streamed, "Hello, lovely human.");
    assert_eq!(
        result.authoritative.as_deref(),
        Some("Hello, lovely human."),
        "the completed item must agree with the stream"
    );
}

#[test]
fn both_harnesses_agree_on_the_shape_of_a_turn() {
    // The point of the abstraction: two unrelated protocols produce the same
    // sequence of event kinds for the same interaction.
    for (id, name) in [(HarnessId::Claude, "claude"), (HarnessId::Codex, "codex")] {
        let seen = kinds(&replay(id, name).events);
        for required in [
            "Started",
            "TurnStarted",
            "MessageDelta",
            "MessageDone",
            "TurnEnded",
        ] {
            assert!(
                seen.contains(&required),
                "{name} never produced {required}; got {seen:?}"
            );
        }
    }
}

#[test]
fn a_session_starts_before_it_streams_and_ends_after() {
    for (id, name) in [(HarnessId::Claude, "claude"), (HarnessId::Codex, "codex")] {
        let seen = kinds(&replay(id, name).events);
        let started = seen.iter().position(|k| *k == "Started").expect("Started");
        let first_delta = seen
            .iter()
            .position(|k| *k == "MessageDelta")
            .expect("MessageDelta");
        let ended = seen
            .iter()
            .rposition(|k| *k == "TurnEnded")
            .expect("TurnEnded");

        assert!(started < first_delta, "{name} streamed before it started");
        assert!(first_delta < ended, "{name} ended before it streamed");
        assert_eq!(
            seen.iter().filter(|k| **k == "TurnEnded").count(),
            1,
            "{name} ended its turn more than once"
        );
    }
}

#[test]
fn claude_reports_its_session_model_and_rate_limits() {
    let result = replay(HarnessId::Claude, "claude");

    let started = result
        .events
        .iter()
        .find_map(|e| match e {
            SessionEvent::Started {
                provider_session,
                model,
            } => Some((provider_session.clone(), model.clone())),
            _ => None,
        })
        .expect("Started");
    assert!(started.0.is_some(), "no session id to resume with");
    assert_eq!(started.1.as_deref(), Some("claude-opus-5[1m]"));

    // ADR-0004: usage comes from the CLI, never from a credential file.
    let windows = result
        .events
        .iter()
        .find_map(|e| match e {
            SessionEvent::RateLimits { windows } => Some(windows.clone()),
            _ => None,
        })
        .expect("Claude reports rate limits in-band");
    let labels: Vec<_> = windows.iter().map(|w| w.label.as_str()).collect();
    assert_eq!(labels, vec!["five_hour", "seven_day"]);
}

#[test]
fn codex_reports_its_thread_model_and_context_window() {
    let result = replay(HarnessId::Codex, "codex");

    let model = result.events.iter().find_map(|e| match e {
        SessionEvent::Started { model, .. } => model.clone(),
        _ => None,
    });
    assert_eq!(model.as_deref(), Some("gpt-5.6-terra"));

    let window = result.events.iter().find_map(|e| match e {
        SessionEvent::Context { window, .. } => *window,
        _ => None,
    });
    assert_eq!(window, Some(258_400));
}

#[test]
fn every_recorded_frame_decodes_without_a_protocol_error() {
    for (id, name) in [(HarnessId::Claude, "claude"), (HarnessId::Codex, "codex")] {
        let result = replay(id, name);
        let errors: Vec<_> = result
            .events
            .iter()
            .filter(|e| matches!(e, SessionEvent::Error { .. }))
            .collect();
        assert!(
            errors.is_empty(),
            "{name} produced errors from a clean recording: {errors:?}"
        );
    }
}

#[test]
fn replaying_twice_gives_the_same_answer() {
    // Codecs hold decode state. Replaying must be deterministic or the
    // fixtures prove nothing.
    for (id, name) in [(HarnessId::Claude, "claude"), (HarnessId::Codex, "codex")] {
        let first = replay(id, name);
        let second = replay(id, name);
        assert_eq!(first.streamed, second.streamed);
        assert_eq!(first.events, second.events);
    }
}
