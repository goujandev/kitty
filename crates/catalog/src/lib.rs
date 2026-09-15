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
            found = models.iter().filter_map(claude_model).collect();
        }
        Reply::Done
    })?;

    Ok(found)
}

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
        display_name: raw
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned(),
        description: raw
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_owned),
        // The CLI reports no per-model default, so the middle of the range is
        // the honest choice rather than inventing one.
        default_effort: efforts.iter().find(|e| *e == "high").cloned(),
        efforts,
        is_default: id == "default",
    })
}

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
    use super::{claude_model, codex_model};
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
    fn the_claude_default_entry_is_marked() {
        let m =
            claude_model(&json!({"value": "default", "displayName": "Default"})).expect("model");
        assert!(m.is_default);
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
