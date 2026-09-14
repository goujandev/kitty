//! Semantic-ish version parsing.
//!
//! Vendor CLIs do not agree on how to print a version. Observed on Windows,
//! 2026-09-14:
//!
//! ```text
//! claude --version  ->  "2.1.270 (Claude Code)"
//! codex  --version  ->  "codex-cli 0.153.4"
//! ```
//!
//! So we do not parse a format; we find the first `N.N.N` in the output. That
//! is deliberately tolerant: a CLI is free to add a prefix, a suffix, a build
//! tag, or ANSI colour, and we still get the number.
//!
//! This is the structured identity check ADR-0004 calls for, as opposed to
//! `MonoCode`'s approach of running `--help` and string-matching its prose.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

/// A `major.minor.patch` triple. Pre-release and build metadata are ignored.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl Version {
    #[must_use]
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }

    /// Finds the first `N.N.N` sequence anywhere in `text`.
    ///
    /// Returns `None` when there is no such sequence, which for a version
    /// probe means "this binary is not the CLI we think it is".
    #[must_use]
    pub fn find_in(text: &str) -> Option<Self> {
        let bytes = text.as_bytes();

        for start in 0..bytes.len() {
            if !bytes[start].is_ascii_digit() {
                continue;
            }
            // A candidate must not be preceded by a digit or a dot, or we
            // would match the tail of something like "1.2.3.4" as "2.3.4".
            if start > 0 && (bytes[start - 1] == b'.' || bytes[start - 1].is_ascii_digit()) {
                continue;
            }
            if let Some(version) = Self::parse_at(bytes, start) {
                return Some(version);
            }
        }
        None
    }

    /// Parses exactly `N.N.N` starting at `at`.
    fn parse_at(bytes: &[u8], at: usize) -> Option<Self> {
        let (major, i) = take_number(bytes, at)?;
        let i = expect_dot(bytes, i)?;
        let (minor, i) = take_number(bytes, i)?;
        let i = expect_dot(bytes, i)?;
        let (patch, _) = take_number(bytes, i)?;
        Some(Self::new(major, minor, patch))
    }
}

fn expect_dot(bytes: &[u8], i: usize) -> Option<usize> {
    (bytes.get(i) == Some(&b'.')).then_some(i + 1)
}

fn take_number(bytes: &[u8], start: usize) -> Option<(u32, usize)> {
    let mut i = start;
    let mut value: u32 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        value = value
            .checked_mul(10)?
            .checked_add(u32::from(bytes[i] - b'0'))?;
        i += 1;
    }
    (i > start).then_some((value, i))
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[cfg(test)]
mod tests {
    use super::Version;

    #[test]
    fn parses_real_cli_output() {
        // Captured from the development machine, 2026-09-14.
        assert_eq!(
            Version::find_in("2.1.270 (Claude Code)"),
            Some(Version::new(2, 1, 270))
        );
        assert_eq!(
            Version::find_in("codex-cli 0.153.4"),
            Some(Version::new(0, 153, 4))
        );
    }

    #[test]
    fn tolerates_noise_around_the_number() {
        assert_eq!(
            Version::find_in("  v1.2.3\r\n"),
            Some(Version::new(1, 2, 3))
        );
        assert_eq!(
            Version::find_in("build tag 2026, version 10.0.1 (beta)"),
            Some(Version::new(10, 0, 1))
        );
    }

    #[test]
    fn takes_the_first_full_triple() {
        assert_eq!(
            Version::find_in("tool 1.2.3 using lib 9.9.9"),
            Some(Version::new(1, 2, 3))
        );
    }

    #[test]
    fn does_not_match_the_tail_of_a_longer_sequence() {
        // "1.2.3.4" should read as 1.2.3, not 2.3.4.
        assert_eq!(Version::find_in("1.2.3.4"), Some(Version::new(1, 2, 3)));
    }

    #[test]
    fn rejects_output_without_a_triple() {
        assert_eq!(Version::find_in(""), None);
        assert_eq!(Version::find_in("no version here"), None);
        assert_eq!(Version::find_in("1.2"), None);
        assert_eq!(Version::find_in("command not found"), None);
    }

    #[test]
    fn skips_a_partial_triple_and_finds_a_later_one() {
        assert_eq!(
            Version::find_in("1.2 then 3.4.5"),
            Some(Version::new(3, 4, 5))
        );
    }

    #[test]
    fn orders_numerically_not_lexically() {
        assert!(Version::new(2, 1, 270) > Version::new(2, 1, 99));
        assert!(Version::new(0, 153, 4) > Version::new(0, 99, 0));
        assert!(Version::new(1, 0, 0) > Version::new(0, 999, 999));
    }

    #[test]
    fn does_not_overflow_on_absurd_input() {
        assert_eq!(Version::find_in("99999999999.1.1"), None);
    }

    #[test]
    fn displays_round_trip() {
        assert_eq!(Version::new(2, 1, 270).to_string(), "2.1.270");
    }
}
