//! Reading vendor login state. **Read-only, always.**
//!
//! ADR-0004: kitty never writes another tool's credential store, never
//! performs a refresh-token grant, and never sends a vendor user agent or
//! client id. Rotating a token in a file a running `claude` process also owns
//! can log the user out of their real tool.
//!
//! So this module opens files and nothing else. `tests/credentials_are_read_only.rs`
//! enforces that against this exact source file, and checks at runtime that a
//! probe leaves the bytes and the modification time untouched.
//!
//! `LoggedIn` here means "the stored token has not expired". It does not mean
//! the provider would accept it. Only the vendor CLI can establish that, and
//! asking it is its job, not ours.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use kitty_core::{HarnessDescriptor, HarnessId, LoginState};
use serde_json::Value;

use crate::env::EnvSnapshot;

/// Where the vendor keeps its credentials, honouring the relocation variable.
#[must_use]
pub fn credentials_path(descriptor: &HarnessDescriptor, env: &EnvSnapshot) -> Option<PathBuf> {
    let dir = match env.var(descriptor.config_dir_env) {
        Some(custom) if !custom.trim().is_empty() => PathBuf::from(custom),
        _ => env.home()?.join(descriptor.config_dir_name),
    };
    Some(dir.join(descriptor.credentials_rel))
}

/// Reads the vendor's credential file and decides whether the CLI is signed in.
#[must_use]
pub fn login_state(descriptor: &HarnessDescriptor, env: &EnvSnapshot) -> LoginState {
    let Some(path) = credentials_path(descriptor, env) else {
        return LoginState::Unknown {
            reason: "could not determine the user profile directory".to_owned(),
        };
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return LoginState::LoggedOut,
        Err(e) => {
            return LoginState::Unknown {
                reason: format!("{} could not be read: {e}", path.display()),
            }
        }
    };

    let Ok(json) = serde_json::from_str::<Value>(&raw) else {
        return LoginState::Unknown {
            reason: format!("{} is not valid JSON", path.display()),
        };
    };

    match descriptor.id {
        HarnessId::Claude => claude_login(&json),
        HarnessId::Codex => codex_login(&json),
    }
}

/// `~/.claude/.credentials.json`
///
/// ```json
/// { "claudeAiOauth": { "accessToken": "...", "expiresAt": 1789429430784,
///                      "subscriptionType": "max" } }
/// ```
fn claude_login(json: &Value) -> LoginState {
    let Some(oauth) = json.get("claudeAiOauth") else {
        return LoginState::LoggedOut;
    };
    if non_empty_str(oauth.get("accessToken")).is_none() {
        return LoginState::LoggedOut;
    }

    let plan = non_empty_str(oauth.get("subscriptionType")).map(str::to_owned);
    let expires_at_ms = oauth.get("expiresAt").and_then(Value::as_i64);

    classify(expires_at_ms, plan)
}

/// `~/.codex/auth.json`
///
/// ```json
/// { "auth_mode": "chatgpt", "OPENAI_API_KEY": null,
///   "tokens": { "id_token": "<jwt>", "access_token": "<jwt>" } }
/// ```
fn codex_login(json: &Value) -> LoginState {
    // An API-key login is still a working CLI, even though kitty itself is
    // subscription-only. Report it honestly rather than calling it logged out.
    if non_empty_str(json.get("OPENAI_API_KEY")).is_some() {
        return LoginState::LoggedIn {
            plan: Some("API key".to_owned()),
            expires_at_ms: None,
        };
    }

    let tokens = json.get("tokens");
    let Some(access) = tokens.and_then(|t| non_empty_str(t.get("access_token"))) else {
        return LoginState::LoggedOut;
    };

    let expires_at_ms = jwt_claims(access)
        .and_then(|c| c.get("exp").and_then(Value::as_i64))
        .and_then(|seconds| seconds.checked_mul(1000));

    let plan = tokens
        .and_then(|t| non_empty_str(t.get("id_token")))
        .and_then(jwt_claims)
        .and_then(|claims| chatgpt_plan(&claims));

    classify(expires_at_ms, plan)
}

/// Digs `chatgpt_plan_type` out of the `OpenAI` auth claim, if it is there.
/// Entirely best-effort: a missing plan label is not an error.
fn chatgpt_plan(claims: &Value) -> Option<String> {
    claims
        .as_object()?
        .iter()
        .find(|(key, _)| key.ends_with("/auth"))
        .and_then(|(_, value)| non_empty_str(value.get("chatgpt_plan_type")))
        .map(str::to_owned)
}

fn classify(expires_at_ms: Option<i64>, plan: Option<String>) -> LoginState {
    match expires_at_ms {
        Some(expiry) if expiry <= now_ms() => LoginState::Expired {
            expired_at_ms: expiry,
        },
        _ => LoginState::LoggedIn {
            plan,
            expires_at_ms,
        },
    }
}

/// Decodes a JWT payload without verifying it. We are reading an expiry the
/// vendor already trusted, not authenticating anything.
fn jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn non_empty_str(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::{claude_login, codex_login, credentials_path, now_ms};
    use crate::env::EnvSnapshot;
    use kitty_core::{LoginState, CLAUDE, CODEX};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).expect("fixture must be valid JSON")
    }

    fn future() -> i64 {
        now_ms() + 86_400_000
    }

    fn past() -> i64 {
        now_ms() - 86_400_000
    }

    #[test]
    fn claude_signed_in_reports_its_plan() {
        let state = claude_login(&json(&format!(
            r#"{{"claudeAiOauth":{{"accessToken":"tok","expiresAt":{},"subscriptionType":"max"}}}}"#,
            future()
        )));
        match state {
            LoginState::LoggedIn { plan, .. } => assert_eq!(plan.as_deref(), Some("max")),
            other => panic!("expected LoggedIn, got {other:?}"),
        }
    }

    #[test]
    fn claude_past_expiry_is_expired() {
        let state = claude_login(&json(&format!(
            r#"{{"claudeAiOauth":{{"accessToken":"tok","expiresAt":{}}}}}"#,
            past()
        )));
        assert!(matches!(state, LoginState::Expired { .. }));
    }

    #[test]
    fn claude_without_a_token_is_logged_out() {
        assert!(matches!(claude_login(&json("{}")), LoginState::LoggedOut));
        assert!(matches!(
            claude_login(&json(r#"{"claudeAiOauth":{"accessToken":""}}"#)),
            LoginState::LoggedOut
        ));
    }

    #[test]
    fn claude_without_an_expiry_is_still_signed_in() {
        // Absent expiry must not be read as "expired at the epoch".
        let state = claude_login(&json(r#"{"claudeAiOauth":{"accessToken":"tok"}}"#));
        assert!(matches!(state, LoginState::LoggedIn { .. }));
    }

    /// Builds an unsigned JWT with the given payload. Signature is irrelevant;
    /// we never verify one.
    fn jwt(payload: &str) -> String {
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        use base64::Engine;
        format!("h.{}.s", URL_SAFE_NO_PAD.encode(payload))
    }

    #[test]
    fn codex_reads_expiry_from_the_access_token() {
        let exp = future() / 1000;
        let token = jwt(&format!(r#"{{"exp":{exp}}}"#));
        let state = codex_login(&json(&format!(
            r#"{{"auth_mode":"chatgpt","tokens":{{"access_token":"{token}"}}}}"#
        )));
        match state {
            LoginState::LoggedIn { expires_at_ms, .. } => {
                assert_eq!(expires_at_ms, Some(exp * 1000));
            }
            other => panic!("expected LoggedIn, got {other:?}"),
        }
    }

    #[test]
    fn codex_expired_token_is_expired() {
        let token = jwt(&format!(r#"{{"exp":{}}}"#, past() / 1000));
        let state = codex_login(&json(&format!(
            r#"{{"tokens":{{"access_token":"{token}"}}}}"#
        )));
        assert!(matches!(state, LoginState::Expired { .. }));
    }

    #[test]
    fn codex_picks_up_the_plan_from_the_id_token() {
        let exp = future() / 1000;
        let access = jwt(&format!(r#"{{"exp":{exp}}}"#));
        let id = jwt(r#"{"https://api.openai.com/auth":{"chatgpt_plan_type":"pro"}}"#);
        let state = codex_login(&json(&format!(
            r#"{{"tokens":{{"access_token":"{access}","id_token":"{id}"}}}}"#
        )));
        match state {
            LoginState::LoggedIn { plan, .. } => assert_eq!(plan.as_deref(), Some("pro")),
            other => panic!("expected LoggedIn, got {other:?}"),
        }
    }

    #[test]
    fn codex_api_key_counts_as_signed_in() {
        let state = codex_login(&json(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#));
        match state {
            LoginState::LoggedIn { plan, .. } => assert_eq!(plan.as_deref(), Some("API key")),
            other => panic!("expected LoggedIn, got {other:?}"),
        }
    }

    #[test]
    fn codex_null_api_key_is_not_a_login() {
        // The real file has `"OPENAI_API_KEY": null` while signed in via ChatGPT.
        assert!(matches!(
            codex_login(&json(r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null}"#)),
            LoginState::LoggedOut
        ));
    }

    #[test]
    fn codex_garbage_token_does_not_panic() {
        let state = codex_login(&json(r#"{"tokens":{"access_token":"not-a-jwt"}}"#));
        // No expiry could be read, so we do not claim it is expired.
        assert!(matches!(state, LoginState::LoggedIn { .. }));
    }

    #[test]
    fn config_dir_env_overrides_the_default_location() {
        let env = EnvSnapshot::from_parts(
            Vec::new(),
            HashMap::from([
                ("USERPROFILE".to_owned(), r"C:\Users\x".to_owned()),
                ("CLAUDE_CONFIG_DIR".to_owned(), r"D:\cfg".to_owned()),
            ]),
        );
        assert_eq!(
            credentials_path(&CLAUDE, &env),
            Some(PathBuf::from(r"D:\cfg\.credentials.json"))
        );
    }

    #[test]
    fn default_location_sits_under_the_user_profile() {
        let env = EnvSnapshot::from_parts(
            Vec::new(),
            HashMap::from([("USERPROFILE".to_owned(), r"C:\Users\x".to_owned())]),
        );
        assert_eq!(
            credentials_path(&CODEX, &env),
            Some(PathBuf::from(r"C:\Users\x\.codex\auth.json"))
        );
    }
}
