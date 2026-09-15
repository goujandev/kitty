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
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use kitty_core::{ApprovalOutcome, ErrorKind, HarnessId, SessionEvent, StopReason};
use kitty_harness::{codec_for, launch_args, Codec, StartContext};
use kitty_supervisor::{spawn, Child, ChildEvent, Frame, SpawnSpec};

/// How a session is started.
#[derive(Debug, Clone)]
pub struct SessionSpec {
    pub harness: HarnessId,
    /// Resolved executable, from `kitty_probe`.
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
}

enum Command {
    Turn(String),
    Approve { id: String, allow: bool },
    Cancel,
    Shutdown,
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

        thread::spawn(move || {
            Pump {
                child,
                codec,
                out: events_tx,
                busy: false,
                queued: Vec::new(),
                cancelling: false,
                pending: Vec::new(),
            }
            .run(&ctx, &incoming_rx);
        });

        Ok((
            Self {
                commands: commands_tx,
                harness: spec.harness,
            },
            events_rx,
        ))
    }

    #[must_use]
    pub fn harness(&self) -> HarnessId {
        self.harness
    }

    /// Asks the model something. Queued if a turn is already running.
    ///
    /// Returns false once the session has shut down.
    #[must_use]
    pub fn send(&self, text: impl Into<String>) -> bool {
        self.commands.send(Command::Turn(text.into())).is_ok()
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
    child: Child,
    codec: Box<dyn Codec>,
    out: Sender<SessionEvent>,
    /// A turn is in flight.
    busy: bool,
    /// Prompts waiting for the current turn to finish.
    queued: Vec<String>,
    /// A cancel was sent and we are waiting for the CLI to confirm.
    cancelling: bool,
    /// Permission requests the user has not answered yet.
    ///
    /// Tracked here rather than in a codec because every harness has them and
    /// the rules are the same: a cancel denies them, and a turn ending
    /// abandons them (ADR-0002).
    pending: Vec<String>,
}

impl Pump {
    fn run(mut self, ctx: &StartContext, incoming: &Receiver<Incoming>) {
        let step = self.codec.start(ctx);
        self.dispatch(step);

        while let Ok(message) = incoming.recv() {
            match message {
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

                Incoming::Command(Command::Turn(text)) => {
                    if self.busy {
                        self.queued.push(text);
                    } else {
                        self.begin(&text);
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
                    for id in std::mem::take(&mut self.pending) {
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
                    self.child.kill();
                    return;
                }
            }
        }
    }

    fn begin(&mut self, text: &str) {
        self.busy = true;
        self.cancelling = false;
        let step = self.codec.send_turn(text);
        self.dispatch(step);
    }

    /// Sends a codec's frames to the child and its events to the consumer.
    ///
    /// Turn bookkeeping lives here, in one place, which is the whole reason
    /// the codecs do not have to agree on how to do it.
    fn dispatch(&mut self, step: kitty_harness::Step) {
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
            // Approval bookkeeping happens here so a codec never has to track
            // what is outstanding.
            match &event {
                SessionEvent::ApprovalRequested { id, .. } => {
                    if !self.pending.contains(id) {
                        self.pending.push(id.clone());
                    }
                }
                SessionEvent::ApprovalResolved { id, .. } => {
                    self.pending.retain(|p| p != id);
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
        if let Some(at) = self.pending.iter().position(|p| p == id) {
            self.pending.remove(at);
            self.emit(SessionEvent::ApprovalResolved {
                id: id.to_owned(),
                outcome,
            });
        }
    }

    fn finish_turn(&mut self) {
        self.busy = false;
        self.cancelling = false;
        // A turn cannot end with a question still on screen.
        for id in std::mem::take(&mut self.pending) {
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
