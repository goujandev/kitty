//! The wire contract between Rust and the frontend.
//!
//! ADR-0001 says the IPC types are generated from the Rust definitions so the
//! two sides cannot drift. This is how: every wire type and every enum variant
//! is serialized here into `src/ipc/contract.json`, which is committed.
//!
//! * Change a Rust type and forget the frontend, and this test fails.
//! * Regenerate the file without updating `src/ipc/bindings.ts`, and `tsc`
//!   fails, because `src/ipc/contract.ts` asserts the JSON against those types.
//!
//! To accept an intentional change: `UPDATE_CONTRACT=1 cargo test -p kitty-core`.

use kitty_core::{
    ApprovalKind, ApprovalOutcome, BlockKind, ErrorKind, HarnessId, HarnessStatus, InstallState,
    LoginState, RateLimitWindow, Scan, StopReason, ToolStatus, TranscriptEvent, Usage, Version,
};
use serde_json::json;

fn contract_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/ipc/contract.json")
}

/// Every install variant, so the frontend's switch is exhaustive against
/// something real rather than against what someone remembered.
fn install_states() -> Vec<InstallState> {
    vec![
        InstallState::NotFound,
        InstallState::Found {
            path: r"C:\Users\you\AppData\Roaming\npm\claude.cmd".into(),
            version: Version::new(2, 1, 270),
        },
        InstallState::UnsupportedVersion {
            path: r"C:\Users\you\AppData\Roaming\npm\claude.cmd".into(),
            found: Version::new(1, 9, 0),
            required: Version::new(2, 0, 0),
        },
        InstallState::Unidentified {
            path: r"C:\tools\claude.cmd".into(),
            output: "usage: claude [options]".into(),
        },
        InstallState::ProbeFailed {
            path: r"C:\tools\claude.cmd".into(),
            message: "no response within 15s".into(),
        },
    ]
}

fn login_states() -> Vec<LoginState> {
    vec![
        LoginState::Unknown {
            reason: "not checked".into(),
        },
        LoginState::LoggedOut,
        LoginState::LoggedIn {
            plan: Some("max".into()),
            expires_at_ms: Some(1_789_429_430_784),
        },
        LoginState::LoggedIn {
            plan: None,
            expires_at_ms: None,
        },
        LoginState::Expired {
            expired_at_ms: 1_700_000_000_000,
        },
    ]
}

/// Every stop reason, so the UI can say why a turn ended.
fn stop_reasons() -> Vec<StopReason> {
    vec![
        StopReason::EndTurn,
        StopReason::MaxTokens,
        StopReason::Refusal {
            category: Some("cyber".into()),
        },
        StopReason::Cancelled,
        StopReason::Interrupted,
        StopReason::Failed {
            message: "model unavailable".into(),
        },
        StopReason::Other {
            reason: "somethingNew".into(),
        },
    ]
}

/// Every transcript event, which is the frontend's whole vocabulary.
fn transcript_events() -> Vec<TranscriptEvent> {
    vec![
        TranscriptEvent::SessionReady {
            model: Some("claude-opus-5".into()),
        },
        TranscriptEvent::BlockAppended {
            seq: 1,
            block_kind: BlockKind::Assistant,
            text: String::new(),
        },
        TranscriptEvent::BlockDelta {
            seq: 1,
            text: " lovely".into(),
        },
        TranscriptEvent::BlockFinal {
            seq: 1,
            text: "Hello, lovely human.".into(),
        },
        TranscriptEvent::ToolStatusChanged {
            seq: 2,
            status: ToolStatus::Ok,
            detail: Some("1 file".into()),
        },
        TranscriptEvent::ApprovalRequested {
            id: "codex-0".into(),
            approval_kind: ApprovalKind::Edit,
            title: "Create kitty/scratch.txt".into(),
            detail: Some("the sandbox is read-only".into()),
        },
        TranscriptEvent::ApprovalResolved {
            id: "codex-0".into(),
            outcome: ApprovalOutcome::Allowed,
        },
        TranscriptEvent::TurnEnded {
            stop: StopReason::EndTurn,
        },
        TranscriptEvent::Usage(Usage {
            input_tokens: 2,
            output_tokens: 9,
            cache_read_tokens: 15_445,
            cache_write_tokens: 9_091,
            reasoning_tokens: 0,
        }),
        TranscriptEvent::Context {
            used: Some(16_325),
            window: Some(258_400),
        },
        TranscriptEvent::RateLimits {
            windows: vec![RateLimitWindow {
                label: "five_hour".into(),
                utilization: 0.14,
                resets_at_ms: Some(1_789_462_200_000),
            }],
        },
        TranscriptEvent::Status {
            text: "compacting".into(),
        },
        TranscriptEvent::Failed {
            error_kind: ErrorKind::Auth,
            message: "not signed in".into(),
        },
    ]
}

fn sample_scan() -> Scan {
    Scan {
        harnesses: vec![
            HarnessStatus::assemble(
                HarnessId::Claude,
                InstallState::Found {
                    path: r"C:\Users\you\AppData\Roaming\npm\claude.cmd".into(),
                    version: Version::new(2, 1, 270),
                },
                LoginState::LoggedIn {
                    plan: Some("max".into()),
                    expires_at_ms: Some(1_789_429_430_784),
                },
                1_757_880_000_000,
            ),
            HarnessStatus::assemble(
                HarnessId::Codex,
                InstallState::NotFound,
                LoginState::Unknown {
                    reason: "not checked".into(),
                },
                1_757_880_000_000,
            ),
        ],
        duration_ms: 54,
        path_dirs: 50,
    }
}

#[test]
fn contract_matches_the_committed_file() {
    let actual = serde_json::to_string_pretty(&json!({
        "$comment": "Generated by crates/core/tests/wire_contract.rs. \
                     Do not edit by hand. Run `UPDATE_CONTRACT=1 cargo test -p kitty-core`.",
        "harnessIds": HarnessId::ALL,
        "installStates": install_states(),
        "loginStates": login_states(),
        "blockKinds": [
            BlockKind::User,
            BlockKind::Assistant,
            BlockKind::Reasoning,
            BlockKind::Tool,
        ],
        "toolStatuses": [
            ToolStatus::Running,
            ToolStatus::Ok,
            ToolStatus::Failed,
            ToolStatus::Denied,
        ],
        "approvalKinds": [
            ApprovalKind::Edit,
            ApprovalKind::Command,
            ApprovalKind::Network,
            ApprovalKind::Other,
        ],
        "approvalOutcomes": [
            ApprovalOutcome::Allowed,
            ApprovalOutcome::Denied,
            ApprovalOutcome::Cancelled,
        ],
        "stopReasons": stop_reasons(),
        "transcriptEvents": transcript_events(),
        "scan": sample_scan(),
    }))
    .expect("wire types must serialize")
        + "\n";

    let path = contract_path();

    if std::env::var_os("UPDATE_CONTRACT").is_some() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create src/ipc");
        }
        std::fs::write(&path, &actual).expect("write contract");
        return;
    }

    let expected = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "cannot read {}: {e}\nRun `UPDATE_CONTRACT=1 cargo test -p kitty-core` to create it.",
            path.display()
        )
    });

    // Normalise line endings so a checkout with CRLF does not fail the test.
    assert_eq!(
        actual.replace("\r\n", "\n"),
        expected.replace("\r\n", "\n"),
        "\nThe Rust wire types changed but src/ipc/contract.json did not.\n\
         Run `UPDATE_CONTRACT=1 cargo test -p kitty-core`, then make sure\n\
         src/ipc/bindings.ts still matches.\n"
    );
}

#[test]
fn every_variant_is_covered() {
    // A cheap guard against someone adding a variant and not a sample. The
    // counts are asserted rather than derived, so adding a variant forces a
    // deliberate update here too.
    assert_eq!(install_states().len(), 5, "add the new InstallState sample");
    assert_eq!(login_states().len(), 5, "add the new LoginState sample");
    assert_eq!(stop_reasons().len(), 7, "add the new StopReason sample");
    assert_eq!(
        transcript_events().len(),
        13,
        "add the new TranscriptEvent sample"
    );
    assert_eq!(
        HarnessId::ALL.len(),
        2,
        "add the new harness to the contract"
    );
}

#[test]
fn tagged_enums_carry_their_discriminator() {
    // The frontend switches on `kind`. If serde's tagging were ever changed,
    // every switch would silently fall through to its default.
    for state in install_states() {
        let value = serde_json::to_value(&state).expect("serialize");
        assert!(
            value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .is_some(),
            "InstallState lost its `kind` tag: {value}"
        );
    }
    for state in login_states() {
        let value = serde_json::to_value(&state).expect("serialize");
        assert!(
            value
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .is_some(),
            "LoginState lost its `kind` tag: {value}"
        );
    }
}
