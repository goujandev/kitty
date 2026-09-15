//! The engine driven end to end against a fake CLI.
//!
//! Prototype-1 acceptance criterion 8 asks for the turn lifecycle to be tested
//! without a real agent. These use a stand-in that replays a canned transcript
//! instead: deterministic, offline, and free, while still exercising the whole
//! path from process spawn through framing and decoding to events.
//!
//! ADR-0001 denies `expect` outside tests. clippy's `allow-expect-in-tests`
//! only recognises `#[cfg(test)]` modules, not integration-test crates, so the
//! exemption is stated here instead.
#![allow(clippy::expect_used)]
#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use kitty_core::{HarnessId, SessionEvent, StopReason, ToolStatus};
use kitty_engine::{Session, SessionSpec};

/// Builds a fake CLI: a batch file that prints canned frames and ignores its
/// arguments, so the engine's real launch flags do not disturb it.
///
/// `wait` makes it block on stdin afterwards, which is how a real CLI behaves
/// while it waits for an answer to a permission request.
fn fake_cli(dir: &Path, frames: &[&str], wait: bool) -> PathBuf {
    let data = dir.join("frames.jsonl");
    std::fs::write(&data, frames.join("\n") + "\n").expect("write frames");

    let script = dir.join("fake.cmd");
    // `type` streams the file. Without `wait` the process then exits, which is
    // how a real CLI behaves once a turn is over.
    let body = if wait {
        "@echo off\r\ntype \"%~dp0frames.jsonl\"\r\nset /p answer=\r\n"
    } else {
        "@echo off\r\ntype \"%~dp0frames.jsonl\"\r\n"
    };
    std::fs::write(&script, body).expect("write script");
    script
}

fn start(dir: &Path, frames: &[&str]) -> (Session, Receiver<SessionEvent>) {
    start_with(dir, frames, false)
}

fn start_with(dir: &Path, frames: &[&str], wait: bool) -> (Session, Receiver<SessionEvent>) {
    let binary = fake_cli(dir, frames, wait);
    Session::start(&SessionSpec::new(HarnessId::Claude, binary, dir))
        .expect("the engine should start a fake CLI")
}

/// Drains events until the channel closes or the deadline passes.
fn drain(events: &Receiver<SessionEvent>) -> Vec<SessionEvent> {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut out = Vec::new();
    while Instant::now() < deadline {
        match events.recv_timeout(Duration::from_millis(200)) {
            Ok(event) => out.push(event),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                if out.iter().any(is_end) {
                    break;
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    out
}

fn is_end(event: &SessionEvent) -> bool {
    matches!(event, SessionEvent::TurnEnded { .. })
}

const INIT: &str =
    r#"{"type":"system","subtype":"init","session_id":"fake-1","model":"fake-model"}"#;
const RESULT: &str = r#"{"type":"result","stop_reason":"end_turn","is_error":false,"usage":{"input_tokens":1,"output_tokens":2}}"#;

fn delta(text: &str) -> String {
    format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{text}"}}}}}}"#
    )
}

#[test]
fn a_session_reports_who_it_is_then_streams_then_ends() {
    let dir = tempfile::tempdir().expect("tempdir");
    let one = delta("Hello");
    let two = delta(" there");
    let (session, events) = start(dir.path(), &[INIT, &one, &two, RESULT]);
    assert!(session.send("anything"));

    let seen = drain(&events);

    let started = seen
        .iter()
        .position(|e| matches!(e, SessionEvent::Started { .. }))
        .expect("Started");
    let ended = seen.iter().position(is_end).expect("TurnEnded");
    assert!(started < ended, "the session ended before it started");

    let text: String = seen
        .iter()
        .filter_map(|e| match e {
            SessionEvent::MessageDelta { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(text, "Hello there");
}

#[test]
fn a_turn_ends_exactly_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let one = delta("hi");
    let (session, events) = start(dir.path(), &[INIT, &one, RESULT]);
    assert!(session.send("go"));

    let ends = drain(&events).iter().filter(|e| is_end(e)).count();
    assert_eq!(ends, 1, "a turn must end once and only once");
}

#[test]
fn a_cli_that_dies_mid_turn_is_reported_as_interrupted() {
    // No `result` frame: the process just exits. The partial reply is kept and
    // the turn is closed honestly rather than left running forever.
    let dir = tempfile::tempdir().expect("tempdir");
    let partial = delta("half a th");
    let (session, events) = start(dir.path(), &[INIT, &partial]);
    assert!(session.send("go"));

    let seen = drain(&events);
    assert!(
        seen.iter().any(|e| matches!(
            e,
            SessionEvent::TurnEnded {
                stop: StopReason::Interrupted
            }
        )),
        "expected an Interrupted turn, got {seen:?}"
    );
    assert!(
        seen.iter()
            .any(|e| matches!(e, SessionEvent::MessageDelta { text } if text == "half a th")),
        "the partial reply must be kept"
    );
}

#[test]
fn garbage_on_the_wire_does_not_stop_the_stream() {
    let dir = tempfile::tempdir().expect("tempdir");
    let good = delta("fine");
    let (session, events) = start(dir.path(), &[INIT, "not json at all", "{}", &good, RESULT]);
    assert!(session.send("go"));

    let seen = drain(&events);
    assert!(
        seen.iter()
            .any(|e| matches!(e, SessionEvent::MessageDelta { text } if text == "fine")),
        "a bad frame stopped the stream"
    );
    assert!(seen.iter().any(is_end));
}

#[test]
fn a_tool_call_and_its_result_survive_the_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let frames: Vec<String> = vec![
        INIT.to_owned(),
        r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Write","input":{}}}}"#.to_owned(),
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"a/b.txt\"}"}}}"#.to_owned(),
        r#"{"type":"stream_event","event":{"type":"content_block_stop","index":1}}"#.to_owned(),
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"written"}]}}"#.to_owned(),
        RESULT.to_owned(),
    ];
    let refs: Vec<&str> = frames.iter().map(String::as_str).collect();
    let (session, events) = start(dir.path(), &refs);
    assert!(session.send("go"));

    let seen = drain(&events);

    let title = seen.iter().find_map(|e| match e {
        SessionEvent::ToolStarted { title, .. } => Some(title.clone()),
        _ => None,
    });
    assert_eq!(title.as_deref(), Some("Write a/b.txt"));

    let ended = seen.iter().find_map(|e| match e {
        SessionEvent::ToolEnded { status, .. } => Some(*status),
        _ => None,
    });
    assert_eq!(ended, Some(ToolStatus::Ok));
}

#[test]
fn a_permission_request_can_be_answered_and_the_turn_continues() {
    let dir = tempfile::tempdir().expect("tempdir");
    let ask = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"file_path":"a/b.txt"}}}"#;
    // No result frame, and the fake waits on stdin: the turn stays open until
    // the answer is written, exactly as a real CLI does.
    let (session, events) = start_with(dir.path(), &[INIT, ask], true);
    assert!(session.send("go"));

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut asked = None;
    let mut resolved = false;

    while Instant::now() < deadline {
        match events.recv_timeout(Duration::from_millis(200)) {
            Ok(SessionEvent::ApprovalRequested { id, title, .. }) => {
                assert_eq!(title, "Write a/b.txt");
                assert!(session.respond(&id, true));
                asked = Some(id);
            }
            Ok(SessionEvent::ApprovalResolved { id, outcome }) => {
                assert_eq!(Some(&id), asked.as_ref());
                assert_eq!(outcome, kitty_core::ApprovalOutcome::Allowed);
                resolved = true;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    assert!(asked.is_some(), "no permission request arrived");
    assert!(resolved, "answering the request produced no resolution");
}

#[test]
fn cancelling_denies_anything_waiting_on_the_user() {
    // A request left unanswered would hold the CLI open forever, so a cancel
    // has to settle it rather than just stopping the turn.
    let dir = tempfile::tempdir().expect("tempdir");
    let ask = r#"{"type":"control_request","request_id":"req-9","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"rm -rf /"}}}"#;
    let (session, events) = start_with(dir.path(), &[INIT, ask], true);
    assert!(session.send("go"));

    let deadline = Instant::now() + Duration::from_secs(20);
    let mut outcome = None;

    while Instant::now() < deadline {
        match events.recv_timeout(Duration::from_millis(200)) {
            Ok(SessionEvent::ApprovalRequested { .. }) => {
                assert!(session.cancel());
            }
            Ok(SessionEvent::ApprovalResolved { outcome: o, .. }) => {
                outcome = Some(o);
                break;
            }
            Ok(_) => {}
            Err(_) => break,
        }
    }

    assert_eq!(
        outcome,
        Some(kitty_core::ApprovalOutcome::Denied),
        "cancelling must deny an outstanding request, not abandon it"
    );
}

#[test]
fn a_missing_binary_is_an_error_rather_than_a_hang() {
    let dir = tempfile::tempdir().expect("tempdir");
    let spec = SessionSpec::new(
        HarnessId::Claude,
        dir.path().join("does-not-exist.cmd"),
        dir.path(),
    );
    assert!(Session::start(&spec).is_err());
}
