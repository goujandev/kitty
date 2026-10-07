//! The session engine.
//!
//! One implementation of everything that is the same for every CLI: process
//! lifecycle, the turn queue, cancellation, and turning frames into events.
//! Harnesses contribute a codec and nothing else.
//!
//! This is the direct answer to ADR-0002's finding. `MonoCode` has seven
//! adapter files of roughly a thousand lines each, and every one of them
//! re-implements a turn-serialisation promise chain, the race where a turn
//! completes before the caller registered its resolver, a mute flag, and an
//! approval queue. Here that logic exists once and the codecs are a few
//! hundred lines apiece.
//!
//! Slice 2 covers streaming text. Approvals, questions and idle parking arrive
//! in slice 3 and belong in this file, not in a codec.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use pantheon_core::{ApprovalOutcome, ErrorKind, HarnessId, SessionEvent, StopReason};
use pantheon_harness::{codec_for, launch_args, Codec, StartContext};
pub use pantheon_harness::{ImageInput, TurnInput};
use pantheon_supervisor::{spawn, Child, ChildEvent, Frame, SpawnSpec};

/// How a session is started.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    /// Bound the wait for the CLI to acknowledge a requested turn.
    pub turn_start_timeout: Duration,
    pub approval_mode: ApprovalMode,
    pub harness: HarnessId,
    /// Resolved executable, from `pantheon_probe`.
    pub binary: PathBuf,
    pub cwd: PathBuf,
    /// Vendor session or thread id to continue, when we have one.
    pub resume: Option<String>,
    pub model: Option<String>,
    /// Reasoning effort, when the chosen model accepts one.
    pub effort: Option<String>,
}

impl SessionSpec {
    pub fn new(harness: HarnessId, binary: impl Into<PathBuf>, cwd: impl Into<PathBuf>) -> Self {
        Self {
            turn_start_timeout: Duration::from_secs(60),
            approval_mode: ApprovalMode::Ask,
            harness,
            binary: binary.into(),
            cwd: cwd.into(),
            resume: None,
            model: None,
            effort: None,
        }
    }
}

/// A running conversation with one CLI.
pub struct Session {
    commands: Sender<Command>,
    harness: HarnessId,
    alive: Arc<AtomicBool>,
}

enum Command {
    ApprovalMode(ApprovalMode),
    Turn(TurnInput),
    Approve { id: String, allow: bool },
    Cancel,
    Shutdown,
}

#[derive(Debug, Clone, Copy, Default)]
pub enum ApprovalMode {
    #[default]
    Ask,
    Edits,
    Auto,
}

impl ApprovalMode {
    #[must_use]
    pub fn approves(self, kind: pantheon_core::ApprovalKind) -> bool {
        matches!(self, Self::Auto)
            || matches!(
                (self, kind),
                (Self::Edits, pantheon_core::ApprovalKind::Edit)
            )
    }
}

#[cfg(test)]
mod approval_mode_tests {
    use super::ApprovalMode;
    use pantheon_core::ApprovalKind;

    #[test]
    fn modes_only_approve_the_requested_categories() {
        for kind in [
            ApprovalKind::Edit,
            ApprovalKind::Command,
            ApprovalKind::Network,
            ApprovalKind::Other,
        ] {
            assert!(!ApprovalMode::Ask.approves(kind));
            assert!(ApprovalMode::Auto.approves(kind));
            assert_eq!(
                ApprovalMode::Edits.approves(kind),
                kind == ApprovalKind::Edit
            );
        }
    }
}

/// Merged input to the pump, so it has one thing to wait on.
///
/// `std::sync::mpsc` has no select, and inventing one with polling would put a
/// latency floor under every delta. Forwarding both sources into one channel
/// keeps the pump a plain blocking loop.
enum Incoming {
    Child(ChildEvent),
    Command(Command),
}

impl Session {
    /// Starts the CLI and begins pumping it.
    ///
    /// The returned receiver carries every event for this session, in order.
    pub fn start(spec: &SessionSpec) -> Result<(Self, Receiver<SessionEvent>), StartError> {
        let mut args = launch_args(spec.harness);
        // Claude takes resume as a launch flag; Codex resumes inside its
        // protocol. The codec owns the second case, the manifest the first.
        if spec.harness == HarnessId::Claude {
            if let Some(resume) = &spec.resume {
                args.push("--resume".to_owned());
                args.push(resume.clone());
            }
            if let Some(model) = &spec.model {
                args.push("--model".to_owned());
                args.push(model.clone());
            }
            // Claude takes effort as a launch flag; Codex takes it per turn.
            if let Some(effort) = &spec.effort {
                args.push("--effort".to_owned());
                args.push(effort.clone());
            }
        }

        let mut child =
            spawn(&SpawnSpec::new(&spec.binary, &spec.cwd).args(args)).map_err(|e| StartError {
                message: e.to_string(),
            })?;

        let child_events = child.take_events().ok_or_else(|| StartError {
            message: "the supervisor gave us no event stream".to_owned(),
        })?;

        let (incoming_tx, incoming_rx) = mpsc::channel();
        let (events_tx, events_rx) = mpsc::channel();

        // Forwarder: child events into the merged channel.
        let forward = incoming_tx.clone();
        thread::spawn(move || {
            while let Ok(event) = child_events.recv() {
                if forward.send(Incoming::Child(event)).is_err() {
                    return;
                }
            }
        });

        let (commands_tx, commands_rx) = mpsc::channel::<Command>();
        thread::spawn(move || {
            while let Ok(command) = commands_rx.recv() {
                if incoming_tx.send(Incoming::Command(command)).is_err() {
                    return;
                }
            }
        });

        let codec = codec_for(spec.harness);
        let ctx = StartContext {
            cwd: spec.cwd.to_string_lossy().into_owned(),
            resume: spec.resume.clone(),
            model: spec.model.clone(),
            effort: spec.effort.clone(),
        };

        let approval_mode = spec.approval_mode;
        let turn_start_timeout = spec.turn_start_timeout;
        let alive = Arc::new(AtomicBool::new(true));
        let pump_alive = Arc::clone(&alive);
        thread::spawn(move || {
            Pump {
                approval_mode,
                child,
                codec,
                out: events_tx,
                busy: false,
                queued: Vec::new(),
                cancelling: false,
                pending: Vec::new(),
                awaiting_start: None,
                turn_start_timeout,
            }
            .run(&ctx, &incoming_rx);
            pump_alive.store(false, Ordering::Release);
        });

        Ok((
            Self {
                commands: commands_tx,
                harness: spec.harness,
                alive,
            },
            events_rx,
        ))
    }

    /// Whether the engine pump still owns a running process.
    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    #[must_use]
    pub fn harness(&self) -> HarnessId {
        self.harness
    }

    #[must_use]
    pub fn set_approval_mode(&self, mode: ApprovalMode) -> bool {
        self.commands.send(Command::ApprovalMode(mode)).is_ok()
    }

    /// Asks the model something. Queued if a turn is already running.
    ///
    /// Returns false once the session has shut down.
    #[must_use]
    pub fn send(&self, text: impl Into<String>) -> bool {
        self.send_input(TurnInput::text(text))
    }

    /// Asks the model something, with pictures. Queued like [`Self::send`].
    #[must_use]
    pub fn send_input(&self, input: TurnInput) -> bool {
        self.is_alive() && self.commands.send(Command::Turn(input)).is_ok()
    }

    /// Answers a permission request.
    ///
    /// Returns false once the session has shut down. Answering one that is
    /// already settled is harmless: the codec drops it.
    #[must_use]
    pub fn respond(&self, id: impl Into<String>, allow: bool) -> bool {
        self.commands
            .send(Command::Approve {
                id: id.into(),
                allow,
            })
            .is_ok()
    }

    /// Stops the running turn in-band, and drops anything queued behind it.
    ///
    /// Returns false once the session has shut down.
    #[must_use]
    pub fn cancel(&self) -> bool {
        self.commands.send(Command::Cancel).is_ok()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

#[derive(Debug)]
pub struct StartError {
    pub message: String,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for StartError {}

struct Pump {
    awaiting_start: Option<Instant>,
    turn_start_timeout: Duration,
    approval_mode: ApprovalMode,
    child: Child,
    codec: Box<dyn Codec>,
    out: Sender<SessionEvent>,
    /// A turn is in flight.
    busy: bool,
    /// Prompts waiting for the current turn to finish.
    queued: Vec<TurnInput>,
    /// A cancel was sent and we are waiting for the CLI to confirm.
    cancelling: bool,
    /// Permission requests the user has not answered yet.
    ///
    /// Tracked here rather than in a codec because every harness has them and
    /// the rules are the same: a cancel denies them, and a turn ending
    /// abandons them (ADR-0002).
    pending: Vec<(String, pantheon_core::ApprovalKind)>,
}

impl Pump {
    fn run(mut self, ctx: &StartContext, incoming: &Receiver<Incoming>) {
        let step = self.codec.start(ctx);
        self.dispatch(step);

        loop {
            // Diagnostics or status traffic must not postpone the deadline.
            if self.fail_unstarted_turn() {
                return;
            }
            let message = match incoming.recv_timeout(Duration::from_millis(100)) {
                Ok(message) => message,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    continue;
                }
            };
            match message {
                Incoming::Command(Command::ApprovalMode(mode)) => {
                    self.change_approval_mode(mode);
                }
                Incoming::Child(ChildEvent::Frames(frames)) => {
                    for frame in frames {
                        match frame {
                            Frame::Line(line) => {
                                let step = self.codec.on_frame(&line);
                                self.dispatch(step);
                            }
                            Frame::Oversized { bytes } => {
                                // Losing a frame silently is how a session goes
                                // mysteriously wrong. Say so.
                                self.emit(SessionEvent::Error {
                                    error_kind: ErrorKind::Protocol,
                                    message: format!(
                                        "dropped an oversized {bytes}-byte frame from the CLI"
                                    ),
                                    retryable: false,
                                });
                            }
                        }
                    }
                }

                Incoming::Child(ChildEvent::Stderr(_)) => {
                    // Diagnostics, not protocol. Slice 3 routes these into the
                    // raw log viewer rather than the transcript.
                }

                Incoming::Child(ChildEvent::ReadFailed { message }) => {
                    self.emit(SessionEvent::Error {
                        error_kind: ErrorKind::Process,
                        message: format!("lost the CLI's output stream: {message}"),
                        retryable: true,
                    });
                }

                Incoming::Child(ChildEvent::Exited { code }) => {
                    self.on_exit(code);
                    return;
                }

                Incoming::Command(Command::Turn(input)) => {
                    if self.busy {
                        self.queued.push(input);
                    } else {
                        self.begin(&input);
                    }
                }

                Incoming::Command(Command::Approve { id, allow }) => {
                    let step = self.codec.respond_approval(&id, allow);
                    self.dispatch(step);
                    self.settle(
                        &id,
                        if allow {
                            ApprovalOutcome::Allowed
                        } else {
                            ApprovalOutcome::Denied
                        },
                    );
                }

                Incoming::Command(Command::Cancel) => {
                    // Drop anything queued first, so a cancel cannot be
                    // followed by a prompt the user thought they had stopped.
                    self.queued.clear();
                    // Anything waiting on the user is denied, because leaving
                    // a request unanswered would hold the CLI open forever.
                    for (id, _) in std::mem::take(&mut self.pending) {
                        let step = self.codec.respond_approval(&id, false);
                        self.dispatch(step);
                        self.emit(SessionEvent::ApprovalResolved {
                            id,
                            outcome: ApprovalOutcome::Denied,
                        });
                    }
                    if self.busy && !self.cancelling {
                        self.cancelling = true;
                        let step = self.codec.cancel();
                        self.dispatch(step);
                    }
                }

                Incoming::Command(Command::Shutdown) => {
                    // Every begun turn ends exactly once, so the window never keeps a
                    // spinner for a turn whose process is gone.
                    if self.busy {
                        self.emit(SessionEvent::TurnEnded {
                            stop: StopReason::Interrupted,
                        });
                        self.busy = false;
                    }
                    self.child.kill();
                    return;
                }
            }
        }
    }

    fn change_approval_mode(&mut self, mode: ApprovalMode) {
        self.approval_mode = mode;
        let approved: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, kind)| mode.approves(*kind))
            .map(|(id, _)| id.clone())
            .collect();
        for id in approved {
            let reply = self.codec.respond_approval(&id, true);
            self.dispatch(reply);
            self.settle(&id, ApprovalOutcome::Allowed);
        }
    }

    fn fail_unstarted_turn(&mut self) -> bool {
        if self
            .awaiting_start
            .is_none_or(|start| start.elapsed() < self.turn_start_timeout)
        {
            return false;
        }
        let message = "The agent did not start the requested turn within the startup limit. Its process was stopped; retry explicitly to continue.".to_owned();
        self.emit(SessionEvent::Error {
            error_kind: ErrorKind::Process,
            message: message.clone(),
            retryable: true,
        });
        self.emit(SessionEvent::TurnEnded {
            stop: StopReason::Failed { message },
        });
        self.child.kill();
        true
    }

    fn begin(&mut self, input: &TurnInput) {
        self.busy = true;
        self.awaiting_start = Some(Instant::now());
        self.cancelling = false;
        let step = self.codec.send_turn_input(input);
        self.dispatch(step);
    }

    /// Sends a codec's frames to the child and its events to the consumer.
    ///
    /// Turn bookkeeping lives here, in one place, which is the whole reason
    /// the codecs do not have to agree on how to do it.
    fn dispatch(&mut self, step: pantheon_harness::Step) {
        for line in step.send {
            if !self.child.write_line(line) {
                self.emit(SessionEvent::Error {
                    error_kind: ErrorKind::Process,
                    message: "the CLI stopped accepting input".to_owned(),
                    retryable: false,
                });
                break;
            }
        }

        for event in step.events {
            // A CLI can start a turn without being asked: Claude Code resumes
            // when a background task reports back, Codex when a sub-agent
            // delivers its result. That is still the agent working, so it
            // owns the turn like any other, and Stop and queueing apply to it.
            if matches!(event, SessionEvent::TurnStarted) && !self.busy {
                self.busy = true;
                self.cancelling = false;
            }
            if matches!(
                &event,
                SessionEvent::TurnStarted
                    | SessionEvent::MessageDelta { .. }
                    | SessionEvent::ReasoningDelta { .. }
                    | SessionEvent::ToolStarted { .. }
                    | SessionEvent::ApprovalRequested { .. }
            ) {
                self.awaiting_start = None;
            }
            if let SessionEvent::ApprovalRequested {
                id, approval_kind, ..
            } = &event
            {
                if self.approval_mode.approves(*approval_kind) {
                    let reply = self.codec.respond_approval(id, true);
                    self.dispatch(reply);
                    self.emit(SessionEvent::ApprovalResolved {
                        id: id.clone(),
                        outcome: ApprovalOutcome::Allowed,
                    });
                    continue;
                }
            }
            // Approval bookkeeping happens here so a codec never has to track
            // what is outstanding.
            match &event {
                SessionEvent::ApprovalRequested {
                    id, approval_kind, ..
                } => {
                    if !self.pending.iter().any(|(pending_id, _)| pending_id == id) {
                        self.pending.push((id.clone(), *approval_kind));
                    }
                }
                SessionEvent::ApprovalResolved { id, .. } => {
                    self.pending.retain(|(pending_id, _)| pending_id != id);
                }
                _ => {}
            }

            let ends_turn = matches!(event, SessionEvent::TurnEnded { .. });
            self.emit(event);
            if ends_turn {
                self.finish_turn();
            }
        }
    }

    /// Records that a request is settled and tells the consumer.
    fn settle(&mut self, id: &str, outcome: ApprovalOutcome) {
        if let Some(at) = self
            .pending
            .iter()
            .position(|(pending_id, _)| pending_id == id)
        {
            self.pending.remove(at);
            self.emit(SessionEvent::ApprovalResolved {
                id: id.to_owned(),
                outcome,
            });
        }
    }

    fn finish_turn(&mut self) {
        self.busy = false;
        self.awaiting_start = None;
        self.cancelling = false;
        // A turn cannot end with a question still on screen.
        for (id, _) in std::mem::take(&mut self.pending) {
            self.emit(SessionEvent::ApprovalResolved {
                id,
                outcome: ApprovalOutcome::Cancelled,
            });
        }
        if !self.queued.is_empty() {
            let next = self.queued.remove(0);
            self.begin(&next);
        }
    }

    fn on_exit(&mut self, code: Option<i32>) {
        if self.busy {
            // The stream ended without a terminal signal. Keep what arrived
            // and say plainly that it was cut short.
            self.emit(SessionEvent::TurnEnded {
                stop: StopReason::Interrupted,
            });
            self.busy = false;
        }
        if !matches!(code, Some(0) | None) {
            self.emit(SessionEvent::Error {
                error_kind: ErrorKind::Process,
                message: format!("the CLI exited with code {}", code.unwrap_or(-1)),
                retryable: true,
            });
        }
    }

    fn emit(&self, event: SessionEvent) {
        // A closed receiver means the consumer went away. The session is about
        // to be dropped; nothing useful to do here.
        let _ = self.out.send(event);
    }
}
