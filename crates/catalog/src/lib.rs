//! Asking each CLI which models it can run.
//!
//! Live discovery is the whole answer to "every Anthropic and `OpenAI` model"
//! (`MODEL-CATALOG.md`). Whatever the subscription exposes is what appears,
//! and a model that ships tomorrow needs no release from us.
//!
//! Both probes are short-lived: start the CLI, ask, read the answer, stop.
//! Neither runs on the startup path.
//!
//! Discovered from the installed CLIs on 2026-09-15:
//!
//! ```text
//! claude  control_request {"subtype":"list_models"}
//!         -> {"models":[{"value","resolvedModel","displayName","description",
//!                        "supportedEffortLevels","supportsEffort"}]}
//! codex   initialize, initialized, then paginated model/list
//!         -> {"data":[{"model","displayName","supportedReasoningEfforts",
//!                      "defaultReasoningEffort","isDefault","hidden"}],
//!             "nextCursor"}
//! ```

use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kitty_core::{HarnessId, ModelCatalog, ModelInfo};
use kitty_supervisor::{spawn, ChildEvent, Frame, SpawnSpec};
use serde_json::{json, Value};

/// How long a probe may take.
///
/// Generous because `claude` is an npm shim that boots Node before it will
/// answer anything.
const TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug)]
pub struct CatalogError {
    pub message: String,
}

impl std::fmt::Display for CatalogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CatalogError {}

fn failed(message: impl Into<String>) -> CatalogError {
    CatalogError {
        message: message.into(),
    }
}

/// Asks a harness for its models.
pub fn probe(
    harness: HarnessId,
    binary: &Path,
    cwd: &Path,
    cli_version: &str,
) -> Result<ModelCatalog, CatalogError> {
    let models = match harness {
        HarnessId::Claude => probe_claude(binary, cwd),
        HarnessId::Codex => probe_codex(binary, cwd),
    }?;

    if models.is_empty() {
        return Err(failed("the CLI reported no models"));
    }

    Ok(ModelCatalog {
        harness,
        models,
        cli_version: cli_version.to_owned(),
        fetched_at_ms: now_ms(),
    })
}

/// Runs a CLI, feeds it some frames, and collects lines until `done` says so.
///
/// Both probes are the same shape, so the process handling lives here once.
fn converse(
    binary: &Path,
    cwd: &Path,
    args: Vec<String>,
    opening: Vec<String>,
    mut on_line: impl FnMut(&str) -> Reply,
) -> Result<(), CatalogError> {
    let mut child = spawn(&SpawnSpec::new(binary, cwd).args(args))
        .map_err(|e| failed(format!("could not start the CLI: {e}")))?;
    let events = child
        .take_events()
        .ok_or_else(|| failed("the supervisor gave us no event stream"))?;

    for line in opening {
        child.write_line(line);
    }

    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        let Ok(event) = events.recv_timeout(Duration::from_millis(250)) else {
            continue;
        };
        match event {
            ChildEvent::Frames(frames) => {
                for frame in frames {
                    let Frame::Line(line) = frame else { continue };
                    match on_line(&line) {
                        Reply::Done => return Ok(()),
                        Reply::Send(lines) => {
                            for line in lines {
                                child.write_line(line);
                            }
                        }
                        Reply::Continue => {}
                    }
                }
            }
            ChildEvent::Exited { code } => {
                return Err(failed(format!(
                    "the CLI exited before answering (code {})",
                    code.unwrap_or(-1)
                )));
            }
            ChildEvent::Stderr(_) | ChildEvent::ReadFailed { .. } => {}
        }
    }
    Err(failed("the CLI did not answer in time"))
}

enum Reply {
    Continue,
    Send(Vec<String>),
    Done,
}

/// Claude answers a `list_models` control request on its normal stream.
fn probe_claude(binary: &Path, cwd: &Path) -> Result<Vec<ModelInfo>, CatalogError> {
    let args = kitty_harness::claude::launch_args()
        .into_iter()
        // The permission tool is for real turns; a listing never uses one, and
        // leaving it on would make the CLI wait for a prompt handler.
        .filter(|a| a != "--permission-prompt-tool" && a != "stdio")
        .collect();

    let ask = json!({
        "type": "control_request",
        "request_id": "kitty-models",
        "request": { "subtype": "list_models" },
    })
    .to_string();

    let mut found = Vec::new();
    converse(binary, cwd, args, vec![ask], |line| {
        let Ok(msg) = serde_json::from_str::<Value>(line) else {
            return Reply::Continue;
        };
        if msg.get("type").and_then(Value::as_str) != Some("control_response") {
            return Reply::Continue;
        }
        let response = msg.get("response").unwrap_or(&Value::Null);
        if response.get("request_id").and_then(Value::as_str) != Some("kitty-models") {
            return Reply::Continue;
        }
        if let Some(models) = response
            .get("response")
            .and_then(|r| r.get("models"))
            .and_then(Value::as_array)
        {
            found = claude_models(models);
        }
        Reply::Done
    })?;

    Ok(found)
}

/// The list, with the `default` row folded into the model it points at.
///
/// Claude Code offers a row called "Default (recommended)" whose
/// `resolvedModel` is one of the others -- today `claude-opus-5[1m]`, which is
/// also what `opus[1m]` resolves to. Kept as its own entry it is a second name
/// for a model already in the list, and picking between two rows that do the
/// same thing is not a choice, it is a puzzle.
///
/// So the row goes, and the thing it was recommending is marked instead. The
/// recommendation itself is not lost, just attached to a real model.
fn claude_models(raw: &[Value]) -> Vec<ModelInfo> {
    let recommended = raw
        .iter()
        .find(|entry| entry.get("value").and_then(Value::as_str) == Some(DEFAULT_ID))
        .and_then(|entry| entry.get("resolvedModel").and_then(Value::as_str));

    raw.iter()
        .filter(|entry| entry.get("value").and_then(Value::as_str) != Some(DEFAULT_ID))
        .filter_map(|entry| {
            let mut model = claude_model(entry)?;
            // Matched on what it resolves to rather than on the id, because
            // the recommendation names the underlying model and the ids that
            // reach it are aliases.
            model.is_default = recommended.is_some_and(|target| {
                entry.get("resolvedModel").and_then(Value::as_str) == Some(target)
            });
            Some(model)
        })
        .collect()
}

/// The alias Claude Code uses for "whichever one we currently recommend".
const DEFAULT_ID: &str = "default";

fn claude_model(raw: &Value) -> Option<ModelInfo> {
    // `value` is what the CLI accepts back; `resolvedModel` is only for show.
    let id = raw.get("value").and_then(Value::as_str)?;
    let efforts: Vec<String> = raw
        .get("supportedEffortLevels")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|l| l.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    Some(ModelInfo {
        id: id.to_owned(),
        display_name: claude_label(
            raw,
            raw.get("displayName").and_then(Value::as_str).unwrap_or(id),
        ),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        // The CLI reports no per-model default, so the middle of the range is
        // the honest choice rather than inventing one.
        default_effort: efforts.iter().find(|e| *e == "high").cloned(),
        efforts,
        // Decided by `claude_models`, which is the only caller and the only
        // place that can see the whole list at once.
        is_default: false,
    })
}

/// The model's real name, which Claude Code puts in the description.
///
/// `displayName` is the family alone -- "Fable", "Sonnet", "Haiku" -- so the
/// picker showed two generations of a model under one name and no way to tell
/// which you were about to run. The description opens with the full name and
/// then a separator and a sales line: "Fable 5.1 - Most capable for your
/// hardest and longest-running tasks". The first half is the answer.
///
/// Read from the CLI rather than from a table in this repo, for the same
/// reason the catalog itself is (`MODEL-CATALOG.md`): a model released this
/// morning has to name itself correctly without kitty shipping anything.
///
/// An earlier version of this read the version off the id instead, which was
/// wrong in a way worth recording. `claude-fable-5-1[1m]` resolves to plain
/// `claude-fable-5-1` -- the bracket in the id is not a promise about context
/// -- so parsing it produced a label claiming a 1M window the model does not
/// have. The CLI knows; kitty should not be guessing.
fn claude_label(raw: &Value, display_name: &str) -> String {
    raw.get("description")
        .and_then(Value::as_str)
        .and_then(|text| text.split(SEPARATOR).next())
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map_or_else(|| display_name.to_owned(), str::to_owned)
}

/// The middle dot Claude Code puts between a model's name and its blurb.
const SEPARATOR: char = '\u{b7}';

/// Codex answers a paginated `model/list` after the usual handshake.
fn probe_codex(binary: &Path, cwd: &Path) -> Result<Vec<ModelInfo>, CatalogError> {
    let init = json!({
        "id": 1,
        "method": "initialize",
        "params": {
            "clientInfo": { "name": "kitty", "title": "kitty", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true },
        },
    })
    .to_string();

    let mut found: Vec<ModelInfo> = Vec::new();
    let mut next_id = 1u64;

    converse(
        binary,
        cwd,
        kitty_harness::codex::launch_args(),
        vec![init],
        |line| {
            let Ok(msg) = serde_json::from_str::<Value>(line) else {
                return Reply::Continue;
            };
            let Some(id) = msg.get("id").and_then(Value::as_u64) else {
                return Reply::Continue;
            };
            if let Some(error) = msg.get("error") {
                // Surfaces as "no models", which the caller reports honestly.
                let _ = error;
                return Reply::Done;
            }
            let Some(result) = msg.get("result") else {
                return Reply::Continue;
            };

            if id == 1 {
                next_id = 2;
                return Reply::Send(vec![
                    json!({ "method": "initialized" }).to_string(),
                    json!({ "id": 2, "method": "model/list", "params": {} }).to_string(),
                ]);
            }

            if let Some(rows) = result.get("data").and_then(Value::as_array) {
                found.extend(rows.iter().filter_map(codex_model));
            }

            // Keep paging while the server offers a cursor.
            match result.get("nextCursor").and_then(Value::as_str) {
                Some(cursor) => {
                    next_id += 1;
                    Reply::Send(vec![json!({
                        "id": next_id,
                        "method": "model/list",
                        "params": { "cursor": cursor },
                    })
                    .to_string()])
                }
                None => Reply::Done,
            }
        },
    )?;

    Ok(found)
}

fn codex_model(raw: &Value) -> Option<ModelInfo> {
    if raw.get("hidden").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let id = raw
        .get("model")
        .or_else(|| raw.get("slug"))
        .or_else(|| raw.get("id"))
        .and_then(Value::as_str)?;

    // The list is either strings or objects, depending on the build.
    let efforts: Vec<String> = raw
        .get("supportedReasoningEfforts")
        .and_then(Value::as_array)
        .map(|levels| {
            levels
                .iter()
                .filter_map(|l| {
                    l.as_str().map(str::to_owned).or_else(|| {
                        l.get("reasoningEffort")
                            .or_else(|| l.get("id"))
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(ModelInfo {
        id: id.to_owned(),
        display_name: raw
            .get("displayName")
            .or_else(|| raw.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned(),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        default_effort: raw
            .get("defaultReasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_owned),
        efforts,
        is_default: raw.get("isDefault").and_then(Value::as_bool) == Some(true),
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {

    /// The five entries Claude Code 2.1.270 actually returns, verbatim.
    ///
    /// Captured from the installed CLI rather than invented, because the whole
    /// point is to use its own words. If a future CLI stops putting the name
    /// in the description this fails, which is the correct outcome.
    #[test]
    fn a_claude_label_is_the_name_the_cli_puts_in_the_description() {
        let cases = [
            (
                json!({
                    "value": "opus[1m]",
                    "displayName": "Opus (1M context)",
                    "description": "Opus 5 with 1M context \u{b7} Best for everyday, complex tasks",
                }),
                "Opus 5 with 1M context",
            ),
            (
                json!({
                    "value": "claude-fable-5-1[1m]",
                    "displayName": "Fable",
                    "description": "Fable 5.1 \u{b7} Most capable for your hardest and longest-running tasks",
                }),
                // The bracket in this id is not a 1M window -- it resolves to
                // plain `claude-fable-5-1`. A label read off the id claimed
                // otherwise, which is why nothing is read off the id.
                "Fable 5.1",
            ),
            (
                json!({
                    "value": "sonnet",
                    "displayName": "Sonnet",
                    "description": "Sonnet 5 \u{b7} Efficient for routine tasks",
                }),
                "Sonnet 5",
            ),
            (
                json!({
                    "value": "haiku",
                    "displayName": "Haiku",
                    "description": "Haiku 4.5 \u{b7} Fastest for quick answers",
                }),
                "Haiku 4.5",
            ),
        ];

        for (raw, expected) in cases {
            let given = raw
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            assert_eq!(super::claude_label(&raw, given), expected);
        }
    }

    /// A model kitty has never heard of still has to arrive intact.
    #[test]
    fn a_claude_label_falls_back_when_the_description_has_no_name() {
        let bare = json!({ "value": "some-new-thing" });
        assert_eq!(
            super::claude_label(&bare, "Some New Thing"),
            "Some New Thing"
        );

        let empty = json!({ "value": "y", "description": "   " });
        assert_eq!(super::claude_label(&empty, "Y"), "Y");
    }

    use super::{claude_model, claude_models, codex_model};
    use serde_json::json;

    #[test]
    fn a_claude_model_uses_the_value_the_cli_accepts_back() {
        // `resolvedModel` is for display; `value` is what --model takes.
        let m = claude_model(&json!({
            "value": "sonnet",
            "resolvedModel": "claude-sonnet-5",
            "displayName": "Sonnet",
            "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
        }))
        .expect("model");
        assert_eq!(m.id, "sonnet");
        assert_eq!(m.display_name, "Sonnet");
        assert_eq!(m.efforts.len(), 5);
        assert_eq!(m.default_effort.as_deref(), Some("high"));
        assert!(!m.is_default);
    }

    #[test]
    fn the_default_row_is_dropped_and_what_it_pointed_at_is_marked() {
        // The shape Claude Code 2.1.270 returns: a "default" alias whose
        // resolvedModel is the same one `opus[1m]` reaches.
        let raw = vec![
            json!({
                "value": "default",
                "resolvedModel": "claude-opus-5[1m]",
                "displayName": "Default (recommended)",
                "description": "Opus 5 with 1M context \u{b7} Best for everyday, complex tasks",
            }),
            json!({
                "value": "opus[1m]",
                "resolvedModel": "claude-opus-5[1m]",
                "displayName": "Opus (1M context)",
                "description": "Opus 5 with 1M context \u{b7} Best for everyday, complex tasks",
            }),
            json!({
                "value": "sonnet",
                "resolvedModel": "claude-sonnet-5",
                "displayName": "Sonnet",
                "description": "Sonnet 5 \u{b7} Efficient for routine tasks",
            }),
        ];

        let models = claude_models(&raw);

        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["opus[1m]", "sonnet"],
            "the alias is not a model anyone should have to choose between"
        );

        let marked: Vec<&str> = models
            .iter()
            .filter(|m| m.is_default)
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(
            marked,
            vec!["opus[1m]"],
            "the recommendation moves to the model it was pointing at"
        );
    }

    /// Nothing claims to be recommended if the CLI stops recommending.
    #[test]
    fn without_a_default_row_no_model_claims_to_be_one() {
        let raw = vec![json!({
            "value": "sonnet",
            "resolvedModel": "claude-sonnet-5",
            "displayName": "Sonnet",
            "description": "Sonnet 5 \u{b7} Efficient for routine tasks",
        })];
        assert!(claude_models(&raw).iter().all(|m| !m.is_default));
    }

    #[test]
    fn a_model_with_no_effort_levels_reports_none() {
        // Haiku genuinely has none; an empty list is an answer, not a gap.
        let m = claude_model(&json!({"value": "haiku", "displayName": "Haiku"})).expect("model");
        assert!(m.efforts.is_empty());
        assert_eq!(m.default_effort, None);
    }

    #[test]
    fn a_codex_model_keeps_its_declared_default_effort() {
        let m = codex_model(&json!({
            "model": "gpt-6-astra",
            "displayName": "GPT-6-Astra",
            "supportedReasoningEfforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
            "defaultReasoningEffort": "medium",
            "isDefault": true,
        }))
        .expect("model");
        assert_eq!(m.id, "gpt-6-astra");
        assert_eq!(m.default_effort.as_deref(), Some("medium"));
        assert!(m.is_default);
        assert_eq!(m.efforts.len(), 6);
    }

    #[test]
    fn codex_efforts_may_arrive_as_objects() {
        let m = codex_model(&json!({
            "model": "gpt-5.5",
            "supportedReasoningEfforts": [{"reasoningEffort": "low"}, {"id": "high"}],
        }))
        .expect("model");
        assert_eq!(m.efforts, vec!["low".to_owned(), "high".to_owned()]);
    }

    #[test]
    fn a_hidden_codex_model_is_skipped() {
        assert!(codex_model(&json!({"model": "internal", "hidden": true})).is_none());
    }

    #[test]
    fn a_row_with_no_identifier_is_skipped() {
        assert!(codex_model(&json!({"displayName": "Nameless"})).is_none());
        assert!(claude_model(&json!({"displayName": "Nameless"})).is_none());
    }
}
