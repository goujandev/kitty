//! Spawning and supervising an agent CLI.
//!
//! One child, contained in a job object, with its stdout framed into protocol
//! lines and delivered as batches. Writes are handed to a dedicated thread so
//! a caller is never blocked by a child that has stopped draining its stdin.
//!
//! This layer knows nothing about protocols. It moves bytes and manages a
//! process lifetime; the codecs above turn frames into events.

pub mod frames;
pub mod job;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub use frames::{Batch, Frame, FrameReader};
use job::Job;

/// <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Marks our children so a future launch can sweep up anything a hard kill
/// left behind. `MonoCode` uses the same trick and it is worth keeping even
/// with job objects, because a job cannot outlive a process that was killed
/// before it could create one.
pub const PARENT_MARKER: &str = "KITTY_SUPERVISOR_PARENT";

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Extra environment on top of the inherited one.
    pub env: Vec<(String, String)>,
}

impl SpawnSpec {
    pub fn new(program: impl Into<PathBuf>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            cwd: cwd.into(),
            env: Vec::new(),
        }
    }

    #[must_use]
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }
}

/// Everything the supervisor reports about a running child.
#[derive(Debug)]
pub enum ChildEvent {
    /// Protocol frames from stdout, batched as they arrived.
    Frames(Vec<Frame>),
    /// A line from stderr. Diagnostics, never protocol.
    Stderr(String),
    /// The stdout pipe failed. The child may still be alive.
    ReadFailed { message: String },
    /// The child is gone. Always the last event.
    Exited { code: Option<i32> },
}

/// A running agent CLI.
///
/// Dropping this kills the child and everything it spawned, because the job
/// handle closes.
pub struct Child {
    job: Arc<Job>,
    writes: Option<Sender<WriteOp>>,
    events: Option<Receiver<ChildEvent>>,
    pid: u32,
}

enum WriteOp {
    Line(String),
    Close,
}

impl Child {
    /// The child's process id, for diagnostics.
    #[must_use]
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Takes the event stream. Callable once; later calls return `None`.
    pub fn take_events(&mut self) -> Option<Receiver<ChildEvent>> {
        self.events.take()
    }

    /// Queues a protocol line. Returns `false` once the child is gone.
    ///
    /// Never blocks on the child: the line goes to a writer thread. A child
    /// that stops reading its stdin cannot stall the caller, which is the
    /// failure `MonoCode` has by doing a blocking write on an IPC worker.
    pub fn write_line(&self, line: impl Into<String>) -> bool {
        self.writes
            .as_ref()
            .is_some_and(|tx| tx.send(WriteOp::Line(line.into())).is_ok())
    }

    /// Closes the child's stdin, which is how a CLI is told the input is done.
    pub fn close_stdin(&mut self) {
        if let Some(tx) = &self.writes {
            let _ = tx.send(WriteOp::Close);
        }
        self.writes = None;
    }

    /// Kills the child and its whole tree.
    pub fn kill(&self) {
        self.job.terminate();
    }
}

impl Drop for Child {
    fn drop(&mut self) {
        // Dropping the sender lets the writer thread finish; dropping the job
        // kills the tree. Both happen automatically, this is only explicit so
        // the ordering is obvious to a reader.
        self.writes = None;
        self.job.terminate();
    }
}

#[derive(Debug)]
pub enum SpawnError {
    Spawn { message: String },
    Job { message: String },
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn { message } | Self::Job { message } => f.write_str(message),
        }
    }
}

impl std::error::Error for SpawnError {}

/// Starts a child, contains it in a job, and begins pumping its pipes.
pub fn spawn(spec: &SpawnSpec) -> Result<Child, SpawnError> {
    // A batch file is launched through `cmd.exe`, which exists whether or not
    // the script does. Without this check a missing CLI looks like a child
    // that started and immediately died, which is a far worse error message.
    if spec
        .program
        .parent()
        .is_some_and(|p| !p.as_os_str().is_empty())
        && !spec.program.is_file()
    {
        return Err(SpawnError::Spawn {
            message: format!("{} does not exist", spec.program.display()),
        });
    }

    let job = Job::new().map_err(|e| SpawnError::Job {
        message: format!("could not create a job object: {e}"),
    })?;

    let mut command = build_command(&spec.program, &spec.args);
    command
        .current_dir(&spec.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env(PARENT_MARKER, std::process::id().to_string());

    for (key, value) in &spec.env {
        command.env(key, value);
    }

    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);

    let mut child = command.spawn().map_err(|e| SpawnError::Spawn {
        message: format!("could not start {}: {e}", spec.program.display()),
    })?;

    // Immediately, so the window where a descendant could escape is as small
    // as we can make it without a hand-rolled CreateProcessW. See job.rs.
    if let Err(e) = job.assign(&child) {
        let _ = child.kill();
        return Err(SpawnError::Job {
            message: format!("could not contain the child in a job: {e}"),
        });
    }

    let pid = child.id();
    let job = Arc::new(job);
    let (events_tx, events_rx) = mpsc::channel();
    let (writes_tx, writes_rx) = mpsc::channel::<WriteOp>();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();

    if let Some(stdout) = stdout {
        let tx = events_tx.clone();
        std::thread::spawn(move || pump_frames(stdout, &tx));
    }

    if let Some(stderr) = stderr {
        let tx = events_tx.clone();
        std::thread::spawn(move || pump_stderr(stderr, &tx));
    }

    std::thread::spawn(move || {
        let mut stdin = stdin;
        while let Ok(op) = writes_rx.recv() {
            match op {
                WriteOp::Line(line) => {
                    let Some(handle) = stdin.as_mut() else { break };
                    if handle.write_all(line.as_bytes()).is_err()
                        || handle.write_all(b"\n").is_err()
                        || handle.flush().is_err()
                    {
                        // The child stopped reading. Not an error worth
                        // surfacing on its own; the exit event will follow.
                        break;
                    }
                }
                WriteOp::Close => break,
            }
        }
        drop(stdin);
    });

    // Reaping thread. Owns the child handle so the exit code is available and
    // no zombie handle is left behind.
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|status| status.code());
        let _ = events_tx.send(ChildEvent::Exited { code });
    });

    Ok(Child {
        job,
        writes: Some(writes_tx),
        events: Some(events_rx),
        pid,
    })
}

fn pump_frames(stdout: std::process::ChildStdout, tx: &Sender<ChildEvent>) {
    let mut reader = FrameReader::new(stdout);
    loop {
        match reader.next_batch() {
            Batch::Frames(frames) => {
                if frames.is_empty() {
                    continue;
                }
                if tx.send(ChildEvent::Frames(frames)).is_err() {
                    return;
                }
            }
            Batch::Eof { trailing } => {
                if let Some(frame) = trailing {
                    let _ = tx.send(ChildEvent::Frames(vec![frame]));
                }
                return;
            }
            Batch::Failed { message } => {
                let _ = tx.send(ChildEvent::ReadFailed { message });
                return;
            }
        }
    }
}

fn pump_stderr(stderr: std::process::ChildStderr, tx: &Sender<ChildEvent>) {
    let mut reader = FrameReader::new(stderr);
    loop {
        match reader.next_batch() {
            Batch::Frames(frames) => {
                for frame in frames {
                    if let Frame::Line(text) = frame {
                        if tx.send(ChildEvent::Stderr(text)).is_err() {
                            return;
                        }
                    }
                }
            }
            Batch::Eof { trailing } => {
                if let Some(Frame::Line(text)) = trailing {
                    let _ = tx.send(ChildEvent::Stderr(text));
                }
                return;
            }
            Batch::Failed { .. } => return,
        }
    }
}

/// Batch files need `cmd.exe`; everything else is spawned directly.
///
/// `claude` is an npm shim, so this is the common path on Windows, not an edge
/// case. `CreateProcess` cannot execute a `.cmd`.
fn build_command(program: &Path, args: &[String]) -> Command {
    if is_batch(program) {
        let mut command = Command::new("cmd.exe");
        #[cfg(windows)]
        {
            command.arg("/C");
            // `cmd /C "<everything>"` is the documented form that survives a
            // path containing spaces. Building it raw keeps std from adding a
            // second layer of quoting that cmd.exe would then strip.
            let mut line = String::from("\"");
            line.push_str(&quote(&program.to_string_lossy()));
            for arg in args {
                line.push(' ');
                line.push_str(&quote(arg));
            }
            line.push('"');
            command.raw_arg(line);
        }
        #[cfg(not(windows))]
        {
            command.arg("/C").arg(program).args(args);
        }
        command
    } else {
        let mut command = Command::new(program);
        command.args(args);
        command
    }
}

fn is_batch(program: &Path) -> bool {
    program
        .extension()
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
    use super::{spawn, ChildEvent, Frame, SpawnSpec};
    use std::time::{Duration, Instant};

    fn collect_until_exit(child: &mut super::Child, limit: Duration) -> (Vec<String>, Vec<String>) {
        let events = child.take_events().expect("events");
        let deadline = Instant::now() + limit;
        let (mut lines, mut errs) = (Vec::new(), Vec::new());
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(250)) {
                Ok(ChildEvent::Frames(frames)) => {
                    for frame in frames {
                        if let Frame::Line(text) = frame {
                            lines.push(text);
                        }
                    }
                }
                Ok(ChildEvent::Stderr(text)) => errs.push(text),
                Ok(ChildEvent::ReadFailed { message }) => panic!("read failed: {message}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Ok(ChildEvent::Exited { .. })
                | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        (lines, errs)
    }

    #[test]
    fn captures_stdout_lines() {
        let spec =
            SpawnSpec::new("cmd.exe", std::env::temp_dir()).args(["/C", "echo one& echo two"]);
        let mut child = spawn(&spec).expect("spawn");
        let (lines, _) = collect_until_exit(&mut child, Duration::from_secs(20));
        assert_eq!(lines, vec!["one".to_owned(), "two".to_owned()]);
    }

    #[test]
    fn reports_exit() {
        let spec = SpawnSpec::new("cmd.exe", std::env::temp_dir()).args(["/C", "exit 3"]);
        let mut child = spawn(&spec).expect("spawn");
        let events = child.take_events().expect("events");
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Ok(ChildEvent::Exited { code }) = events.recv_timeout(Duration::from_millis(250))
            {
                assert_eq!(code, Some(3));
                return;
            }
        }
        panic!("never saw an exit event");
    }

    #[test]
    fn separates_stderr_from_protocol_frames() {
        // The redirect goes first: `echo err 1>&2` makes cmd.exe emit a
        // trailing space, which the reader faithfully preserves. Whitespace is
        // content, so the fixture is written to not introduce any.
        let spec =
            SpawnSpec::new("cmd.exe", std::env::temp_dir()).args(["/C", "echo out& 1>&2 echo err"]);
        let mut child = spawn(&spec).expect("spawn");
        let (lines, errs) = collect_until_exit(&mut child, Duration::from_secs(20));
        assert_eq!(lines, vec!["out".to_owned()]);
        assert_eq!(errs, vec!["err".to_owned()]);
    }

    #[test]
    fn a_missing_binary_is_an_error_not_a_panic() {
        let spec = SpawnSpec::new(r"C:\nope\nothing-here.exe", std::env::temp_dir());
        assert!(spawn(&spec).is_err());
    }

    #[test]
    fn writes_reach_the_child() {
        // `findstr` echoes matching stdin lines, so this proves the write path
        // end to end without needing a real CLI.
        let spec = SpawnSpec::new("cmd.exe", std::env::temp_dir()).args(["/C", "findstr", "kitty"]);
        let mut child = spawn(&spec).expect("spawn");
        assert!(child.write_line("hello kitty"));
        assert!(child.write_line("unrelated"));
        child.close_stdin();

        let (lines, _) = collect_until_exit(&mut child, Duration::from_secs(20));
        assert_eq!(lines, vec!["hello kitty".to_owned()]);
    }

    #[test]
    fn dropping_the_child_kills_the_tree() {
        let spec = SpawnSpec::new("cmd.exe", std::env::temp_dir())
            .args(["/C", "ping -n 60 127.0.0.1 > nul"]);
        let child = spawn(&spec).expect("spawn");
        let pid = child.pid();
        drop(child);

        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if !pid_is_running(pid) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("pid {pid} survived dropping its supervisor");
    }

    fn pid_is_running(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output();
        match out {
            Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()),
            Err(_) => false,
        }
    }
}
