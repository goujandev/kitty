//! Enforces prototype-1 acceptance criterion 3: *no credential file is ever
//! opened for writing.*
//!
//! ADR-0004 forbids kitty from writing vendor credential stores, refreshing
//! tokens, or impersonating a vendor client. `MonoCode` does all three for its
//! usage meter, and rotating a refresh token underneath a running `claude`
//! process can log the user out of their real tool.
//!
//! "We decided not to" is not a guarantee, so this is checked two ways: the
//! source of the credentials module may not name a write API, and a real probe
//! against a real file must leave its bytes and its modification time alone.

use std::collections::HashMap;
use std::path::PathBuf;

use kitty_probe::credentials::{credentials_path, login_state};
use kitty_probe::EnvSnapshot;

/// Write-capable APIs that must never appear in the credentials module.
///
/// Kept here rather than in the module under test so the needles cannot match
/// themselves.
const FORBIDDEN: &[&str] = &[
    "File::create",
    "OpenOptions",
    "fs::write",
    "write_all",
    "write!",
    "writeln!",
    "fs::remove_file",
    "fs::rename",
    "fs::copy",
    "set_permissions",
    "set_len",
    "create_dir",
    "sync_all",
];

fn credentials_source() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("credentials.rs");
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

#[test]
fn credentials_module_names_no_write_api() {
    let source = credentials_source();
    let mut offenders = Vec::new();

    for needle in FORBIDDEN {
        for (number, line) in source.lines().enumerate() {
            // Doc comments explain the policy and may mention these words.
            if line.trim_start().starts_with("//") {
                continue;
            }
            if line.contains(needle) {
                offenders.push(format!(
                    "line {}: {needle} in `{}`",
                    number + 1,
                    line.trim()
                ));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "credentials.rs must never write. Found:\n  {}",
        offenders.join("\n  ")
    );
}

#[test]
fn reading_a_credential_file_does_not_disturb_it() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = dir.path().join("cfg");
    std::fs::create_dir_all(&config).expect("mkdir");

    let file = config.join(".credentials.json");
    let original = br#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":4102444800000,"subscriptionType":"max"}}"#;
    std::fs::write(&file, original).expect("seed credentials");

    let before_bytes = std::fs::read(&file).expect("read before");
    let before_mtime = std::fs::metadata(&file)
        .and_then(|m| m.modified())
        .expect("mtime before");

    let env = EnvSnapshot::from_parts(
        Vec::new(),
        HashMap::from([(
            "CLAUDE_CONFIG_DIR".to_owned(),
            config.to_string_lossy().into_owned(),
        )]),
    );

    // Point at our fixture, then probe it several times.
    assert_eq!(
        credentials_path(&kitty_core::CLAUDE, &env),
        Some(file.clone())
    );
    for _ in 0..5 {
        let state = login_state(&kitty_core::CLAUDE, &env);
        assert!(
            matches!(state, kitty_core::LoginState::LoggedIn { .. }),
            "fixture should read as signed in, got {state:?}"
        );
    }

    assert_eq!(
        std::fs::read(&file).expect("read after"),
        before_bytes,
        "probing rewrote the credential file"
    );
    assert_eq!(
        std::fs::metadata(&file)
            .and_then(|m| m.modified())
            .expect("mtime after"),
        before_mtime,
        "probing touched the credential file's modification time"
    );
}

#[test]
fn a_missing_credential_file_is_not_created() {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = dir.path().join("cfg");
    std::fs::create_dir_all(&config).expect("mkdir");

    let env = EnvSnapshot::from_parts(
        Vec::new(),
        HashMap::from([(
            "CODEX_HOME".to_owned(),
            config.to_string_lossy().into_owned(),
        )]),
    );

    let state = login_state(&kitty_core::CODEX, &env);
    assert!(matches!(state, kitty_core::LoginState::LoggedOut));

    assert!(
        !config.join("auth.json").exists(),
        "probing created a credential file that did not exist"
    );
    assert_eq!(
        std::fs::read_dir(&config).expect("read_dir").count(),
        0,
        "probing left something behind in the config directory"
    );
}
