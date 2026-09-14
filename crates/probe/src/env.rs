//! A snapshot of the environment we search for CLIs in.
//!
//! Windows hands a GUI process the environment that existed when it launched.
//! Install a CLI while kitty is running and it stays invisible until something
//! re-reads the environment. Rather than telling the user to restart the app,
//! we re-read the authoritative source, which is the registry, and merge it
//! with the process environment (ADR-0004).
//!
//! `capture()` is the only thing that touches the registry. Everything else
//! works off the snapshot, so a rescan is one capture followed by pure lookups.

use std::collections::HashMap;
use std::path::PathBuf;

/// Environment as of one capture.
#[derive(Debug, Clone, Default)]
pub struct EnvSnapshot {
    /// `PATH` directories in search order, deduplicated.
    path_dirs: Vec<PathBuf>,
    /// Upper-cased variable names to values, for `%VAR%` expansion.
    vars: HashMap<String, String>,
}

impl EnvSnapshot {
    /// Reads the process environment and, on Windows, the user and machine
    /// `Path` values from the registry.
    ///
    /// The process `PATH` comes first because it is what the user's own shell
    /// would use. Registry entries are appended so a freshly installed CLI is
    /// found without a restart.
    #[must_use]
    pub fn capture() -> Self {
        let vars: HashMap<String, String> = std::env::vars()
            .map(|(k, v)| (k.to_ascii_uppercase(), v))
            .collect();

        let mut dirs = Vec::new();
        let mut seen = std::collections::HashSet::new();

        let mut push_all = |raw: &str, vars: &HashMap<String, String>| {
            for entry in raw.split(';') {
                let trimmed = entry.trim().trim_matches('"');
                if trimmed.is_empty() {
                    continue;
                }
                let expanded = expand_vars(trimmed, vars);
                let path = PathBuf::from(expanded);
                let key = path.to_string_lossy().to_ascii_lowercase();
                if seen.insert(key) {
                    dirs.push(path);
                }
            }
        };

        if let Some(process_path) = vars.get("PATH") {
            push_all(process_path, &vars);
        }
        for raw in registry_paths() {
            push_all(&raw, &vars);
        }

        Self {
            path_dirs: dirs,
            vars,
        }
    }

    /// Builds a snapshot from explicit values. Tests use this so they never
    /// depend on the machine they run on.
    #[must_use]
    pub fn from_parts(path_dirs: Vec<PathBuf>, vars: HashMap<String, String>) -> Self {
        Self {
            path_dirs,
            vars: vars
                .into_iter()
                .map(|(k, v)| (k.to_ascii_uppercase(), v))
                .collect(),
        }
    }

    #[must_use]
    pub fn path_dirs(&self) -> &[PathBuf] {
        &self.path_dirs
    }

    #[must_use]
    pub fn var(&self, name: &str) -> Option<&str> {
        self.vars
            .get(&name.to_ascii_uppercase())
            .map(String::as_str)
    }

    /// Expands a `%VAR%` template into a path.
    ///
    /// Returns `None` when a referenced variable is not set, because a
    /// half-expanded path is worse than no path at all.
    #[must_use]
    pub fn expand_dir(&self, template: &str) -> Option<PathBuf> {
        let expanded = expand_vars(template, &self.vars);
        if expanded.contains('%') {
            return None;
        }
        Some(PathBuf::from(expanded))
    }

    /// The user's home directory, used to locate vendor config directories.
    #[must_use]
    pub fn home(&self) -> Option<PathBuf> {
        self.var("USERPROFILE")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    }
}

/// Replaces `%NAME%` with the matching value. Case-insensitive, as Windows is.
/// Unknown names are left untouched so the caller can detect the failure.
fn expand_vars(input: &str, vars: &HashMap<String, String>) -> String {
    if !input.contains('%') {
        return input.to_owned();
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(open) = rest.find('%') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('%') else {
            out.push_str(&rest[open..]);
            return out;
        };
        let name = &after[..close];
        // An unknown name is left literal, `%` and all; `expand_dir` treats a
        // surviving `%` as a failed expansion rather than a usable path.
        if let Some(value) = vars.get(&name.to_ascii_uppercase()) {
            out.push_str(value);
        } else {
            out.push('%');
            out.push_str(name);
            out.push('%');
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
fn registry_paths() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut found = Vec::new();

    let user = RegKey::predef(HKEY_CURRENT_USER).open_subkey("Environment");
    if let Ok(key) = user {
        if let Ok(value) = key.get_value::<String, _>("Path") {
            found.push(value);
        }
    }

    let machine = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment");
    if let Ok(key) = machine {
        if let Ok(value) = key.get_value::<String, _>("Path") {
            found.push(value);
        }
    }

    found
}

#[cfg(not(windows))]
fn registry_paths() -> Vec<String> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::{expand_vars, EnvSnapshot};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn vars() -> HashMap<String, String> {
        HashMap::from([
            (
                "APPDATA".to_owned(),
                r"C:\Users\x\AppData\Roaming".to_owned(),
            ),
            ("USERPROFILE".to_owned(), r"C:\Users\x".to_owned()),
        ])
    }

    #[test]
    fn expands_a_known_variable() {
        assert_eq!(
            expand_vars(r"%APPDATA%\npm", &vars()),
            r"C:\Users\x\AppData\Roaming\npm"
        );
    }

    #[test]
    fn expansion_is_case_insensitive() {
        assert_eq!(
            expand_vars("%appdata%", &vars()),
            r"C:\Users\x\AppData\Roaming"
        );
    }

    #[test]
    fn leaves_unknown_variables_literal() {
        assert_eq!(expand_vars("%NOPE%\\x", &vars()), "%NOPE%\\x");
    }

    #[test]
    fn expand_dir_refuses_a_half_expanded_path() {
        let env = EnvSnapshot::from_parts(Vec::new(), vars());
        assert!(env.expand_dir(r"%NOPE%\npm").is_none());
        assert_eq!(
            env.expand_dir(r"%APPDATA%\npm"),
            Some(PathBuf::from(r"C:\Users\x\AppData\Roaming\npm"))
        );
    }

    #[test]
    fn handles_text_without_variables() {
        assert_eq!(expand_vars(r"C:\bin", &vars()), r"C:\bin");
    }

    #[test]
    fn handles_an_unterminated_percent() {
        assert_eq!(expand_vars("50% done", &vars()), "50% done");
    }

    #[test]
    fn capture_finds_at_least_one_path_dir() {
        // Smoke test against the real machine; PATH is never empty in practice.
        let env = EnvSnapshot::capture();
        assert!(!env.path_dirs().is_empty(), "captured an empty PATH");
    }
}
