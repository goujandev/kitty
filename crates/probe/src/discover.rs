//! Finding a CLI's executable.
//!
//! `PATH` first, because that is what the user's own shell would run. Then the
//! vendor-specific directories from the manifest, which cover the case where
//! `PATH` is stale because the CLI was installed after kitty started.
//!
//! Extension order matters on Windows. npm installs three files side by side:
//! `claude` (a shell script, unusable here), `claude.cmd`, and `claude.ps1`
//! (needs `PowerShell` to launch). We want `.exe` if a native installer put one
//! there, otherwise `.cmd`.

use std::path::{Path, PathBuf};

use kitty_core::HarnessDescriptor;

use crate::env::EnvSnapshot;

/// Executable extensions we are willing to launch, best first.
const EXTENSIONS: &[&str] = &["exe", "cmd", "bat"];

/// Where a candidate was found. Useful in the UI and when diagnosing a
/// surprising pick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    Path,
    VendorDir,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub origin: Origin,
}

/// Returns every plausible executable, best first. The caller identifies them
/// by running each until one reports a version it recognises.
#[must_use]
pub fn candidates(descriptor: &HarnessDescriptor, env: &EnvSnapshot) -> Vec<Candidate> {
    let mut found = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut consider = |dir: &Path, origin: &Origin| {
        for ext in EXTENSIONS {
            let path = dir.join(format!("{}.{ext}", descriptor.exe_stem));
            if !path.is_file() {
                continue;
            }
            let key = path.to_string_lossy().to_ascii_lowercase();
            if seen.insert(key) {
                found.push(Candidate {
                    path,
                    origin: origin.clone(),
                });
            }
        }
    };

    for dir in env.path_dirs() {
        consider(dir, &Origin::Path);
    }
    for template in descriptor.extra_dirs {
        if let Some(dir) = env.expand_dir(template) {
            consider(&dir, &Origin::VendorDir);
        }
    }

    found
}

#[cfg(test)]
mod tests {
    use super::{candidates, Origin};
    use crate::env::EnvSnapshot;
    use kitty_core::{HarnessId, CLAUDE};
    use std::collections::HashMap;

    fn touch(dir: &std::path::Path, name: &str) {
        std::fs::write(dir.join(name), b"x").expect("write fixture");
    }

    #[test]
    fn finds_nothing_in_an_empty_environment() {
        let env = EnvSnapshot::from_parts(Vec::new(), HashMap::new());
        assert!(candidates(&CLAUDE, &env).is_empty());
    }

    #[test]
    fn finds_a_cmd_shim_on_path() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(dir.path(), "claude.cmd");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        let found = candidates(&CLAUDE, &env);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].origin, Origin::Path);
        assert!(found[0].path.ends_with("claude.cmd"));
    }

    #[test]
    fn prefers_exe_over_cmd_in_the_same_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(dir.path(), "claude.cmd");
        touch(dir.path(), "claude.exe");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        let found = candidates(&CLAUDE, &env);

        assert_eq!(found.len(), 2);
        assert!(found[0].path.ends_with("claude.exe"), "exe must come first");
    }

    #[test]
    fn ignores_the_powershell_and_shell_shims() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(dir.path(), "claude.ps1");
        touch(dir.path(), "claude");

        let env = EnvSnapshot::from_parts(vec![dir.path().to_path_buf()], HashMap::new());
        assert!(
            candidates(&CLAUDE, &env).is_empty(),
            "neither shim can be launched directly"
        );
    }

    #[test]
    fn path_outranks_a_vendor_directory() {
        let on_path = tempfile::tempdir().expect("tempdir");
        let vendor = tempfile::tempdir().expect("tempdir");
        touch(on_path.path(), "claude.cmd");
        touch(vendor.path(), "claude.cmd");

        let env = EnvSnapshot::from_parts(
            vec![on_path.path().to_path_buf()],
            HashMap::from([(
                "APPDATA".to_owned(),
                vendor.path().to_string_lossy().into_owned(),
            )]),
        );

        // CLAUDE's first vendor template is `%APPDATA%\npm`, so point APPDATA
        // at a parent and create the `npm` child.
        std::fs::create_dir_all(vendor.path().join("npm")).expect("mkdir");
        touch(&vendor.path().join("npm"), "claude.cmd");

        let found = candidates(&CLAUDE, &env);
        assert!(found.len() >= 2);
        assert_eq!(found[0].origin, Origin::Path);
    }

    #[test]
    fn deduplicates_a_directory_listed_twice() {
        let dir = tempfile::tempdir().expect("tempdir");
        touch(dir.path(), "claude.cmd");

        let env = EnvSnapshot::from_parts(
            vec![dir.path().to_path_buf(), dir.path().to_path_buf()],
            HashMap::new(),
        );
        assert_eq!(candidates(&CLAUDE, &env).len(), 1);
    }

    #[test]
    fn every_harness_has_searchable_vendor_dirs() {
        for id in HarnessId::ALL {
            assert!(
                !id.descriptor().extra_dirs.is_empty(),
                "{id} has no vendor directories, so a stale PATH would hide it"
            );
        }
    }
}
