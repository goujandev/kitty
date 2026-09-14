//! Which agent CLIs kitty knows about.
//!
//! This is the seed of the manifest described in ADR-0002. Slice 1 only needs
//! the identity, discovery and version fields; transport, codec and capability
//! fields arrive with slice 2. The important property is already in place:
//! everything that differs between CLIs is **data in one table**, not a branch
//! somewhere else in the codebase.

use serde::{Deserialize, Serialize};

use crate::Version;

/// A CLI kitty can drive.
///
/// Closed for now. It becomes a lookup over manifests once there are more than
/// two, which is the point at which a union stops paying for itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessId {
    Claude,
    Codex,
}

impl HarnessId {
    pub const ALL: [Self; 2] = [Self::Claude, Self::Codex];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    #[must_use]
    pub const fn descriptor(self) -> &'static HarnessDescriptor {
        match self {
            Self::Claude => &CLAUDE,
            Self::Codex => &CODEX,
        }
    }
}

impl std::fmt::Display for HarnessId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Static facts about one CLI.
#[derive(Debug, Clone)]
pub struct HarnessDescriptor {
    pub id: HarnessId,
    pub label: &'static str,
    pub vendor: &'static str,
    /// Base name of the executable, without an extension.
    pub exe_stem: &'static str,
    /// Directories to search in addition to `PATH`, most specific first.
    ///
    /// `%VAR%` is expanded against the environment. These cover the places
    /// each vendor's installer actually puts things on Windows, which is why
    /// discovery keeps working even when `PATH` is stale.
    pub extra_dirs: &'static [&'static str],
    /// Config directory name under the user profile, when the env var is unset.
    pub config_dir_name: &'static str,
    /// Environment variable that relocates the CLI's config directory.
    pub config_dir_env: &'static str,
    /// Path of the credentials file relative to the config directory.
    pub credentials_rel: &'static str,
    /// Below this we refuse to drive the CLI.
    ///
    /// These floors are deliberately permissive. We have not yet established
    /// what the codecs actually require, so an invented floor would lock out a
    /// working install for no reason. Slice 2 tightens them against evidence.
    pub min_version: Version,
    /// The newest version a human has actually run kitty against.
    pub verified_version: Version,
    pub install_command: &'static str,
    pub login_command: &'static str,
    pub docs_url: &'static str,
}

pub static CLAUDE: HarnessDescriptor = HarnessDescriptor {
    id: HarnessId::Claude,
    label: "Claude Code",
    vendor: "Anthropic",
    exe_stem: "claude",
    extra_dirs: &[
        r"%APPDATA%\npm",
        r"%USERPROFILE%\.claude\local",
        r"%LOCALAPPDATA%\Programs\claude",
    ],
    config_dir_name: ".claude",
    config_dir_env: "CLAUDE_CONFIG_DIR",
    credentials_rel: ".credentials.json",
    min_version: Version::new(2, 0, 0),
    verified_version: Version::new(2, 1, 270),
    install_command: "npm install -g @anthropic-ai/claude-code",
    login_command: "claude auth login",
    docs_url: "https://claude.com/product/claude-code",
};

pub static CODEX: HarnessDescriptor = HarnessDescriptor {
    id: HarnessId::Codex,
    label: "Codex",
    vendor: "OpenAI",
    exe_stem: "codex",
    extra_dirs: &[
        r"%LOCALAPPDATA%\Programs\OpenAI\Codex\bin",
        r"%APPDATA%\npm",
    ],
    config_dir_name: ".codex",
    config_dir_env: "CODEX_HOME",
    credentials_rel: "auth.json",
    min_version: Version::new(0, 1, 0),
    verified_version: Version::new(0, 153, 4),
    install_command: "npm install -g @openai/codex",
    login_command: "codex login",
    docs_url: "https://developers.openai.com/codex/cli",
};

#[cfg(test)]
mod tests {
    use super::{HarnessId, CLAUDE, CODEX};

    #[test]
    fn every_id_has_a_matching_descriptor() {
        for id in HarnessId::ALL {
            assert_eq!(id.descriptor().id, id, "descriptor table is mis-wired");
        }
    }

    #[test]
    fn descriptors_are_populated() {
        for id in HarnessId::ALL {
            let d = id.descriptor();
            assert!(!d.label.is_empty());
            assert!(!d.vendor.is_empty());
            assert!(!d.exe_stem.is_empty());
            assert!(!d.install_command.is_empty());
            assert!(!d.login_command.is_empty());
            assert!(d.docs_url.starts_with("https://"));
        }
    }

    #[test]
    fn verified_version_is_at_or_above_the_floor() {
        for id in HarnessId::ALL {
            let d = id.descriptor();
            assert!(
                d.verified_version >= d.min_version,
                "{} claims to be verified below its own floor",
                d.label
            );
        }
    }

    #[test]
    fn serde_uses_stable_lowercase_names() {
        // The frontend switches on these strings. Renaming a variant must not
        // silently change the wire value.
        let json = serde_json::to_string(&HarnessId::ALL).unwrap_or_default();
        assert_eq!(json, r#"["claude","codex"]"#);
        assert_eq!(CLAUDE.exe_stem, "claude");
        assert_eq!(CODEX.exe_stem, "codex");
    }
}
