//! End-to-end proof that a reply streams in.
//!
//! ```text
//! cargo run -p kitty-engine --example chat -- claude "Say hello in three words."
//! cargo run -p kitty-engine --example chat -- codex  "Say hello in three words."
//! ```
//!
//! Finds the CLI, starts a session, sends one turn, and prints the reply as it
//! arrives. This is the headless version of slice 2's screen, and the same
//! path the UI will take: supervisor, codec, engine, events.

use std::io::Write;
use std::time::{Duration, Instant};

use kitty_core::{HarnessId, InstallState, SessionEvent};
use kitty_engine::{Session, SessionSpec};

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    let harness = match args.next().as_deref() {
        Some("claude") => HarnessId::Claude,
        Some("codex") => HarnessId::Codex,
        other => {
            eprintln!(
                "usage: chat <claude|codex> [prompt]   (got {})",
                other.unwrap_or("nothing")
            );
            return std::process::ExitCode::from(2);
        }
    };
    let prompt = args
        .next()
        .unwrap_or_else(|| "Say hello in exactly three words.".to_owned());

    let env = kitty_probe::EnvSnapshot::capture();
    let status = kitty_probe::probe_one(harness, &env);
    let InstallState::Found { path, version } = &status.install else {
        eprintln!("{} is not usable: {:?}", status.label, status.install);
        if let Some(hint) = &status.hint {
            eprintln!("  {}", hint.message);
            if let Some(command) = &hint.command {
                eprintln!("  $ {command}");
            }
        }
        return std::process::ExitCode::FAILURE;
    };
    eprintln!("{} {version} at {path}", status.label);

    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let spec = SessionSpec::new(harness, path, cwd);

    let started = Instant::now();
    let (session, events) = match Session::start(&spec) {
        Ok(pair) => pair,
        Err(e) => {
            eprintln!("could not start a session: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    eprintln!("> {prompt}\n");
    if !session.send(prompt) {
        eprintln!("the session closed before the prompt could be sent");
        return std::process::ExitCode::FAILURE;
    }

    stream_turn(&session, &events, started)
}

/// Prints one turn as it arrives. Returns non-zero if anything went wrong.
fn stream_turn(
    session: &Session,
    events: &std::sync::mpsc::Receiver<SessionEvent>,
    started: Instant,
) -> std::process::ExitCode {
    let mut first_token: Option<Duration> = None;
    let mut streamed = String::new();
    let mut reasoning = false;
    let deadline = Instant::now() + Duration::from_secs(180);
    let mut exit = std::process::ExitCode::SUCCESS;

    while Instant::now() < deadline {
        let Ok(event) = events.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };

        match event {
            SessionEvent::Started {
                provider_session,
                model,
            } => {
                eprintln!(
                    "session {} on {}",
                    provider_session.as_deref().unwrap_or("?"),
                    model.as_deref().unwrap_or("?")
                );
            }

            SessionEvent::MessageDelta { text } => {
                if reasoning {
                    eprintln!();
                    reasoning = false;
                }
                first_token.get_or_insert_with(|| started.elapsed());
                streamed.push_str(&text);
                print!("{text}");
                // Flushing per delta is the point: this should look like
                // typing, not like a wall of text arriving at the end.
                let _ = std::io::stdout().flush();
            }

            SessionEvent::ReasoningDelta { text } => {
                if !reasoning {
                    eprint!("(thinking) ");
                    reasoning = true;
                }
                eprint!("{text}");
            }

            SessionEvent::MessageDone { text } => {
                // A turn can contain several messages, so the comparison is
                // per message and the buffer resets after each one.
                let spoken = std::mem::take(&mut streamed);
                if text != spoken {
                    // The snapshot is authoritative. Any disagreement is a
                    // codec bug and should be loud, not silently corrected.
                    eprintln!("\n\n!! stream and final snapshot disagree");
                    eprintln!("   streamed: {spoken:?}");
                    eprintln!("   snapshot: {text:?}");
                    exit = std::process::ExitCode::FAILURE;
                }
            }

            SessionEvent::Usage(usage) => print_usage(&usage),
            SessionEvent::Context { used, window } => print_context(used, window),
            SessionEvent::RateLimits { windows } => print_limits(&windows),

            SessionEvent::Error {
                error_kind,
                message,
                ..
            } => {
                eprintln!("\n\nerror ({error_kind:?}): {message}");
                exit = std::process::ExitCode::FAILURE;
            }

            SessionEvent::TurnEnded { stop } => {
                eprintln!("\nstopped: {stop:?}");
                if let Some(ttft) = first_token {
                    eprintln!("first token after {ttft:?}, total {:?}", started.elapsed());
                }
                return exit;
            }

            SessionEvent::ToolStarted { title, .. } => {
                eprintln!("\n  ▸ {title}");
            }

            SessionEvent::ToolEnded { status, detail, .. } => {
                let mark = match status {
                    kitty_core::ToolStatus::Ok => "done",
                    kitty_core::ToolStatus::Failed => "failed",
                    kitty_core::ToolStatus::Denied => "denied",
                    kitty_core::ToolStatus::Running => "running",
                };
                eprintln!(
                    "    {mark}{}",
                    detail.map_or(String::new(), |d| format!(": {d}"))
                );
            }

            SessionEvent::ApprovalRequested { id, title, .. } => {
                // A headless run has nobody to ask, so it approves and says so
                // rather than hanging on a prompt with no screen.
                eprintln!("\n  ? {title}  (auto-approving)");
                let _ = session.respond(id, true);
            }

            SessionEvent::ApprovalResolved { .. }
            | SessionEvent::TurnStarted
            | SessionEvent::ReasoningDone
            | SessionEvent::Status { .. } => {}
        }
    }

    eprintln!("\ntimed out waiting for the turn to finish");
    std::process::ExitCode::FAILURE
}

fn print_usage(usage: &kitty_core::Usage) {
    eprintln!(
        "\n\ntokens  in {} out {} cache-read {}",
        usage.input_tokens, usage.output_tokens, usage.cache_read_tokens
    );
}

fn print_context(used: Option<u64>, window: Option<u64>) {
    if let (Some(used), Some(window)) = (used, window) {
        eprintln!("context {used} / {window}");
    }
}

fn print_limits(windows: &[kitty_core::RateLimitWindow]) {
    for w in windows {
        eprintln!("limit   {} at {:.0}%", w.label, w.utilization * 100.0);
    }
}
