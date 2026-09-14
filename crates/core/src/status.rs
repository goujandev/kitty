//! What kitty knows about one CLI right now, and what the user should do
//! about it.
//!
//! ADR-0004: a harness that is missing, logged out or too old is still listed,
//! with the reason and the exact command that fixes it. Hiding it just makes
//! the app look broken.
//!
//! Install state and login state are tracked separately because they fail
//! separately and have different remedies.

use serde::{Deserialize, Serialize};

use crate::{HarnessId, Version};

/// Whether the binary is present and usable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallState {
    /// No candidate path matched.
    NotFound,
    /// Found, identified, and new enough.
    Found { path: String, version: Version },
    /// Found and identified, but below the floor in the descriptor.
    UnsupportedVersion {
        path: String,
        found: Version,
        required: Version,
    },
    /// Something is at that path but it did not print a version we recognise,
    /// so we will not claim it is the CLI we were looking for.
    Unidentified { path: String, output: String },
    /// The probe itself failed: spawn error, timeout, non-zero exit.
    ProbeFailed { path: String, message: String },
}

impl InstallState {
    #[must_use]
    pub fn path(&self) -> Option<&str> {
        match self {
            Self::NotFound => None,
            Self::Found { path, .. }
            | Self::UnsupportedVersion { path, .. }
            | Self::Unidentified { path, .. }
            | Self::ProbeFailed { path, .. } => Some(path),
        }
    }

    #[must_use]
    pub const fn version(&self) -> Option<Version> {
        match self {
            Self::Found { version, .. } => Some(*version),
            Self::UnsupportedVersion { found, .. } => Some(*found),
            _ => None,
        }
    }

    #[must_use]
    pub const fn is_usable(&self) -> bool {
        matches!(self, Self::Found { .. })
    }
}

/// Whether the CLI appears to be signed in.
///
/// Derived from the vendor's own credential file, read-only. kitty never
/// writes these files and never refreshes a token (ADR-0004), so `LoggedIn`
/// means "the stored token has not expired", not "the provider accepted it".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LoginState {
    /// We did not look, or could not tell. Never shown as an error.
    Unknown { reason: String },
    /// No credential file, or it holds no usable token.
    LoggedOut,
    LoggedIn {
        /// Subscription label when the vendor records one, e.g. "max".
        plan: Option<String>,
        /// Unix milliseconds, when the vendor records an expiry.
        expires_at_ms: Option<i64>,
    },
    /// A token is stored but its expiry has passed. The vendor CLI will
    /// refresh it on next use; kitty will not do that for it.
    Expired { expired_at_ms: i64 },
}

impl LoginState {
    #[must_use]
    pub const fn is_signed_in(&self) -> bool {
        matches!(self, Self::LoggedIn { .. })
    }
}

/// What the user should do next, with a command they can copy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub message: String,
    pub command: Option<String>,
    pub url: Option<String>,
}

/// The full picture for one harness, ready to render.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessStatus {
    pub id: HarnessId,
    pub label: String,
    pub vendor: String,
    pub install: InstallState,
    pub login: LoginState,
    /// Installed, new enough, and signed in.
    pub ready: bool,
    pub hint: Option<Hint>,
    /// Newest version kitty has been verified against, for an "untested"
    /// warning when the user is ahead of us (ADR-0002).
    pub verified_version: Version,
    /// True when the install is newer than `verified_version`. A warning, not
    /// a refusal.
    pub newer_than_verified: bool,
    pub checked_at_ms: i64,
}

impl HarnessStatus {
    /// Assembles a status and derives `ready`, the hint, and the version
    /// warning from the two states. Keeping this in one place means the UI
    /// cannot disagree with the backend about what "ready" means.
    #[must_use]
    pub fn assemble(
        id: HarnessId,
        install: InstallState,
        login: LoginState,
        checked_at_ms: i64,
    ) -> Self {
        let d = id.descriptor();
        let ready = install.is_usable() && login.is_signed_in();
        let newer_than_verified = install.version().is_some_and(|v| v > d.verified_version);

        let hint = if ready {
            None
        } else {
            Some(match &install {
                InstallState::NotFound => Hint {
                    message: format!("{} is not installed.", d.label),
                    command: Some(d.install_command.to_owned()),
                    url: Some(d.docs_url.to_owned()),
                },
                InstallState::UnsupportedVersion {
                    found, required, ..
                } => Hint {
                    message: format!(
                        "{} {found} is older than the {required} kitty needs.",
                        d.label
                    ),
                    command: Some(d.install_command.to_owned()),
                    url: Some(d.docs_url.to_owned()),
                },
                InstallState::Unidentified { path, .. } => Hint {
                    message: format!(
                        "Found {path}, but it did not report a version kitty recognises."
                    ),
                    command: None,
                    url: Some(d.docs_url.to_owned()),
                },
                InstallState::ProbeFailed { message, .. } => Hint {
                    message: format!("Could not run {}: {message}", d.label),
                    command: None,
                    url: Some(d.docs_url.to_owned()),
                },
                InstallState::Found { .. } => match &login {
                    LoginState::Expired { .. } => Hint {
                        message: format!("The {} session has expired.", d.label),
                        command: Some(d.login_command.to_owned()),
                        url: None,
                    },
                    LoginState::Unknown { reason } => Hint {
                        message: format!(
                            "Could not tell whether {} is signed in: {reason}",
                            d.label
                        ),
                        command: Some(d.login_command.to_owned()),
                        url: None,
                    },
                    // LoggedOut, and the unreachable LoggedIn arm.
                    _ => Hint {
                        message: format!("{} is not signed in.", d.label),
                        command: Some(d.login_command.to_owned()),
                        url: None,
                    },
                },
            })
        };

        Self {
            id,
            label: d.label.to_owned(),
            vendor: d.vendor.to_owned(),
            install,
            login,
            ready,
            hint,
            verified_version: d.verified_version,
            newer_than_verified,
            checked_at_ms,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{HarnessStatus, InstallState, LoginState};
    use crate::{HarnessId, Version};

    fn found(v: Version) -> InstallState {
        InstallState::Found {
            path: r"C:\bin\claude.cmd".into(),
            version: v,
        }
    }

    fn signed_in() -> LoginState {
        LoginState::LoggedIn {
            plan: Some("max".into()),
            expires_at_ms: Some(1_789_429_430_784),
        }
    }

    #[test]
    fn ready_requires_both_install_and_login() {
        let s = HarnessStatus::assemble(
            HarnessId::Claude,
            found(Version::new(2, 1, 270)),
            signed_in(),
            0,
        );
        assert!(s.ready);
        assert!(s.hint.is_none(), "a ready harness needs no hint");
    }

    #[test]
    fn missing_binary_suggests_installing() {
        let s = HarnessStatus::assemble(
            HarnessId::Claude,
            InstallState::NotFound,
            LoginState::LoggedOut,
            0,
        );
        assert!(!s.ready);
        let hint = s.hint.expect("missing binary must produce a hint");
        assert!(hint.message.contains("not installed"));
        assert_eq!(
            hint.command.as_deref(),
            Some("npm install -g @anthropic-ai/claude-code")
        );
    }

    #[test]
    fn install_problems_outrank_login_problems() {
        // No point telling someone to sign in to a CLI they do not have.
        let s = HarnessStatus::assemble(
            HarnessId::Codex,
            InstallState::NotFound,
            LoginState::LoggedOut,
            0,
        );
        let hint = s.hint.expect("hint");
        assert!(hint.message.contains("not installed"));
        assert!(!hint.message.contains("signed in"));
    }

    #[test]
    fn installed_but_logged_out_suggests_the_login_command() {
        let s = HarnessStatus::assemble(
            HarnessId::Codex,
            InstallState::Found {
                path: r"C:\bin\codex.exe".into(),
                version: Version::new(0, 153, 4),
            },
            LoginState::LoggedOut,
            0,
        );
        assert!(!s.ready);
        let hint = s.hint.expect("hint");
        assert!(hint.message.contains("not signed in"));
        assert_eq!(hint.command.as_deref(), Some("codex login"));
    }

    #[test]
    fn expired_session_is_distinct_from_logged_out() {
        let s = HarnessStatus::assemble(
            HarnessId::Claude,
            found(Version::new(2, 1, 270)),
            LoginState::Expired {
                expired_at_ms: 1_700_000_000_000,
            },
            0,
        );
        let hint = s.hint.expect("hint");
        assert!(hint.message.contains("expired"));
        assert_eq!(hint.command.as_deref(), Some("claude auth login"));
    }

    #[test]
    fn old_version_reports_both_numbers() {
        let s = HarnessStatus::assemble(
            HarnessId::Claude,
            InstallState::UnsupportedVersion {
                path: r"C:\bin\claude.cmd".into(),
                found: Version::new(1, 0, 0),
                required: Version::new(2, 0, 0),
            },
            signed_in(),
            0,
        );
        assert!(!s.ready);
        let hint = s.hint.expect("hint");
        assert!(hint.message.contains("1.0.0"));
        assert!(hint.message.contains("2.0.0"));
    }

    #[test]
    fn newer_than_verified_is_a_warning_not_a_block() {
        let s = HarnessStatus::assemble(
            HarnessId::Claude,
            found(Version::new(99, 0, 0)),
            signed_in(),
            0,
        );
        assert!(s.ready, "being ahead of us must not block the user");
        assert!(s.newer_than_verified);
        assert!(s.hint.is_none());
    }

    #[test]
    fn verified_version_is_not_flagged() {
        let claude = HarnessId::Claude.descriptor().verified_version;
        let s = HarnessStatus::assemble(HarnessId::Claude, found(claude), signed_in(), 0);
        assert!(!s.newer_than_verified);
    }

    #[test]
    fn unknown_login_still_offers_the_login_command() {
        let s = HarnessStatus::assemble(
            HarnessId::Codex,
            InstallState::Found {
                path: r"C:\bin\codex.exe".into(),
                version: Version::new(0, 153, 4),
            },
            LoginState::Unknown {
                reason: "auth.json is not valid JSON".into(),
            },
            0,
        );
        assert!(!s.ready);
        let hint = s.hint.expect("hint");
        assert!(hint.message.contains("Could not tell"));
        assert_eq!(hint.command.as_deref(), Some("codex login"));
    }
}

/// The result of one full scan of the machine.
///
/// Lives in `core` rather than the Tauri host so the wire-contract test can
/// cover it alongside everything it contains.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub harnesses: Vec<HarnessStatus>,
    /// How long the scan took, so the UI can be honest about why it waited.
    pub duration_ms: u64,
    /// How many `PATH` directories were searched. Worth showing when a CLI is
    /// missing and the user is wondering where we looked.
    pub path_dirs: usize,
}
