//! Claude Code's `stream-json` protocol.
//!
//! Newline-delimited JSON both ways. Recorded from 2.1.270 on 2026-09-15; the
//! recording is `fixtures/claude/hello.jsonl`.
//!
//! Shape of a turn, as observed:
//!
//! ```text
//! system/init                       session_id, model, cwd
//! stream_event/message_start        usage so far
//! stream_event/content_block_start  block 0, type "text"
//! stream_event/content_block_delta  {"type":"text_delta","text":"Hello there"}
//! stream_event/content_block_delta  {"type":"text_delta","text":", friend"}
//! stream_event/content_block_stop
//! assistant                         the whole message, authoritative
//! stream_event/message_delta        stop_reason + final usage
//! stream_event/message_stop
//! result                            stop_reason, usage, cost
//! rate_limit_event                  five_hour / seven_day utilisation
//! ```
//!
//! Claude hands us `rate_limit_event` unprompted, which is why kitty never has
//! to touch a credential file to show usage (ADR-0004).

use kitty_core::{ErrorKind, RateLimitWindow, SessionEvent, StopReason, Usage};
use serde_json::{json, Value};

use crate::{str_field, u64_field, Codec, StartContext, Step};

/// Argv after the resolved binary.
///
/// `--print` is required: the streaming formats only apply in print mode.
/// `--include-partial-messages` is what turns a single final answer into the
/// `content_block_delta` stream we want.
#[must_use]
pub fn launch_args() -> Vec<String> {
    [
        "--print",
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

#[derive(Default)]
pub struct ClaudeCodec {
    /// Content-block indices currently carrying thinking rather than text.
    thinking_blocks: Vec<usize>,
    /// Incrementing id for control requests such as interrupt.
    next_control: u64,
    started: bool,
}

impl ClaudeCodec {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl Codec for ClaudeCodec {
    fn start(&mut self, _ctx: &StartContext) -> Step {
        // Nothing to send. Claude Code announces itself with `system/init` as
        // soon as it is up, and resume is a launch flag rather than a frame.
        Step::none()
    }

    fn send_turn(&mut self, text: &str) -> Step {
        Step::send(
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": text }],
                },
            })
            .to_string(),
        )
    }

    fn cancel(&mut self) -> Step {
        self.next_control += 1;
        Step::send(
            json!({
                "type": "control_request",
                "request_id": format!("kitty-{}", self.next_control),
                "request": { "subtype": "interrupt" },
            })
            .to_string(),
        )
    }

    fn on_frame(&mut self, line: &str) -> Step {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            // Not JSON. Claude prints the occasional plain notice; it is not
            // our business and it must not be fatal.
            return Step::none();
        };

        match str_field(&msg, "type") {
            Some("system") => self.on_system(&msg),
            Some("stream_event") => self.on_stream_event(&msg),
            Some("assistant") => on_assistant(&msg),
            Some("result") => on_result(&msg),
            Some("rate_limit_event") => on_rate_limit(&msg),
            _ => Step::none(),
        }
    }
}

impl ClaudeCodec {
    fn on_system(&mut self, msg: &Value) -> Step {
        match str_field(msg, "subtype") {
            Some("init") if !self.started => {
                self.started = true;
                Step::event(SessionEvent::Started {
                    provider_session: str_field(msg, "session_id").map(str::to_owned),
                    model: str_field(msg, "model").map(str::to_owned),
                })
            }
            Some("status") => str_field(msg, "status").map_or_else(Step::none, |text| {
                Step::event(SessionEvent::Status {
                    text: text.to_owned(),
                })
            }),
            _ => Step::none(),
        }
    }

    fn on_stream_event(&mut self, msg: &Value) -> Step {
        let Some(event) = msg.get("event") else {
            return Step::none();
        };

        match str_field(event, "type") {
            Some("message_start") => Step::event(SessionEvent::TurnStarted),

            Some("content_block_start") => {
                let index = usize::try_from(u64_field(event, "index").unwrap_or(0)).unwrap_or(0);
                let is_thinking = event
                    .get("content_block")
                    .and_then(|b| str_field(b, "type"))
                    .is_some_and(|t| t == "thinking" || t == "redacted_thinking");
                if is_thinking && !self.thinking_blocks.contains(&index) {
                    self.thinking_blocks.push(index);
                }
                Step::none()
            }

            Some("content_block_delta") => {
                let Some(delta) = event.get("delta") else {
                    return Step::none();
                };
                match str_field(delta, "type") {
                    // Whitespace is content, so an empty-looking chunk is still
                    // passed through untouched.
                    Some("text_delta") => str_field(delta, "text").map_or_else(Step::none, |t| {
                        Step::event(SessionEvent::MessageDelta { text: t.to_owned() })
                    }),
                    Some("thinking_delta") => str_field(delta, "thinking")
                        .map_or_else(Step::none, |t| {
                            Step::event(SessionEvent::ReasoningDelta { text: t.to_owned() })
                        }),
                    _ => Step::none(),
                }
            }

            Some("content_block_stop") => {
                let index = usize::try_from(u64_field(event, "index").unwrap_or(0)).unwrap_or(0);
                if let Some(at) = self.thinking_blocks.iter().position(|&i| i == index) {
                    self.thinking_blocks.swap_remove(at);
                    return Step::event(SessionEvent::ReasoningDone);
                }
                Step::none()
            }

            // `message_delta` carries the final usage, but `result` repeats it
            // with the authoritative totals, so there is nothing to do here.
            _ => Step::none(),
        }
    }
}

/// The complete assistant message. Authoritative over what we streamed.
fn on_assistant(msg: &Value) -> Step {
    let Some(content) = msg.get("message").and_then(|m| m.get("content")) else {
        return Step::none();
    };
    let Some(blocks) = content.as_array() else {
        return Step::none();
    };

    let text: String = blocks
        .iter()
        .filter(|b| str_field(b, "type") == Some("text"))
        .filter_map(|b| str_field(b, "text"))
        .collect();

    if text.is_empty() {
        // A tool-only message. Slice 3 gives these a home; for now there is
        // nothing to say about them.
        return Step::none();
    }
    Step::event(SessionEvent::MessageDone { text })
}

fn on_result(msg: &Value) -> Step {
    let mut out = Step::none();

    if let Some(usage) = msg.get("usage") {
        out.events.push(SessionEvent::Usage(usage_from(usage)));
    }

    let reason = if msg.get("is_error").and_then(Value::as_bool) == Some(true) {
        StopReason::Failed {
            message: str_field(msg, "result")
                .or_else(|| str_field(msg, "subtype"))
                .unwrap_or("the CLI reported an error")
                .to_owned(),
        }
    } else {
        stop_reason_from(str_field(msg, "stop_reason"), msg)
    };

    out.events.push(SessionEvent::TurnEnded { stop: reason });
    out
}

fn stop_reason_from(raw: Option<&str>, msg: &Value) -> StopReason {
    match raw {
        Some("end_turn") | None => StopReason::EndTurn,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("refusal") => StopReason::Refusal {
            category: msg
                .get("stop_details")
                .and_then(|d| str_field(d, "category"))
                .map(str::to_owned),
        },
        Some(other) => StopReason::Other {
            reason: other.to_owned(),
        },
    }
}

fn usage_from(usage: &Value) -> Usage {
    Usage {
        input_tokens: u64_field(usage, "input_tokens").unwrap_or(0),
        output_tokens: u64_field(usage, "output_tokens").unwrap_or(0),
        cache_read_tokens: u64_field(usage, "cache_read_input_tokens").unwrap_or(0),
        cache_write_tokens: u64_field(usage, "cache_creation_input_tokens").unwrap_or(0),
        reasoning_tokens: usage
            .get("output_tokens_details")
            .and_then(|d| u64_field(d, "thinking_tokens"))
            .unwrap_or(0),
    }
}

/// Subscription usage, handed over in-band on every turn.
fn on_rate_limit(msg: &Value) -> Step {
    let Some(windows) = msg
        .get("rate_limit_info")
        .and_then(|i| i.get("unifiedWindows"))
        .and_then(Value::as_object)
    else {
        return Step::none();
    };

    let mut parsed: Vec<RateLimitWindow> = windows
        .iter()
        .filter_map(|(label, body)| {
            Some(RateLimitWindow {
                label: label.clone(),
                utilization: body.get("utilization").and_then(Value::as_f64)?,
                resets_at_ms: body
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .and_then(|s| s.checked_mul(1000)),
            })
        })
        .collect();

    if parsed.is_empty() {
        return Step::none();
    }
    // Stable order so the footer does not reshuffle between turns.
    parsed.sort_by(|a, b| a.label.cmp(&b.label));
    Step::event(SessionEvent::RateLimits { windows: parsed })
}

/// Classifies an error the CLI reported. Used by the engine, not by decoding.
#[must_use]
pub fn classify(message: &str) -> ErrorKind {
    let lower = message.to_ascii_lowercase();
    if lower.contains("rate limit") || lower.contains("429") {
        ErrorKind::RateLimited
    } else if lower.contains("unauthor") || lower.contains("log in") || lower.contains("401") {
        ErrorKind::Auth
    } else {
        ErrorKind::Transient
    }
}

#[cfg(test)]
mod tests {
    use super::{launch_args, ClaudeCodec};
    use crate::{Codec, StartContext, Step};
    use kitty_core::{SessionEvent, StopReason};
    use serde_json::json;

    fn ctx() -> StartContext {
        StartContext {
            cwd: r"C:\work".into(),
            resume: None,
            model: None,
        }
    }

    // Taking the value by move keeps every call site a bare `json!(...)`.
    #[allow(clippy::needless_pass_by_value)]
    fn feed(codec: &mut ClaudeCodec, value: serde_json::Value) -> Step {
        codec.on_frame(&value.to_string())
    }

    #[test]
    fn launch_args_require_print_mode() {
        let args = launch_args();
        assert!(args.contains(&"--print".to_owned()));
        assert!(args.contains(&"stream-json".to_owned()));
        assert!(args.contains(&"--include-partial-messages".to_owned()));
    }

    #[test]
    fn init_reports_the_session_and_model() {
        let mut codec = ClaudeCodec::new();
        assert!(codec.start(&ctx()).is_empty());

        let step = feed(
            &mut codec,
            json!({"type":"system","subtype":"init","session_id":"abc","model":"claude-opus-5[1m]"}),
        );
        assert_eq!(
            step.events,
            vec![SessionEvent::Started {
                provider_session: Some("abc".into()),
                model: Some("claude-opus-5[1m]".into()),
            }]
        );
    }

    #[test]
    fn a_second_init_does_not_restart_the_session() {
        let mut codec = ClaudeCodec::new();
        let init = json!({"type":"system","subtype":"init","session_id":"abc"});
        assert_eq!(feed(&mut codec, init.clone()).events.len(), 1);
        assert!(feed(&mut codec, init).is_empty());
    }

    #[test]
    fn text_deltas_pass_through_untouched() {
        let mut codec = ClaudeCodec::new();
        let mut text = String::new();
        for chunk in ["Hello there", ", friend"] {
            let step = feed(
                &mut codec,
                json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                       "delta":{"type":"text_delta","text":chunk}}}),
            );
            match step.events.as_slice() {
                [SessionEvent::MessageDelta { text: t }] => text.push_str(t),
                other => panic!("expected one delta, got {other:?}"),
            }
        }
        assert_eq!(text, "Hello there, friend");
    }

    #[test]
    fn a_whitespace_only_delta_is_kept() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                   "delta":{"type":"text_delta","text":" "}}}),
        );
        assert_eq!(
            step.events,
            vec![SessionEvent::MessageDelta { text: " ".into() }]
        );
    }

    #[test]
    fn thinking_blocks_produce_reasoning_events() {
        let mut codec = ClaudeCodec::new();
        feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,
                   "content_block":{"type":"thinking"}}}),
        );
        let delta = feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                   "delta":{"type":"thinking_delta","thinking":"hmm"}}}),
        );
        assert_eq!(
            delta.events,
            vec![SessionEvent::ReasoningDelta { text: "hmm".into() }]
        );
        let stop = feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
        );
        assert_eq!(stop.events, vec![SessionEvent::ReasoningDone]);
    }

    #[test]
    fn a_text_block_stopping_is_not_reasoning_done() {
        let mut codec = ClaudeCodec::new();
        feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_start","index":0,
                   "content_block":{"type":"text"}}}),
        );
        let stop = feed(
            &mut codec,
            json!({"type":"stream_event","event":{"type":"content_block_stop","index":0}}),
        );
        assert!(stop.is_empty());
    }

    #[test]
    fn the_assistant_message_is_the_authoritative_text() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"Hello there, friend"}]}}),
        );
        assert_eq!(
            step.events,
            vec![SessionEvent::MessageDone {
                text: "Hello there, friend".into()
            }]
        );
    }

    #[test]
    fn a_tool_only_message_produces_nothing_yet() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"assistant","message":{"content":[
                {"type":"tool_use","id":"t1","name":"Read","input":{}}]}}),
        );
        assert!(step.is_empty());
    }

    #[test]
    fn result_ends_the_turn_with_usage() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"result","stop_reason":"end_turn","is_error":false,
                   "usage":{"input_tokens":2,"output_tokens":9,
                            "cache_read_input_tokens":15445,"cache_creation_input_tokens":9091,
                            "output_tokens_details":{"thinking_tokens":0}}}),
        );
        match step.events.as_slice() {
            [SessionEvent::Usage(usage), SessionEvent::TurnEnded { stop }] => {
                assert_eq!(usage.input_tokens, 2);
                assert_eq!(usage.output_tokens, 9);
                assert_eq!(usage.cache_read_tokens, 15445);
                assert_eq!(usage.cache_write_tokens, 9091);
                assert_eq!(*stop, StopReason::EndTurn);
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn an_errored_result_is_a_failure_not_a_clean_end() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"result","is_error":true,"result":"context limit reached"}),
        );
        assert!(matches!(
            step.events.last(),
            Some(SessionEvent::TurnEnded {
                stop: StopReason::Failed { .. }
            })
        ));
    }

    #[test]
    fn a_refusal_carries_its_category() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"result","stop_reason":"refusal","stop_details":{"category":"cyber"}}),
        );
        assert!(matches!(
            step.events.last(),
            Some(SessionEvent::TurnEnded {
                stop: StopReason::Refusal { category: Some(c) }
            }) if c == "cyber"
        ));
    }

    #[test]
    fn rate_limit_windows_are_reported_in_a_stable_order() {
        let mut codec = ClaudeCodec::new();
        let step = feed(
            &mut codec,
            json!({"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{
                "seven_day":{"utilization":0.49,"resetsAt":1_789_513_200},
                "five_hour":{"utilization":0.07,"resetsAt":1_789_462_200}}}}),
        );
        match step.events.as_slice() {
            [SessionEvent::RateLimits { windows }] => {
                assert_eq!(windows[0].label, "five_hour");
                assert_eq!(windows[1].label, "seven_day");
                assert_eq!(windows[0].resets_at_ms, Some(1_789_462_200_000));
            }
            other => panic!("unexpected events: {other:?}"),
        }
    }

    #[test]
    fn a_user_turn_is_one_json_line() {
        let mut codec = ClaudeCodec::new();
        let step = codec.send_turn("hello");
        assert_eq!(step.send.len(), 1);
        let sent: serde_json::Value =
            serde_json::from_str(&step.send[0]).expect("must be valid JSON");
        assert_eq!(sent["type"], "user");
        assert_eq!(sent["message"]["content"][0]["text"], "hello");
        assert!(!step.send[0].contains('\n'), "a frame must be one line");
    }

    #[test]
    fn cancel_sends_an_interrupt_with_a_unique_id() {
        let mut codec = ClaudeCodec::new();
        let first = codec.cancel();
        let second = codec.cancel();
        let a: serde_json::Value = serde_json::from_str(&first.send[0]).expect("json");
        let b: serde_json::Value = serde_json::from_str(&second.send[0]).expect("json");
        assert_eq!(a["request"]["subtype"], "interrupt");
        assert_ne!(a["request_id"], b["request_id"]);
    }

    #[test]
    fn garbage_is_ignored_rather_than_fatal() {
        let mut codec = ClaudeCodec::new();
        assert!(codec.on_frame("not json at all").is_empty());
        assert!(codec.on_frame("").is_empty());
        assert!(codec.on_frame("{}").is_empty());
        assert!(codec.on_frame(r#"{"type":"something_new"}"#).is_empty());
    }
}
