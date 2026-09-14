//! Finds agent CLIs, identifies them, and reads their login state.
//!
//! Everything here is read-only. The probe runs one command per candidate
//! binary, `--version`, and opens the vendor's credential file for reading.
//! It never writes anything, anywhere (ADR-0004).
//!
//! Nothing in this crate runs on the startup path. `EnvSnapshot::capture()`
//! plus `probe_all()` takes seconds, because starting a Node-based CLI is
//! slow, so the host calls it on a background thread once the window is up.

pub mod credentials;
pub mod discover;
pub mod env;
pub mod exec;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use kitty_core::{HarnessId, HarnessStatus, InstallState, Version};

pub use env::EnvSnapshot;

/// How long one `--version` call may take.
///
/// Generous on purpose: `claude` is an npm shim that boots Node, and a cold
/// first run on Windows can be slow. Timing out early would report a working
/// install as broken, which is a far worse failure than waiting.
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

/// Probes every known harness. Each runs on its own thread, so the total cost
/// is the slowest CLI rather than their sum.
#[must_use]
pub fn probe_all(env: &EnvSnapshot) -> Vec<HarnessStatus> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = HarnessId::ALL
            .into_iter()
            .map(|id| scope.spawn(move || probe_one(id, env)))
            .collect();

        handles
            .into_iter()
            .enumerate()
            .map(|(index, handle)| {
                handle.join().unwrap_or_else(|_| {
                    // A panicking probe must not take the app down or hide the
                    // harness. Report it as a failed probe instead.
                    let id = HarnessId::ALL[index];
                    HarnessStatus::assemble(
                        id,
                        InstallState::ProbeFailed {
                            path: String::new(),
                            message: "the probe panicked".to_owned(),
                        },
                        kitty_core::LoginState::Unknown {
                            reason: "probe did not complete".to_owned(),
                        },
                        now_ms(),
                    )
                })
            })
            .collect()
    })
}

/// Probes one harness: find it, identify it, then read its login state.
#[must_use]
pub fn probe_one(id: HarnessId, env: &EnvSnapshot) -> HarnessStatus {
    let descriptor = id.descriptor();
    let install = resolve_install(id, env);

    // Only bother reading credentials for an install we would actually use.
    // Reporting "not signed in" for a CLI that is not installed is noise.
    let login = if install.is_usable() {
        credentials::login_state(descriptor, env)
    } else {
        kitty_core::LoginState::Unknown {
            reason: "not checked".to_owned(),
        }
    };

    HarnessStatus::assemble(id, install, login, now_ms())
}

/// Walks the candidates in order and returns the first that identifies itself.
///
/// If none do, we report the most informative failure we saw rather than a
/// bare "not found", because "there is a claude.cmd on your PATH but it did
/// not print a version" is a very different problem to "you have not installed
/// it".
fn resolve_install(id: HarnessId, env: &EnvSnapshot) -> InstallState {
    let descriptor = id.descriptor();
    let candidates = discover::candidates(descriptor, env);
    if candidates.is_empty() {
        return InstallState::NotFound;
    }

    let mut fallback: Option<InstallState> = None;

    for candidate in candidates {
        let path = candidate.path.to_string_lossy().into_owned();

        let output = match exec::run_capture(&candidate.path, &["--version"], VERSION_TIMEOUT) {
            Ok(output) => output,
            Err(error) => {
                fallback.get_or_insert(InstallState::ProbeFailed {
                    path,
                    message: error.to_string(),
                });
                continue;
            }
        };

        let combined = output.combined();
        let Some(found) = Version::find_in(&combined) else {
            fallback.get_or_insert(InstallState::Unidentified {
                path,
                output: first_line(&combined),
            });
            continue;
        };

        if found < descriptor.min_version {
            return InstallState::UnsupportedVersion {
                path,
                found,
                required: descriptor.min_version,
            };
        }
        return InstallState::Found {
            path,
            version: found,
        };
    }

    fallback.unwrap_or(InstallState::NotFound)
}

/// Keeps an error message to one readable line.
fn first_line(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let trimmed = line.trim();
    if trimmed.len() > 200 {
        format!("{}…", &trimmed[..200])
    } else {
        trimmed.to_owned()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{first_line, probe_all, resolve_install, EnvSnapshot};
    use kitty_core::{HarnessId, InstallState};
    use std::collections::HashMap;

    #[test]
    fn nothing_installed_reports_not_found() {
        let env = EnvSnapshot::from_parts(Vec::new(), HashMap::new());
        assert_eq!(
            resolve_install(HarnessId::Claude, &env),
            InstallState::NotFound
        );
    }

    #[test]
    fn a_binary_that_says_nothing_useful_is_unidentified() {
        let dir = tempfile::tempdir().expect("tempdir");
        // A .cmd that prints something without a version triple.
        std::fs::write(dir.path().join("claude.cmd"), "@echo off\r\necho hello\r\n")
            .expect("write shim");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        let state = resolve_install(HarnessId::Claude, &env);

        match state {
            InstallState::Unidentified { output, .. } => assert!(output.contains("hello")),
            other => panic!("expected Unidentified, got {other:?}"),
        }
    }

    #[test]
    fn an_old_version_is_reported_with_both_numbers() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("claude.cmd"), "@echo off\r\necho 1.0.0\r\n")
            .expect("write shim");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        match resolve_install(HarnessId::Claude, &env) {
            InstallState::UnsupportedVersion {
                found, required, ..
            } => {
                assert_eq!(found.to_string(), "1.0.0");
                assert_eq!(required, HarnessId::Claude.descriptor().min_version);
            }
            other => panic!("expected UnsupportedVersion, got {other:?}"),
        }
    }

    #[test]
    fn a_good_version_is_accepted() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("claude.cmd"),
            "@echo off\r\necho 2.1.270 (Claude Code)\r\n",
        )
        .expect("write shim");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        match resolve_install(HarnessId::Claude, &env) {
            InstallState::Found { version, .. } => assert_eq!(version.to_string(), "2.1.270"),
            other => panic!("expected Found, got {other:?}"),
        }
    }

    #[test]
    fn first_line_trims_and_caps() {
        assert_eq!(first_line("\n\n  hello \nworld"), "hello");
        assert_eq!(first_line(""), "");
        assert_eq!(first_line(&"x".repeat(500)).chars().count(), 201);
    }

    #[test]
    fn probe_all_returns_one_status_per_harness_in_order() {
        let env = EnvSnapshot::from_parts(Vec::new(), HashMap::new());
        let statuses = probe_all(&env);
        assert_eq!(statuses.len(), HarnessId::ALL.len());
        for (status, id) in statuses.iter().zip(HarnessId::ALL) {
            assert_eq!(status.id, id);
            assert!(!status.ready);
            assert!(status.hint.is_some());
        }
    }
}
