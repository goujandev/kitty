//! The Tauri host.
//!
//! The IPC surface is deliberately small and grouped by concern. `MonoCode`
//! registers 164 commands in one flat block, with a single 6,550-line file
//! holding 53 of them across four unrelated concerns (ADR-0003).
//!
//! Nothing here probes a CLI or opens a session during startup. `run()` builds
//! the window and returns; the frontend asks for what it needs once it has
//! painted.

mod sessions;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kitty_core::{HarnessId, InstallState, Scan};
use kitty_engine::{Session, SessionSpec};
use kitty_probe::EnvSnapshot;
use kitty_store::{Block, Hit, Project, SessionRow, Store};
use tauri::{Manager, State};

use sessions::{Live, Registry};

struct AppState {
    /// Last completed harness scan, so a re-render costs nothing.
    scan: Mutex<Option<Scan>>,
    store: Arc<Store>,
    live: Registry,
}

/// Turns any error into something the frontend can show.
fn fail(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

// ---------------------------------------------------------------- harnesses

// Tauri resolves `State` by value; the signature is not ours to choose.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn harness_snapshot(state: State<'_, AppState>) -> Option<Scan> {
    state.scan.lock().ok().and_then(|guard| guard.clone())
}

#[tauri::command]
async fn harness_rescan(state: State<'_, AppState>) -> Result<Scan, String> {
    let scan = tauri::async_runtime::spawn_blocking(|| {
        let started = std::time::Instant::now();
        let env = EnvSnapshot::capture();
        let harnesses = kitty_probe::probe_all(&env);
        Scan {
            harnesses,
            duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            path_dirs: env.path_dirs().len(),
        }
    })
    .await
    .map_err(|e| fail("the scan did not finish", e))?;

    if let Ok(mut guard) = state.scan.lock() {
        *guard = Some(scan.clone());
    }
    Ok(scan)
}

// ----------------------------------------------------------------- projects

/// Opens the folder picker. `None` means the user cancelled.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| fail("the folder picker failed", e))?;

    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn open_project(state: State<'_, AppState>, path: String) -> Result<Project, String> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let project = state
        .store
        .open_project(&root)
        .map_err(|e| fail("could not open that project", e))?;

    Ok(project)
}

/// Removes sessions in a project that were never used.
///
/// Called whenever a project is opened, including when one is restored at
/// startup. Picking an agent no longer creates a session, but this clears out
/// rows left by the previous behaviour, or by a crash between creating a
/// session and sending the first message.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn prune_sessions(state: State<'_, AppState>, project_id: String) -> Result<usize, String> {
    state
        .store
        .prune_empty_sessions(&project_id)
        .map_err(|e| fail("could not tidy up old sessions", e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>, String> {
    state
        .store
        .list_projects()
        .map_err(|e| fail("could not list projects", e))
}

// ----------------------------------------------------------------- sessions

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn list_sessions(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<SessionRow>, String> {
    state
        .store
        .list_sessions(&project_id)
        .map_err(|e| fail("could not list sessions", e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn create_session(
    state: State<'_, AppState>,
    project_id: String,
    harness: String,
) -> Result<SessionRow, String> {
    state
        .store
        .create_session(&project_id, &harness, None)
        .map_err(|e| fail("could not create a session", e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn session_blocks(state: State<'_, AppState>, session_id: String) -> Result<Vec<Block>, String> {
    state
        .store
        .blocks(&session_id)
        .map_err(|e| fail("could not load the transcript", e))
}

/// Starts the CLI for a session, if it is not already running.
///
/// Idempotent: the frontend calls this whenever it opens a session, and a
/// session that is already live just stays live.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn start_session(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    {
        let live = state
            .live
            .lock()
            .map_err(|_| "the session registry was poisoned".to_owned())?;
        if live.contains_key(&session_id) {
            return Ok(());
        }
    }

    let row = state
        .store
        .session(&session_id)
        .map_err(|e| fail("no such session", e))?;
    let project = state
        .store
        .list_projects()
        .map_err(|e| fail("could not read projects", e))?
        .into_iter()
        .find(|p| p.id == row.project_id)
        .ok_or_else(|| "the session's project is missing".to_owned())?;

    let harness = match row.harness.as_str() {
        "claude" => HarnessId::Claude,
        "codex" => HarnessId::Codex,
        other => return Err(format!("unknown harness {other}")),
    };

    // Resolve the binary the same way the Agents screen does, so a session
    // cannot start against something the user was told is unavailable.
    let env = EnvSnapshot::capture();
    let status = kitty_probe::probe_one(harness, &env);
    let InstallState::Found { path, .. } = &status.install else {
        let hint = status
            .hint
            .map_or_else(|| "it is not available".to_owned(), |h| h.message);
        return Err(format!("{} cannot run: {hint}", status.label));
    };

    let mut spec = SessionSpec::new(harness, path, &project.root);
    spec.resume.clone_from(&row.provider_session);
    spec.model.clone_from(&row.model);

    let (session, events) =
        Session::start(&spec).map_err(|e| fail("could not start the agent", e))?;

    sessions::pump(app, Arc::clone(&state.store), session_id.clone(), events);

    state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?
        .insert(session_id, Live { session });

    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn send_turn(state: State<'_, AppState>, session_id: String, text: String) -> Result<i64, String> {
    let trimmed = text.trim_end();
    if trimmed.is_empty() {
        return Err("nothing to send".to_owned());
    }

    // The user's message is persisted before it is sent, so a crash between
    // the two does not lose what they typed.
    let seq = state
        .store
        .append_block(&session_id, kitty_core::BlockKind::User, trimmed)
        .map_err(|e| fail("could not save your message", e))?;
    let _ = state.store.set_title_if_unset(&session_id, trimmed);

    let live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    let session = live
        .get(&session_id)
        .ok_or_else(|| "that session is not running".to_owned())?;

    if session.session.send(trimmed) {
        Ok(seq)
    } else {
        Err("the agent stopped accepting input".to_owned())
    }
}

/// Answers a permission request the agent raised.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn respond_approval(
    state: State<'_, AppState>,
    session_id: String,
    id: String,
    allow: bool,
) -> Result<(), String> {
    let live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    if let Some(session) = live.get(&session_id) {
        let _ = session.session.respond(id, allow);
    }
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn cancel_turn(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    if let Some(session) = live.get(&session_id) {
        let _ = session.session.cancel();
    }
    Ok(())
}

/// Stops the CLI. Dropping the session kills its process tree.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn stop_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    live.remove(&session_id);
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn search(state: State<'_, AppState>, query: String) -> Result<Vec<Hit>, String> {
    state
        .store
        .search(&query, 50)
        .map_err(|e| fail("search failed", e))
}

// --------------------------------------------------------------------- wiring

/// Opens the database under the app's data directory.
///
/// A failure here is not fatal: kitty falls back to an in-memory store so the
/// user can still talk to an agent, and says so rather than refusing to start.
fn open_store(app: &tauri::App) -> (Arc<Store>, Option<String>) {
    let path = app.path().app_data_dir().map(|dir| dir.join("kitty.db"));

    match path {
        Ok(path) => match Store::open(&path) {
            Ok(store) => (Arc::new(store), None),
            Err(e) => (
                Arc::new(Store::in_memory().unwrap_or_else(|_| unreachable!("in-memory store"))),
                Some(format!(
                    "could not open {}: {e}. This session will not be saved.",
                    path.display()
                )),
            ),
        },
        Err(e) => (
            Arc::new(Store::in_memory().unwrap_or_else(|_| unreachable!("in-memory store"))),
            Some(format!(
                "could not find a place to store data: {e}. This session will not be saved."
            )),
        ),
    }
}

/// Starts the app.
///
/// Copying a hint's command to the clipboard is done in the frontend. The
/// webview runs on a localhost origin, which browsers treat as a secure
/// context, so the Clipboard API is available and a command here would only
/// add a hop.
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            harness_snapshot,
            harness_rescan,
            pick_folder,
            open_project,
            list_projects,
            prune_sessions,
            list_sessions,
            create_session,
            session_blocks,
            start_session,
            send_turn,
            respond_approval,
            cancel_turn,
            stop_session,
            search,
        ])
        .setup(|app| {
            app.get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;

            let (store, warning) = open_store(app);
            if let Some(warning) = &warning {
                eprintln!("kitty: {warning}");
            }

            app.manage(AppState {
                scan: Mutex::new(None),
                store,
                live: Arc::new(Mutex::new(HashMap::new())),
            });
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        // There is no window to show this in, and a release build has no
        // console attached either, so the exit code is the real signal. The
        // message is here for `cargo run` and for a crash reporter later.
        eprintln!("kitty could not start: {error}");
        std::process::exit(1);
    }
}
