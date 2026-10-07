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
/// `wait` makes it consume the initial turn before printing, then block on
/// stdin again for the answer to a permission request.
fn fake_cli(dir: &Path, frames: &[&str], wait: bool) -> PathBuf {
    let data = dir.join("frames.jsonl");
    std::fs::write(&data, frames.join("\n") + "\n").expect("write frames");

    let script = dir.join("fake.cmd");
    // `type` streams the file. Without `wait` the process then exits, which is
    // how a real CLI behaves once a turn is over.
    let body = if wait {
        "@echo off\r\nset /p turn=\r\ntype \"%~dp0frames.jsonl\"\r\nset /p answer=\r\n"
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

#[test]
fn dropping_a_busy_session_ends_its_turn_once() {
    // Changing model, restarting context and stopping a conversation all drop
    // the engine. The window must still learn that the turn is over.
    let dir = tempfile::tempdir().expect("tempdir");
    let (session, events) = start_with(dir.path(), &[INIT], true);
    assert!(session.send("start waiting"));
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(5)),
        Ok(SessionEvent::Started { .. })
    ));
    assert!(session.is_alive());
    drop(session);
    let ended: Vec<_> = drain(&events).into_iter().filter(is_end).collect();
    assert_eq!(
        ended,
        vec![SessionEvent::TurnEnded {
            stop: StopReason::Interrupted
        }]
    );
}

#[test]
fn a_direct_claude_session_launches_with_only_the_users_choices() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = fake_cli(dir.path(), &[INIT, RESULT], false);
    std::fs::write(
        &binary,
        "@echo off\r\necho %*> \"%~dp0args.txt\"\r\ntype \"%~dp0frames.jsonl\"\r\n",
    )
    .expect("write recording CLI");
    let mut spec = SessionSpec::new(HarnessId::Claude, binary, dir.path());
    spec.resume = Some("saved-session".into());
    spec.model = Some("chosen-model".into());
    spec.effort = Some("medium".into());
    let (_session, events) = Session::start(&spec).expect("start");
    drain(&events);
    let args = std::fs::read_to_string(dir.path().join("args.txt")).expect("recorded args");
    for expected in [
        "--resume saved-session",
        "--model chosen-model",
        "--effort medium",
        "--permission-prompt-tool stdio",
    ] {
        assert!(args.contains(expected), "missing {expected} in {args}");
    }
    // A direct conversation keeps the CLI's own tools and system prompt.
    for absent in ["--tools", "--strict-mcp-config", "--system-prompt"] {
        assert!(!args.contains(absent), "unexpected {absent} in {args}");
    }
}
/// A stand-in for `codex app-server`: answers the handshake, records what it
/// was sent, and replies to one turn.
fn fake_codex(dir: &Path) -> PathBuf {
    let write = |name: &str, lines: &[&str]| {
        std::fs::write(dir.join(name), lines.join("\n") + "\n").expect("write frames");
    };
    write("init.jsonl", &[r#"{"id":1,"result":{}}"#]);
    write(
        "thread.jsonl",
        &[r#"{"id":2,"result":{"thread":{"id":"thread-1","model":"fake-model"}}}"#],
    );
    write(
        "reply.jsonl",
        &[
            r#"{"method":"turn/started","params":{"turn":{"id":"turn-1"}}}"#,
            r#"{"method":"item/agentMessage/delta","params":{"delta":"Done."}}"#,
            r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m","text":"Done."}}}"#,
            r#"{"method":"turn/completed","params":{"turn":{"id":"turn-1","status":"completed"}}}"#,
        ],
    );
    // PowerShell rather than batch: `set /p` on a pipe can swallow two frames
    // written together, and Kitty sends `initialized` and `thread/start` so.
    std::fs::write(
        dir.join("codex.ps1"),
        concat!(
            "$in = [Console]::In\r\n",
            "function Reply($name) { Get-Content -LiteralPath (Join-Path $PSScriptRoot $name) | ForEach-Object { [Console]::Out.WriteLine($_) }; [Console]::Out.Flush() }\r\n",
            "$null = $in.ReadLine(); Reply 'init.jsonl'\r\n",
            "$null = $in.ReadLine()\r\n",
            "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'thread.txt'), $in.ReadLine()); Reply 'thread.jsonl'\r\n",
            "[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'turn.txt'), $in.ReadLine()); Reply 'reply.jsonl'\r\n",
        ),
    )
    .expect("write fake app-server");
    let script = dir.join("codex.cmd");
    std::fs::write(
        &script,
        "@echo off\r\npowershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"%~dp0codex.ps1\"\r\n",
    )
    .expect("write script");
    script
}

#[test]
fn a_direct_codex_turn_carries_only_the_users_message() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = fake_codex(dir.path());
    let (session, events) =
        Session::start(&SessionSpec::new(HarnessId::Codex, binary, dir.path())).expect("start");
    // Sent during the handshake: held until the thread opens, then delivered.
    assert!(session.send("Fix the heading"));
    let seen = drain(&events);

    assert!(seen.iter().any(|event| matches!(
        event,
        SessionEvent::Started { provider_session: Some(id), .. } if id == "thread-1"
    )));
    assert!(seen
        .iter()
        .any(|event| matches!(event, SessionEvent::MessageDelta { text } if text == "Done.")));
    assert_eq!(
        seen.iter()
            .filter(|event| is_end(event))
            .collect::<Vec<_>>(),
        vec![&SessionEvent::TurnEnded {
            stop: StopReason::EndTurn
        }]
    );

    let read = |name: &str| -> serde_json::Value {
        let line = std::fs::read_to_string(dir.path().join(name)).expect("recorded frame");
        serde_json::from_str(line.trim()).expect("a frame is one JSON line")
    };
    let thread = read("thread.txt");
    assert_eq!(thread["method"], "thread/start");
    assert!(thread["params"].get("developerInstructions").is_none());
    let turn = read("turn.txt");
    assert_eq!(turn["method"], "turn/start");
    assert_eq!(turn["params"]["threadId"], "thread-1");
    assert_eq!(
        turn["params"]["input"],
        serde_json::json!([{ "type": "text", "text": "Fix the heading" }])
    );
}

#[test]
fn automatic_permission_modes_only_prompt_for_uncovered_actions() {
    use kitty_engine::ApprovalMode;
    for (mode, tool, should_ask) in [
        (ApprovalMode::Auto, "Write", false),
        (ApprovalMode::Auto, "Bash", false),
        (ApprovalMode::Edits, "Write", false),
        (ApprovalMode::Edits, "Bash", true),
        (ApprovalMode::Edits, "WebFetch", true),
    ] {
        let dir = tempfile::tempdir().expect("tempdir");
        let ask = format!(
            r#"{{"type":"control_request","request_id":"permission","request":{{"subtype":"can_use_tool","tool_name":"{tool}","input":{{}}}}}}"#
        );
        let binary = fake_cli(dir.path(), &[INIT, &ask], true);
        let mut spec = SessionSpec::new(HarnessId::Claude, binary, dir.path());
        spec.approval_mode = mode;
        let (session, events) = Session::start(&spec).expect("start");
        assert!(session.send("permission test"));
        let mut prompted = false;
        let mut resolved = false;
        while let Ok(event) = events.recv_timeout(Duration::from_secs(5)) {
            match event {
                SessionEvent::ApprovalRequested { id, .. } => {
                    prompted = true;
                    assert!(session.respond(&id, true));
                }
                SessionEvent::ApprovalResolved { outcome, .. } => {
                    assert_eq!(outcome, kitty_core::ApprovalOutcome::Allowed);
                    resolved = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(resolved, "{mode:?} did not settle {tool}");
        assert_eq!(prompted, should_ask, "{mode:?} / {tool}");
    }
}

#[test]
fn changing_permission_mode_settles_pending_actions_it_covers() {
    use kitty_engine::ApprovalMode;
    let dir = tempfile::tempdir().expect("tempdir");
    let edit = r#"{"type":"control_request","request_id":"edit","request":{"subtype":"can_use_tool","tool_name":"Write","input":{}}}"#;
    let command = r#"{"type":"control_request","request_id":"command","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{}}}"#;
    // Hold the process open while both outstanding requests are classified.
    let binary = fake_cli(dir.path(), &[INIT, edit, command], true);
    std::fs::write(&binary, "@echo off\r\nset /p turn=\r\ntype \"%~dp0frames.jsonl\"\r\nset /p edit=\r\nset /p command=\r\n").expect("write waiting CLI");
    let (session, events) =
        Session::start(&SessionSpec::new(HarnessId::Claude, binary, dir.path())).expect("start");
    assert!(session.send("permission test"));
    let mut asked = 0;
    while asked < 2 {
        if matches!(
            events
                .recv_timeout(Duration::from_secs(5))
                .expect("request"),
            SessionEvent::ApprovalRequested { .. }
        ) {
            asked += 1;
        }
    }
    assert!(session.set_approval_mode(ApprovalMode::Edits));
    loop {
        if let SessionEvent::ApprovalResolved { id, outcome } = events
            .recv_timeout(Duration::from_secs(5))
            .expect("edit resolution")
        {
            assert_eq!(id, "edit");
            assert_eq!(outcome, kitty_core::ApprovalOutcome::Allowed);
            break;
        }
    }
    assert!(session.set_approval_mode(ApprovalMode::Auto));
    loop {
        if let SessionEvent::ApprovalResolved { id, outcome } = events
            .recv_timeout(Duration::from_secs(5))
            .expect("command resolution")
        {
            assert_eq!(id, "command");
            assert_eq!(outcome, kitty_core::ApprovalOutcome::Allowed);
            break;
        }
    }
}

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

/// Nobody pressed Send: the CLI started working by itself, as Claude Code does
/// when a background task reports back. The engine still owns that turn, so a
/// process that dies in the middle of it ends it rather than leaving it open.
#[test]
fn a_turn_the_cli_starts_by_itself_is_owned_like_any_other() {
    let dir = tempfile::tempdir().expect("tempdir");
    let begin = r#"{"type":"stream_event","event":{"type":"message_start"}}"#;
    let partial = delta("background task finished");
    let (_session, events) = start(dir.path(), &[INIT, begin, &partial]);

    let seen = drain(&events);
    assert!(seen.iter().any(|e| matches!(e, SessionEvent::TurnStarted)));
    assert_eq!(
        seen.into_iter().filter(is_end).collect::<Vec<_>>(),
        vec![SessionEvent::TurnEnded {
            stop: StopReason::Interrupted
        }]
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

#[test]
fn exited_engine_is_not_reported_as_alive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let (session, events) = start(dir.path(), &[INIT, RESULT]);
    let _ = drain(&events);
    let deadline = Instant::now() + Duration::from_secs(2);
    while session.is_alive() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!session.is_alive(), "exited engine must be replaceable");
}

#[test]
fn silent_cli_times_out_requested_turn_and_becomes_replaceable() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = dir.path().join("silent.cmd");
    std::fs::write(&binary, "@echo off\r\nset /p turn=\r\nset /p waiting=\r\n")
        .expect("write silent CLI");
    let mut spec = SessionSpec::new(HarnessId::Claude, binary, dir.path());
    spec.turn_start_timeout = Duration::from_millis(150);
    let (session, events) = Session::start(&spec).expect("start");
    assert!(session.send("do not leave this waiting forever"));
    let seen = drain(&events);
    assert!(seen.iter().any(|event| matches!(
        event,
        SessionEvent::TurnEnded {
            stop: StopReason::Failed { .. }
        }
    )));
    let deadline = Instant::now() + Duration::from_secs(2);
    while session.is_alive() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!session.is_alive());
}

#[test]
fn continuous_unknown_frames_do_not_postpone_turn_start_timeout() {
    let dir = tempfile::tempdir().expect("tempdir");
    let binary = dir.path().join("noisy.cmd");
    std::fs::write(
        &binary,
        "@echo off\r\nset /p turn=\r\nfor /l %%i in (1,1,1000000) do @echo waiting\r\n",
    )
    .expect("write noisy CLI");
    let mut spec = SessionSpec::new(HarnessId::Claude, binary, dir.path());
    spec.turn_start_timeout = Duration::from_millis(150);
    let (session, events) = Session::start(&spec).expect("start");
    assert!(session.send("start deadline must remain bounded"));
    let seen = drain(&events);
    assert!(seen.iter().any(|event| matches!(
        event,
        SessionEvent::TurnEnded {
            stop: StopReason::Failed { .. }
        }
    )));
}
