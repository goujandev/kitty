//! Running a CLI once to ask it a question, with a deadline and no console
//! window.
//!
//! Two Windows details this exists to get right:
//!
//! * A child created from a GUI process will flash a console window unless
//!   `CREATE_NO_WINDOW` is set. Slice 1 already spawns children, so the flag
//!   belongs here from the start.
//! * `CreateProcess` cannot execute a `.cmd` or `.bat` directly. npm installs
//!   `claude` as `claude.cmd`, so the common case on this machine needs
//!   `cmd.exe /C`, with the whole command line wrapped in one pair of quotes,
//!   which is the form `cmd.exe` documents for paths containing spaces.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
pub enum ExecError {
    Spawn(String),
    TimedOut(Duration),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(message) => write!(f, "{message}"),
            Self::TimedOut(d) => write!(f, "no response within {}s", d.as_secs()),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Output {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

impl Output {
    /// Version output goes to stdout on some CLIs and stderr on others, so
    /// callers that are scanning for a number should look at both.
    #[must_use]
    pub fn combined(&self) -> String {
        if self.stderr.trim().is_empty() {
            self.stdout.clone()
        } else if self.stdout.trim().is_empty() {
            self.stderr.clone()
        } else {
            format!("{}\n{}", self.stdout, self.stderr)
        }
    }
}

/// Runs `exe args...`, capturing output, giving up after `timeout`.
///
/// On timeout the child is killed. This never inherits stdin, so a CLI that
/// decides to prompt gets EOF instead of hanging us forever.
pub fn run_capture(exe: &Path, args: &[&str], timeout: Duration) -> Result<Output, ExecError> {
    let mut command = build_command(exe, args);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|e| ExecError::Spawn(e.to_string()))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = mpsc::channel();

    let tx_out = tx.clone();
    thread::spawn(move || {
        let _ = tx_out.send((Stream::Out, drain(stdout)));
    });
    thread::spawn(move || {
        let _ = tx.send((Stream::Err, drain(stderr)));
    });

    let mut out = String::new();
    let mut err = String::new();
    let deadline = std::time::Instant::now() + timeout;

    for _ in 0..2 {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(remaining) {
            Ok((Stream::Out, text)) => out = text,
            Ok((Stream::Err, text)) => err = text,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ExecError::TimedOut(timeout));
            }
        }
    }

    // Both pipes are closed, so the child is finishing. Reap it for an exit
    // code rather than leaving a zombie handle behind.
    let exit_code = child.wait().ok().and_then(|s| s.code());

    Ok(Output {
        stdout: out,
        stderr: err,
        exit_code,
    })
}

enum Stream {
    Out,
    Err,
}

fn drain<R: Read>(reader: Option<R>) -> String {
    let Some(mut reader) = reader else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = reader.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Batch files need `cmd.exe`; everything else is spawned directly.
fn build_command(exe: &Path, args: &[&str]) -> Command {
    if is_batch(exe) {
        let mut command = Command::new("cmd.exe");
        #[cfg(windows)]
        {
            // `cmd /C "<everything>"` is the documented form that survives
            // spaces in the path. Building it raw keeps std from adding a
            // second layer of quoting that cmd.exe would then strip.
            command.arg("/C");
            let mut line = String::from("\"");
            line.push_str(&quote(&exe.to_string_lossy()));
            for arg in args {
                line.push(' ');
                line.push_str(&quote(arg));
            }
            line.push('"');
            command.raw_arg(line);
        }
        #[cfg(not(windows))]
        {
            command.arg("/C").arg(exe);
            command.args(args);
        }
        command
    } else {
        let mut command = Command::new(exe);
        command.args(args);
        command
    }
}

fn is_batch(exe: &Path) -> bool {
    exe.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|e| e == "cmd" || e == "bat")
}

fn quote(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_owned();
    }
    if value.contains([' ', '\t', '"', '&', '|', '^', '<', '>', '(', ')']) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::{is_batch, quote, run_capture};
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[test]
    fn recognises_batch_extensions() {
        assert!(is_batch(Path::new(r"C:\x\claude.cmd")));
        assert!(is_batch(Path::new(r"C:\x\claude.BAT")));
        assert!(!is_batch(Path::new(r"C:\x\codex.exe")));
        assert!(!is_batch(Path::new(r"C:\x\codex")));
    }

    #[test]
    fn quotes_only_when_needed() {
        assert_eq!(quote(r"C:\bin\x.cmd"), r"C:\bin\x.cmd");
        assert_eq!(
            quote(r"C:\Program Files\x.cmd"),
            "\"C:\\Program Files\\x.cmd\""
        );
        assert_eq!(quote("--version"), "--version");
    }

    #[test]
    fn missing_binary_is_a_spawn_error_not_a_panic() {
        let result = run_capture(
            &PathBuf::from(r"C:\definitely\not\here\nope.exe"),
            &["--version"],
            Duration::from_secs(5),
        );
        assert!(matches!(result, Err(super::ExecError::Spawn(_))));
    }

    #[cfg(windows)]
    #[test]
    fn captures_output_from_a_real_command() {
        let out = run_capture(
            Path::new("cmd.exe"),
            &["/C", "echo", "hello"],
            Duration::from_secs(10),
        )
        .expect("cmd.exe should run");
        assert!(out.combined().contains("hello"));
        assert_eq!(out.exit_code, Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn times_out_instead_of_hanging() {
        // `timeout` waits for input; with stdin null it still holds its pipes
        // open long enough for our deadline to fire.
        let result = run_capture(
            Path::new("cmd.exe"),
            &["/C", "ping", "-n", "30", "127.0.0.1"],
            Duration::from_millis(300),
        );
        assert!(matches!(result, Err(super::ExecError::TimedOut(_))));
    }
}
