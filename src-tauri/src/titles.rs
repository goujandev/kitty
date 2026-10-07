//! Short chat titles, written by the chat's own agent.
//!
//! The first message makes a serviceable title at once (`derive_title`), but a
//! sentence is not a name: "hey we need to redesign the entire UI" should read
//! "Redesign UI". So after the first message the same CLI the chat uses is
//! asked, once, in a throwaway non-interactive call, for two to four words.
//!
//! The call leaves nothing behind in the provider's own history (Claude
//! Code's `--no-session-persistence`, Codex's `exec --ephemeral`), runs in an
//! empty scratch folder with no tools, and is given the message on stdin --
//! never as an argument, because an npm shim goes through `cmd.exe`, which
//! would read `%`, `&` and quotes in someone's message as syntax. Anything
//! that goes wrong just leaves the first-line title in place.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use pantheon_core::HarnessId;
use pantheon_supervisor::{ChildEvent, Frame, SpawnSpec};

/// How long a title may take before the first-line one is simply kept.
const DEADLINE: Duration = Duration::from_secs(60);

/// The longest message excerpt sent; a title needs the opening, not an essay.
const EXCERPT: usize = 1_500;

/// The instruction and the message, as one prompt for stdin.
#[must_use]
pub fn prompt(message: &str) -> String {
    let excerpt: String = message.chars().take(EXCERPT).collect();
    format!(
        "Write a title of 2 to 4 words for a chat that starts with the message below. \
         Use the words a person would use to name the task, e.g. \"Redesign UI\" or \
         \"Fix login crash\". Reply with the title only, no quotes or punctuation.\n\n\
         Message:\n<<<\n{excerpt}\n>>>\n"
    )
}

/// The one-shot command for a provider, run in `scratch`.
#[must_use]
pub fn command(harness: HarnessId, binary: &Path, scratch: &Path) -> SpawnSpec {
    let spec = SpawnSpec::new(binary, scratch);
    match harness {
        // The smallest model is plenty for naming, and no tools means it can
        // only answer.
        HarnessId::Claude => spec.args([
            "-p",
            "--model",
            "haiku",
            "--no-session-persistence",
            "--output-format",
            "text",
            "--tools",
            "",
        ]),
        HarnessId::Codex => spec.args([
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "-c",
            "model_reasoning_effort=low",
            "-",
        ]),
    }
}

/// Turns what the CLI printed into a title, or `None` if it is not one.
#[must_use]
pub fn clean(output: &str) -> Option<String> {
    let line = output
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())?;
    let words: Vec<&str> = line
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '`' || c == '*' || c == '#')
        .trim_end_matches(['.', '!', '?', ':', ';', ','])
        .split_whitespace()
        .collect();
    // A refusal or a paragraph is not a title.
    if words.is_empty() || words.len() > 6 {
        return None;
    }
    let title = words.join(" ");
    if title.chars().count() > 48 {
        return None;
    }
    Some(title)
}

/// A folder of its own for the call, so the agent reads nothing it was not
/// given.
pub fn scratch() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("pantheon-titles");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Runs the call and returns the title, or `None` on any failure.
pub fn generate(harness: HarnessId, binary: &Path, message: &str) -> Option<String> {
    let scratch = scratch().ok()?;
    let mut child = pantheon_supervisor::spawn(&command(harness, binary, &scratch)).ok()?;
    let events = child.take_events()?;
    child.write_line(prompt(message));
    child.close_stdin();

    let deadline = Instant::now() + DEADLINE;
    let mut lines = Vec::new();
    loop {
        let left = deadline.checked_duration_since(Instant::now())?;
        match events.recv_timeout(left) {
            Ok(ChildEvent::Frames(frames)) => {
                lines.extend(frames.into_iter().filter_map(|frame| match frame {
                    Frame::Line(text) => Some(text),
                    Frame::Oversized { .. } => None,
                }));
            }
            Ok(ChildEvent::Exited { code }) => {
                if code.is_some_and(|code| code != 0) {
                    return None;
                }
                break;
            }
            Ok(ChildEvent::Stderr(_) | ChildEvent::ReadFailed { .. }) => {}
            // Out of time: dropping the child kills it and anything it started.
            Err(_) => return None,
        }
    }
    clean(&lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::{clean, command, prompt};
    use pantheon_core::HarnessId;
    use std::path::Path;

    #[test]
    fn a_short_answer_becomes_the_title() {
        assert_eq!(clean("UI Redesign\n").as_deref(), Some("UI Redesign"));
        assert_eq!(
            clean("\"Fix login crash.\"").as_deref(),
            Some("Fix login crash")
        );
        assert_eq!(
            clean("Thinking...\n\n**Redesign UI**").as_deref(),
            Some("Redesign UI")
        );
    }

    #[test]
    fn a_paragraph_or_nothing_is_not_a_title() {
        assert_eq!(clean(""), None);
        assert_eq!(
            clean("I'd be happy to help with a UI redesign, but I need some context first"),
            None
        );
    }

    #[test]
    fn the_message_goes_in_the_prompt_and_never_on_the_command_line() {
        let message = "fix 100% of \"quotes\" & pipes | now";
        let claude = command(HarnessId::Claude, Path::new("claude.cmd"), Path::new("."));
        let codex = command(HarnessId::Codex, Path::new("codex.cmd"), Path::new("."));
        for spec in [&claude, &codex] {
            assert!(spec.args.iter().all(|arg| !arg.contains("100%")));
        }
        assert!(claude.args.contains(&"--no-session-persistence".to_owned()));
        assert!(codex.args.contains(&"--ephemeral".to_owned()));
        assert!(prompt(message).contains(message));
    }
}
