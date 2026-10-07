//! The Tauri host.
//!
//! The IPC surface is deliberately small and grouped by concern. `MonoCode`
//! registers 164 commands in one flat block, with a single 6,550-line file
//! holding 53 of them across four unrelated concerns (ADR-0003).
//!
//! Nothing here probes a CLI or opens a session during startup. `run()` builds
//! the window and returns; the frontend asks for what it needs once it has
//! painted.

mod attachments;
mod dictation;
mod sessions;
mod titles;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pantheon_core::{HarnessId, InstallState, ModelCatalog, Scan};
use pantheon_engine::{ApprovalMode, Session, SessionSpec};
use pantheon_probe::EnvSnapshot;
use pantheon_store::{Block, Hit, Project, SessionRow, Store};
use tauri::{Manager, State};

use sessions::{Live, Registry};

type TitleSink = Arc<dyn Fn(&str, &str, &str) + Send + Sync>;

struct AppState {
    /// Last completed harness scan, so a re-render costs nothing.
    scan: Mutex<Option<Scan>>,
    store: Arc<Store>,
    live: Registry,
    /// Tells the window a chat was retitled. Set once the app is running;
    /// absent in tests, which also keeps tests from asking a real CLI to name
    /// their chats. A plain callback rather than the app handle, so code the
    /// tests exercise never links Tauri's windowing.
    retitled: std::sync::OnceLock<TitleSink>,
}

// -------------------------------------------------------------- pictures

/// Where an agent is allowed to have put a picture we will show.
///
/// Codex generates images itself and writes them to
/// `~/.codex/generated_images/<thread>/<call-id>.png`; Claude's tools and MCP
/// servers write wherever they were pointed. The transcript is model output,
/// so the path in it is model output too, and a path pantheon will open on the
/// strength of a sentence is a path the model chooses.
///
/// Hence a list. Nothing outside these roots is served, whatever the text
/// says, so the worst a made-up path can do is fail to load.
fn picture_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let home = PathBuf::from(home);
        roots.push(home.join(".codex"));
        roots.push(home.join(".claude"));
    }
    // Pictures the user attached, as pantheon's own copies.
    if let Some(dir) = attachments::root() {
        roots.push(dir.to_path_buf());
    }
    roots
}

/// Extensions a browser will actually draw. Not a MIME sniff: the point is to
/// refuse to open anything that is not a picture, and the name is the cheapest
/// place to decide that.
fn picture_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
}

/// Whether pantheon will show the file at `path`, and as what.
///
/// Both halves matter. The root check stops the transcript naming a file
/// outside the agents' own folders; `canonicalize` is what makes it a check
/// rather than a formality, since without it `...\.codex\..\..\secrets.png`
/// passes a prefix test.
fn servable_picture(path: &Path, roots: &[PathBuf]) -> Option<(PathBuf, &'static str)> {
    let mime = picture_mime(path)?;
    let real = std::fs::canonicalize(path).ok()?;
    if !real.is_file() {
        return None;
    }
    roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .any(|root| real.starts_with(&root))
        .then_some((real, mime))
}

/// Serves one picture, or refuses.
///
/// The webview asks by path, so this is the boundary that decides. Everything
/// it will not serve returns 404 rather than an explanation: a handler that
/// says *why* it refused tells whatever asked which paths exist.
fn picture_response(path: &str) -> tauri::http::Response<Vec<u8>> {
    let refuse = || {
        tauri::http::Response::builder()
            .status(tauri::http::StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap_or_default()
    };

    let Ok(decoded) = percent_decode(path.trim_start_matches('/')) else {
        return refuse();
    };
    let Some((real, mime)) = servable_picture(Path::new(&decoded), &picture_roots()) else {
        return refuse();
    };
    let Ok(bytes) = std::fs::read(&real) else {
        return refuse();
    };

    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header(tauri::http::header::CONTENT_TYPE, mime)
        // Named by absolute path, and the file at a given path is the one the
        // agent just wrote, so it never changes under a given URL.
        .header(
            tauri::http::header::CACHE_CONTROL,
            "max-age=31536000, immutable",
        )
        .body(bytes)
        .unwrap_or_else(|_| refuse())
}

/// `%20` and friends, which the webview adds on the way out.
fn percent_decode(text: &str) -> Result<String, std::str::Utf8Error> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3])?;
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    std::str::from_utf8(&out).map(str::to_owned)
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
        let harnesses = pantheon_probe::probe_all(&env);
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

/// A folder added as a project, and whether it was already one.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedProject {
    project: Project,
    /// False when the folder was already in the list and that project was
    /// selected instead of a duplicate being made.
    created: bool,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn open_project(state: State<'_, AppState>, path: String) -> Result<OpenedProject, String> {
    open_project_inner(&state, &path)
}

fn open_project_inner(state: &AppState, path: &str) -> Result<OpenedProject, String> {
    let root = PathBuf::from(path);
    if !root.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let (project, created) = state
        .store
        .add_project(&root)
        .map_err(|e| fail("could not open that project", e))?;

    Ok(OpenedProject { project, created })
}

/// Renames a project in Pantheon. Never renames or moves its folder.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn rename_project(
    state: State<'_, AppState>,
    project_id: String,
    name: String,
) -> Result<Project, String> {
    state
        .store
        .rename_project(&project_id, &name)
        .map_err(|e| fail("could not rename that project", e))
}

/// Starts a conversation with no codebase behind it.
///
/// A project, in every way the rest of the app cares about, except that it has
/// no folder: nothing is read from disk that was not typed into the box. This
/// is the thing you reach for to ask a question, rather than opening a
/// codebase you do not need and paying for its context to answer it.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn new_chat(state: State<'_, AppState>) -> Result<Project, String> {
    state
        .store
        .create_rootless_project("New chat")
        .map_err(|e| fail("could not start a new chat", e))
}

/// Opens a project pantheon already knows about, by id.
///
/// The rail has the whole row in hand, so it has no reason to hand back a path
/// and make the host look it up again -- and a project with no folder has no
/// path to hand back in the first place.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn open_stored_project(state: State<'_, AppState>, project_id: String) -> Result<Project, String> {
    state
        .store
        .touch_project(&project_id)
        .map_err(|e| fail("could not open that project", e))
}

/// Writes the order a rail was dragged into, top first.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn reorder_projects(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state
        .store
        .reorder_projects(&ids)
        .map_err(|e| fail("could not save that order", e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn reorder_sessions(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), String> {
    state
        .store
        .reorder_sessions(&ids)
        .map_err(|e| fail("could not save that order", e))
}

/// Forgets chats that were started and never used.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn prune_chats(state: State<'_, AppState>, keep: String) -> Result<usize, String> {
    state
        .store
        .prune_empty_chats(&keep)
        .map_err(|e| fail("could not tidy up empty chats", e))
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

/// Projects with their session counts, for the projects screen.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    #[serde(flatten)]
    project: Project,
    session_count: i64,
    /// False when the folder has been moved or deleted since it was opened.
    exists: bool,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn list_project_summaries(state: State<'_, AppState>) -> Result<Vec<ProjectSummary>, String> {
    let projects = state
        .store
        .list_projects()
        .map_err(|e| fail("could not list projects", e))?;
    let counts = state.store.session_counts().unwrap_or_default();

    Ok(projects
        .into_iter()
        .map(|project| ProjectSummary {
            session_count: counts
                .iter()
                .find(|(id, _)| *id == project.id)
                .map_or(0, |(_, n)| *n),
            // Told plainly rather than discovered when a session fails to
            // start in a folder that is no longer there. A project with no
            // folder has nothing that can go missing.
            exists: project
                .root
                .as_ref()
                .is_none_or(|root| PathBuf::from(root).is_dir()),
            project,
        })
        .collect())
}

/// Forgets a project and every conversation Pantheon stored for it.
///
/// Only Pantheon's records go. The folder, its files and the providers' own
/// session records are never touched; nothing here deletes from disk.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn remove_project(state: State<'_, AppState>, project_id: String) -> Result<(), String> {
    remove_project_inner(&state, &project_id)
}

fn remove_project_inner(state: &AppState, project_id: &str) -> Result<(), String> {
    // Stop anything running in it first, or its CLI would outlive the rows.
    if let Ok(sessions) = state.store.list_sessions(project_id) {
        if let Ok(mut live) = state.live.lock() {
            for session in sessions {
                live.remove(&session.id);
            }
        }
    }
    state
        .store
        .delete_project(project_id)
        .map_err(|e| fail("could not remove that project", e))
}

// ------------------------------------------------------------------- models

/// How long a cached model list is trusted before being refreshed.
const CATALOG_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// Bumped whenever pantheon changes how it reads a CLI's answer.
///
/// The cache holds the *parsed* catalog, not the raw reply, so a change to the
/// parsing does not show up until the entry expires a day later. That is how a
/// fix to the model names shipped and then appeared not to have: the labels on
/// screen were the ones written into the cache by the previous build.
///
/// The CLI version already stamps the cache from the other direction. This is
/// the same idea pointed at ourselves.
const CATALOG_FORMAT: u32 = 3;

fn catalog_key(harness: HarnessId) -> String {
    format!("catalog:{CATALOG_FORMAT}:{harness}")
}

/// Lists the models a harness can run.
///
/// Served from cache unless `refresh` is set, the cache is older than a day,
/// or the CLI has been upgraded since it was written. A new CLI version is the
/// most likely reason a model is missing, so its version stamps the cache.
#[tauri::command]
async fn list_models(
    state: State<'_, AppState>,
    harness: String,
    refresh: bool,
) -> Result<ModelCatalog, String> {
    let harness = parse_harness(&harness)?;

    let env = EnvSnapshot::capture();
    let status = pantheon_probe::probe_one(harness, &env);
    let InstallState::Found { path, version } = &status.install else {
        return Err(format!(
            "{} is not available: {}",
            status.label,
            status
                .hint
                .map_or_else(|| "unknown reason".to_owned(), |h| h.message)
        ));
    };
    let version = version.to_string();

    if !refresh {
        if let Some(cached) = cached_catalog(&state.store, harness, &version) {
            return Ok(cached);
        }
    }

    let path = path.clone();
    let store = Arc::clone(&state.store);
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let stamp = version.clone();

    let catalog = tauri::async_runtime::spawn_blocking(move || {
        pantheon_catalog::probe(harness, std::path::Path::new(&path), &cwd, &stamp)
    })
    .await
    .map_err(|e| fail("the model probe did not finish", e))?
    .map_err(|e| fail("could not list models", e))?;

    if let Ok(json) = serde_json::to_string(&catalog) {
        let _ = store.set_setting("catalog", "", &catalog_key(harness), &json);
    }
    Ok(catalog)
}

/// Returns a cached list, if it is still trustworthy.
fn cached_catalog(
    store: &pantheon_store::Store,
    harness: HarnessId,
    version: &str,
) -> Option<ModelCatalog> {
    let raw = store.setting("catalog", "", &catalog_key(harness)).ok()??;
    let catalog: ModelCatalog = serde_json::from_str(&raw).ok()?;

    if catalog.cli_version != version {
        return None;
    }
    if pantheon_store::now_ms() - catalog.fetched_at_ms > CATALOG_TTL_MS {
        return None;
    }
    Some(catalog)
}

/// How wide each rail is, in pixels.
///
/// Kept together in one setting because they are read and written together,
/// and a layout half-restored is worse than one not restored at all.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct RailWidths {
    projects: f64,
    chats: f64,
}

/// What the rails are without a saved answer, matching the stylesheet.
const RAIL_DEFAULTS: RailWidths = RailWidths {
    projects: 198.0,
    chats: 248.0,
};

/// Narrow enough to be a list, wide enough to still be one.
const RAIL_MIN: f64 = 150.0;
const RAIL_MAX: f64 = 460.0;

impl RailWidths {
    fn clamped(self) -> Self {
        let fix = |value: f64| {
            if value.is_finite() {
                value.clamp(RAIL_MIN, RAIL_MAX)
            } else {
                RAIL_DEFAULTS.projects
            }
        };
        Self {
            projects: fix(self.projects),
            chats: fix(self.chats),
        }
    }
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn rail_widths(state: State<'_, AppState>) -> RailWidths {
    state
        .store
        .setting("ui", "", "rail_widths")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<RailWidths>(&raw).ok())
        .map_or(RAIL_DEFAULTS, RailWidths::clamped)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn set_rail_widths(state: State<'_, AppState>, widths: RailWidths) -> Result<(), String> {
    let value =
        serde_json::to_string(&widths.clamped()).map_err(|e| fail("could not save that", e))?;
    state
        .store
        .set_setting("ui", "", "rail_widths", &value)
        .map_err(|e| fail("could not save that", e))
}

/// The model a new conversation starts with.
///
/// Stored as `harness/model/effort`, because all three travel together: an
/// effort level belongs to a model and a model belongs to a CLI, so keeping
/// them in separate settings would let them drift into a combination that
/// cannot run.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelChoice {
    harness: HarnessId,
    model: String,
    effort: Option<String>,
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn default_model(state: State<'_, AppState>) -> Option<ModelChoice> {
    let raw = state.store.setting("ui", "", "default_model").ok()??;
    serde_json::from_str(&raw).ok()
}

/// Sets, or with `None` clears, the model a new conversation starts with.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn set_default_model(
    state: State<'_, AppState>,
    choice: Option<ModelChoice>,
) -> Result<(), String> {
    let value = match &choice {
        Some(choice) => {
            serde_json::to_string(choice).map_err(|e| fail("could not save that", e))?
        }
        // Cleared rather than deleted: the settings table is keyed, and an
        // empty value reads back as "nothing chosen" through the same path.
        None => String::new(),
    };
    state
        .store
        .set_setting("ui", "", "default_model", &value)
        .map_err(|e| fail("could not save that", e))
}

/// Models the user has starred, newest first.
///
/// Kept per harness, in the settings table, rather than in the catalog: the
/// catalog is a cache of what the CLI reports and is thrown away whenever the
/// CLI is upgraded, which is not a reason to lose a preference.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn favourite_models(state: State<'_, AppState>, harness: String) -> Result<Vec<String>, String> {
    let harness = parse_harness(&harness)?;
    Ok(read_favourites(&state.store, harness))
}

/// Stars a model, or unstars one already starred. Returns the new list.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn toggle_favourite_model(
    state: State<'_, AppState>,
    harness: String,
    model: String,
) -> Result<Vec<String>, String> {
    let harness = parse_harness(&harness)?;
    let mut ids = read_favourites(&state.store, harness);

    if let Some(at) = ids.iter().position(|id| *id == model) {
        ids.remove(at);
    } else {
        ids.push(model);
    }

    let json = serde_json::to_string(&ids).map_err(|e| fail("could not save that", e))?;
    state
        .store
        .set_setting("favourites", "", &favourites_key(harness), &json)
        .map_err(|e| fail("could not save that", e))?;
    Ok(ids)
}

fn favourites_key(harness: HarnessId) -> String {
    format!("models:{harness}")
}

/// A preference is not worth an error banner, so a failure reads as "none".
fn read_favourites(store: &pantheon_store::Store, harness: HarnessId) -> Vec<String> {
    store
        .setting("favourites", "", &favourites_key(harness))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn parse_harness(raw: &str) -> Result<HarnessId, String> {
    match raw {
        "claude" => Ok(HarnessId::Claude),
        "codex" => Ok(HarnessId::Codex),
        other => Err(format!("unknown harness {other}")),
    }
}

// --------------------------------------------------------------- appearance

/// Image types the background accepts. Anything else is refused by name
/// rather than copied and silently failing to render.
const IMAGE_TYPES: [(&str, &str); 6] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
];

/// How the window is painted. Anything else is refused rather than stored and
/// silently ignored by the frontend.
const THEMES: [&str; 6] = [
    "system",
    "light",
    "dark",
    "nord",
    "catppuccin-mocha",
    "solarized-light",
];

/// The chosen theme, defaulting to following the OS.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn theme(state: State<'_, AppState>) -> String {
    state
        .store
        .setting("ui", "", "theme")
        .ok()
        .flatten()
        .filter(|value| THEMES.contains(&value.as_str()))
        .unwrap_or_else(|| "system".to_owned())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn set_theme(state: State<'_, AppState>, theme: String) -> Result<(), String> {
    if !THEMES.contains(&theme.as_str()) {
        return Err(format!("{theme} is not a theme Pantheon has"));
    }
    state
        .store
        .set_setting("ui", "", "theme", &theme)
        .map_err(|e| fail("could not save that", e))
}

/// How far the window is zoomed, as a factor. 1 is unscaled.
///
/// Stored rather than left to the webview's own Ctrl+/- handling, because the
/// reason to change it is usually the monitor, and a monitor does not change
/// between launches.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn zoom(state: State<'_, AppState>) -> f64 {
    state
        .store
        .setting("ui", "", "zoom")
        .ok()
        .flatten()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|factor| (ZOOM_MIN..=ZOOM_MAX).contains(factor))
        .unwrap_or(1.0)
}

/// The range the window is legible in. Below the floor the chrome stops being
/// clickable; above the ceiling the three panes no longer fit side by side.
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 2.5;

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn set_zoom(state: State<'_, AppState>, factor: f64) -> Result<f64, String> {
    if !factor.is_finite() {
        return Err("that is not a zoom level".to_owned());
    }
    let clamped = factor.clamp(ZOOM_MIN, ZOOM_MAX);
    state
        .store
        .set_setting("ui", "", "zoom", &clamped.to_string())
        .map_err(|e| fail("could not save that", e))?;
    Ok(clamped)
}

/// Opens the picker for a background image. `None` means the user cancelled.
#[tauri::command]
async fn pick_image(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Images", &IMAGE_TYPES.map(|(ext, _)| ext))
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| fail("the image picker failed", e))?;

    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Opens the picker for files to attach to a message, and keeps a checked
/// copy of each. Cancelling attaches nothing.
#[tauri::command]
async fn pick_attachments(app: tauri::AppHandle) -> Result<attachments::Picked, String> {
    use tauri_plugin_dialog::DialogExt;

    let root = attachments::root()
        .ok_or_else(|| "attachments are not available".to_owned())?
        .to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Attach pictures or text documents")
        .add_filter(
            "Pictures and text documents",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "txt", "md", "markdown", "csv", "tsv", "json",
                "jsonl", "yaml", "yml", "toml", "xml", "html", "css", "js", "jsx", "ts", "tsx",
                "py", "rs", "go", "java", "kt", "c", "h", "cpp", "hpp", "cs", "rb", "php", "swift",
                "sh", "ps1", "bat", "sql", "log", "ini", "cfg", "conf",
            ],
        )
        .add_filter("Pictures", &["png", "jpg", "jpeg", "gif", "webp"])
        .add_filter("All files", &["*"])
        .pick_files(move |picked| {
            let _ = tx.send(picked);
        });
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = attachments::Picked::default();
        for file in rx.recv().ok().flatten().unwrap_or_default() {
            let Ok(path) = file.into_path() else {
                continue;
            };
            match attachments::import(&root, &path) {
                Ok(attachment) => result.attached.push(attachment),
                Err(reason) => result.refused.push(reason),
            }
        }
        result
    })
    .await
    .map_err(|e| fail("the file picker failed", e))
}

/// The empty working directory for a conversation with no codebase.
///
/// One per project rather than one shared, so two chats cannot see each
/// other's leftovers.
fn scratch_dir(app: &tauri::AppHandle, project_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| fail("could not find where to keep it", e))?
        .join("chats")
        .join(project_id);
    std::fs::create_dir_all(&dir).map_err(|e| fail("could not create a working folder", e))?;
    Ok(dir)
}

fn background_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| fail("could not find where to keep it", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| fail("could not create the data folder", e))?;
    Ok(dir)
}

/// Adopts an image as the background.
///
/// The file is copied into pantheon's own folder rather than referenced where it
/// lies. A background that vanishes because the picture was moved out of
/// Downloads is a puzzle the user should never have to solve.
#[tauri::command]
async fn set_background(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    let source = PathBuf::from(&path);
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();

    let Some((_, mime)) = IMAGE_TYPES.iter().find(|(ext, _)| *ext == extension) else {
        return Err(format!(
            "{extension} is not an image Pantheon can show. Use a PNG, JPEG, WebP, GIF or BMP."
        ));
    };

    let dir = background_dir(&app)?;
    let destination = dir.join(format!("background.{extension}"));

    // Clear any previous one first, or a PNG left behind would outlive the JPEG
    // that replaced it.
    remove_backgrounds(&dir);
    std::fs::copy(&source, &destination).map_err(|e| fail("could not copy that image", e))?;

    state
        .store
        .set_setting("ui", "", "background", &format!("background.{extension}"))
        .map_err(|e| fail("could not remember that", e))?;

    read_background(&destination, mime)
}

/// The background as a data URL, or `None` if there is not one.
///
/// A data URL rather than a file URL because the webview's content policy
/// already allows `data:`; serving it over the asset protocol would mean
/// granting the window filesystem reach it otherwise has no use for.
// Tauri resolves these by value; the signature is not ours to choose.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn background(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let Ok(Some(name)) = state.store.setting("ui", "", "background") else {
        return Ok(None);
    };
    let extension = name.rsplit('.').next().unwrap_or_default().to_owned();
    let Some((_, mime)) = IMAGE_TYPES.iter().find(|(ext, _)| *ext == extension) else {
        return Ok(None);
    };

    let path = background_dir(&app)?.join(&name);
    if !path.is_file() {
        return Ok(None);
    }
    read_background(&path, mime).map(Some)
}

// Tauri resolves these by value; the signature is not ours to choose.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn clear_background(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(dir) = background_dir(&app) {
        remove_backgrounds(&dir);
    }
    state
        .store
        .set_setting("ui", "", "background", "")
        .map_err(|e| fail("could not forget that", e))
}

fn remove_backgrounds(dir: &std::path::Path) {
    for (extension, _) in IMAGE_TYPES {
        let _ = std::fs::remove_file(dir.join(format!("background.{extension}")));
    }
}

fn read_background(path: &std::path::Path, mime: &str) -> Result<String, String> {
    use base64::Engine as _;

    let bytes = std::fs::read(path).map_err(|e| fail("could not read that image", e))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
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
    parse_harness(&harness)?;
    state
        .store
        .create_session(&project_id, &harness, None)
        .map_err(|e| fail("could not create a session", e))
}

/// Forgets one conversation and its transcript.
///
/// Pantheon's copy only: project files are never touched, and the provider's own
/// session record stays with the provider.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    // Stop the CLI first, or it outlives the rows it was writing into.
    if let Ok(mut live) = state.live.lock() {
        live.remove(&session_id);
    }
    state
        .store
        .delete_session(&session_id)
        .map_err(|e| fail("could not delete that chat", e))
}

/// Renames a chat. Pantheon's title only; neither CLI is asked to rename.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn rename_session(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<SessionRow, String> {
    state
        .store
        .rename_session(&session_id, &title)
        .map_err(|e| fail("could not rename that chat", e))
}

/// Archives a chat, or restores it.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn archive_session(
    state: State<'_, AppState>,
    session_id: String,
    archived: bool,
) -> Result<SessionRow, String> {
    archive_session_inner(&state, &session_id, archived)
}

fn archive_session_inner(
    state: &AppState,
    session_id: &str,
    archived: bool,
) -> Result<SessionRow, String> {
    // An archived chat is put away, so its CLI is stopped like a closed one.
    // Its provider session id is kept; restoring and sending resumes it.
    if archived {
        if let Ok(mut live) = state.live.lock() {
            live.remove(session_id);
        }
    }
    state
        .store
        .set_session_archived(session_id, archived)
        .map_err(|e| fail("could not archive that chat", e))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn session_blocks(state: State<'_, AppState>, session_id: String) -> Result<Vec<Block>, String> {
    state
        .store
        .blocks(&session_id)
        .map_err(|e| fail("could not load the transcript", e))
}

fn parse_approval_mode(mode: &str) -> Result<ApprovalMode, String> {
    match mode {
        "ask" => Ok(ApprovalMode::Ask),
        "edits" => Ok(ApprovalMode::Edits),
        "auto" => Ok(ApprovalMode::Auto),
        _ => Err("Unknown approval mode".to_owned()),
    }
}

/// A conversation's permission choice. Automatic approval unless changed.
fn read_approval_mode(store: &Store, session_id: &str) -> Result<String, String> {
    store
        .setting("session", session_id, "approval_mode")
        .map(|value| value.unwrap_or_else(|| "auto".to_owned()))
        .map_err(|e| fail("could not read permissions", e))
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn get_approval_mode(state: State<'_, AppState>, session_id: String) -> Result<String, String> {
    read_approval_mode(&state.store, &session_id)
}

#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
fn set_approval_mode(
    state: State<'_, AppState>,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    set_approval_mode_inner(&state, &session_id, &mode)
}

/// Saves the choice and applies it to the running CLI, including any request
/// already waiting that the new mode covers.
fn set_approval_mode_inner(state: &AppState, session_id: &str, mode: &str) -> Result<(), String> {
    let parsed = parse_approval_mode(mode)?;
    state
        .store
        .session(session_id)
        .map_err(|e| fail("no such session", e))?;
    state
        .store
        .set_setting("session", session_id, "approval_mode", mode)
        .map_err(|e| fail("could not save permissions", e))?;
    let live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    if let Some(entry) = live.get(session_id) {
        if entry.session.is_alive() && !entry.session.set_approval_mode(parsed) {
            return Err("the agent stopped".to_owned());
        }
    }
    Ok(())
}

/// Starts the CLI for a session, if it is not already running.
///
/// Idempotent: the frontend calls this whenever it opens a session, and a
/// session that is already live just stays live.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
async fn start_session(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        start_session_inner(app.clone(), &state, &session_id)
    })
    .await
    .map_err(|error| fail("could not start the agent", error))?
}

/// One gate per session, so concurrent opens cannot launch two engines while
/// the shared registry stays free during slow probing and spawning.
fn start_gate(session_id: &str) -> Arc<Mutex<()>> {
    static GATES: std::sync::OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
        std::sync::OnceLock::new();
    GATES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_or_else(
            |_| Arc::new(Mutex::new(())),
            |mut gates| Arc::clone(gates.entry(session_id.to_owned()).or_default()),
        )
}

/// How long a successful CLI probe is reused when starting sessions. Every
/// probe launches the CLI, and an npm shim boots Node before it answers.
const PROBE_REUSE: std::time::Duration = std::time::Duration::from_secs(60);

fn session_probe(harness: HarnessId) -> pantheon_core::HarnessStatus {
    static PROBES: Mutex<Vec<(HarnessId, std::time::Instant, pantheon_core::HarnessStatus)>> =
        Mutex::new(Vec::new());
    if let Ok(probes) = PROBES.lock() {
        if let Some((_, _, status)) = probes
            .iter()
            .find(|(id, at, _)| *id == harness && at.elapsed() < PROBE_REUSE)
        {
            return status.clone();
        }
    }
    let status = pantheon_probe::probe_one(harness, &EnvSnapshot::capture());
    // Only a found CLI is reused; a missing one is looked for again next time.
    if matches!(status.install, InstallState::Found { .. }) {
        if let Ok(mut probes) = PROBES.lock() {
            probes.retain(|(id, _, _)| *id != harness);
            probes.push((harness, std::time::Instant::now(), status.clone()));
        }
    }
    status
}

fn start_session_inner(
    app: tauri::AppHandle,
    state: &AppState,
    session_id: &str,
) -> Result<(), String> {
    // Replace exited engines without replaying user work.
    let gate = start_gate(session_id);
    let _starting = gate
        .lock()
        .map_err(|_| "a session start was poisoned".to_owned())?;
    {
        let mut live = state
            .live
            .lock()
            .map_err(|_| "the session registry was poisoned".to_owned())?;
        if live
            .get(session_id)
            .is_some_and(|entry| entry.session.is_alive())
        {
            return Ok(());
        }
        live.remove(session_id);
    }

    let row = state
        .store
        .session(session_id)
        .map_err(|e| fail("no such session", e))?;
    let project = state
        .store
        .list_projects()
        .map_err(|e| fail("could not read projects", e))?
        .into_iter()
        .find(|p| p.id == row.project_id)
        .ok_or_else(|| "the session's project is missing".to_owned())?;

    let harness = parse_harness(&row.harness)?;

    // Resolve the binary the same way the Agents screen does, so a session
    // cannot start against something the user was told is unavailable.
    let status = session_probe(harness);
    let InstallState::Found { path, .. } = &status.install else {
        let hint = status
            .hint
            .map_or_else(|| "it is not available".to_owned(), |h| h.message);
        return Err(format!("{} cannot run: {hint}", status.label));
    };

    // A project with a folder runs in it. One without still needs a working
    // directory -- the CLIs demand one, and anything the agent writes has to
    // land somewhere -- so it gets an empty folder of its own under pantheon's
    // data directory. Deliberately not the user's home or the app's install
    // dir: the whole promise of a chat with no codebase is that there is
    // nothing around it to read.
    let cwd = match &project.root {
        Some(root) => PathBuf::from(root),
        None => scratch_dir(&app, &project.id)?,
    };
    let mut spec = SessionSpec::new(harness, path, &cwd);
    spec.approval_mode = parse_approval_mode(&read_approval_mode(&state.store, session_id)?)?;
    // Explicit recovery asked for fresh provider context; the saved Pantheon
    // transcript is untouched and nothing is replayed.
    if state
        .store
        .setting("session", session_id, "fresh_context")
        .map_err(|e| fail("could not read recovery state", e))?
        .as_deref()
        != Some("true")
    {
        spec.resume.clone_from(&row.provider_session);
    }
    spec.model.clone_from(&row.model);
    spec.effort.clone_from(&row.effort);

    let (session, events) =
        Session::start(&spec).map_err(|e| fail("could not start the agent", e))?;

    state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?
        .insert(session_id.to_owned(), Live { session });
    sessions::pump(app, Arc::clone(&state.store), session_id.to_owned(), events);

    Ok(())
}

/// Sends the user's message straight to the conversation's CLI.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn send_turn(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    attachments: Option<Vec<String>>,
) -> Result<i64, String> {
    send_turn_inner(
        &state,
        &session_id,
        &text,
        attachments.as_deref().unwrap_or_default(),
    )
}

/// Asks the chat's own agent for a short title, in the background.
///
/// The first-line title is already showing; this only improves it, and only
/// if nobody renamed the chat meanwhile. The window is told so the sidebar and
/// tab update without waiting for the reply to finish.
fn name_chat(state: &AppState, session_id: &str, message: &str) {
    let Some(retitled) = state.retitled.get().cloned() else {
        return;
    };
    let Ok(row) = state.store.session(session_id) else {
        return;
    };
    let Some(first_line) = row.title.clone() else {
        return;
    };
    let Ok(harness) = parse_harness(&row.harness) else {
        return;
    };
    let store = Arc::clone(&state.store);
    let session_id = session_id.to_owned();
    let message = message.to_owned();
    std::thread::spawn(move || {
        let status = session_probe(harness);
        let InstallState::Found { path, .. } = &status.install else {
            return;
        };
        let Some(title) = titles::generate(harness, Path::new(path), &message) else {
            return;
        };
        if store
            .replace_title_if(&session_id, &first_line, &title)
            .unwrap_or(false)
        {
            retitled(&session_id, &row.project_id, &title);
        }
    });
}

fn send_turn_inner(
    state: &AppState,
    session_id: &str,
    text: &str,
    attached: &[String],
) -> Result<i64, String> {
    let trimmed = text.trim_end();
    if attached.len() > attachments::MAX_PER_MESSAGE {
        return Err(format!(
            "attach at most {} files to one message",
            attachments::MAX_PER_MESSAGE
        ));
    }
    // Checked and read before anything is saved, so a missing file is
    // reported instead of half a message.
    let loaded = if attached.is_empty() {
        Vec::new()
    } else {
        let root = attachments::root().ok_or_else(|| "attachments are not available".to_owned())?;
        attached
            .iter()
            .map(|path| attachments::resolve(root, path))
            .collect::<Result<Vec<_>, _>>()?
    };
    if trimmed.is_empty() && loaded.is_empty() {
        return Err("nothing to send".to_owned());
    }

    // The user's message is persisted before it is sent, so a crash between
    // the two does not lose what they typed.
    let seq = state
        .store
        .append_block(session_id, pantheon_core::BlockKind::User, trimmed)
        .map_err(|e| fail("could not save your message", e))?;
    let shown: Vec<attachments::Attachment> = loaded.iter().map(|l| l.attachment.clone()).collect();
    if let Some(meta) = attachments::block_meta(&shown) {
        let _ = state.store.set_block_meta(session_id, seq, &meta);
    }
    // A message that is only attachments is named after the first of them.
    let headline = if trimmed.is_empty() {
        shown.first().map_or("Attachments", |a| a.name.as_str())
    } else {
        trimmed
    };
    let first = state
        .store
        .session(session_id)
        .is_ok_and(|row| row.title.as_deref().is_none_or(str::is_empty));
    let _ = state.store.set_title_if_unset(session_id, headline);
    if first {
        name_chat(state, session_id, headline);
    }
    // Writing in an archived chat is a decision to carry on with it.
    if state
        .store
        .session(session_id)
        .is_ok_and(|row| row.archived_at.is_some())
    {
        let _ = state.store.set_session_archived(session_id, false);
    }

    let live = state
        .live
        .lock()
        .map_err(|_| "the session registry was poisoned".to_owned())?;
    let session = live
        .get(session_id)
        .ok_or_else(|| "that session is not running".to_owned())?;

    if session
        .session
        .send_input(attachments::turn_input(trimmed, &loaded))
    {
        Ok(seq)
    } else {
        Err("the agent stopped accepting input".to_owned())
    }
}

/// Changes the model a session uses from now on.
///
/// Claude takes the model as a launch flag, so the CLI is restarted. History
/// is not lost: the session resumes by its provider id, which was recorded the
/// first time it started.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
async fn set_session_model(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    model: String,
    effort: Option<String>,
) -> Result<(), String> {
    state
        .store
        .set_model_choice(&session_id, &model, effort.as_deref())
        .map_err(|e| fail("could not save the model choice", e))?;

    {
        let mut live = state
            .live
            .lock()
            .map_err(|_| "the session registry was poisoned".to_owned())?;
        // Dropping it kills the CLI and its process tree.
        live.remove(&session_id);
    }

    start_session(app, session_id).await
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

/// Explicitly replace provider context, retaining the saved Pantheon transcript.
/// No user request is replayed and the harness/model choices stay unchanged.
#[tauri::command]
async fn restart_session_thread(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state
            .store
            .session(&session_id)
            .map_err(|e| fail("no such session", e))?;
        state
            .live
            .lock()
            .map_err(|_| "Session registry poisoned")?
            .remove(&session_id);
        state
            .store
            .set_setting("session", &session_id, "fresh_context", "true")
            .map_err(|e| fail("could not save recovery state", e))?;
        start_session_inner(app.clone(), &state, &session_id)
    })
    .await
    .map_err(|error| fail("could not restart agent context", error))?
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
/// A failure here is not fatal: pantheon falls back to an in-memory store so the
/// user can still talk to an agent, and says so rather than refusing to start.
fn open_store(app: &tauri::App) -> (Arc<Store>, Option<String>) {
    // Keep the deployed filename: renaming a live SQLite WAL database can lose
    // recent writes and would hide existing projects, chats and appearance.
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
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.try_state::<dictation::DictationState>() {
                    state.cancel_all();
                }
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Pictures reach the webview as bytes over their own scheme rather
        // than as base64 in the transcript. A 3MB render becomes 4MB of text
        // in the database, in memory and across IPC if you inline it, and it
        // has to be re-sent every time the row re-renders.
        .register_uri_scheme_protocol("pantheon", |_app, request| {
            picture_response(request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            dictation::dictation_status,
            dictation::dictation_start,
            dictation::dictation_finish,
            dictation::dictation_cancel,
            harness_snapshot,
            harness_rescan,
            pick_folder,
            pick_image,
            pick_attachments,
            theme,
            set_theme,
            zoom,
            set_zoom,
            default_model,
            set_default_model,
            rail_widths,
            set_rail_widths,
            set_background,
            background,
            clear_background,
            open_project,
            open_stored_project,
            new_chat,
            prune_chats,
            reorder_projects,
            reorder_sessions,
            list_projects,
            prune_sessions,
            list_project_summaries,
            remove_project,
            rename_project,
            list_models,
            favourite_models,
            toggle_favourite_model,
            set_session_model,
            list_sessions,
            create_session,
            session_blocks,
            delete_session,
            rename_session,
            archive_session,
            start_session,
            get_approval_mode,
            set_approval_mode,
            send_turn,
            respond_approval,
            cancel_turn,
            stop_session,
            restart_session_thread,
            search,
        ])
        .setup(|app| {
            app.manage(dictation::DictationState::default());
            app.get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;

            let (store, warning) = open_store(app);
            if let Some(warning) = &warning {
                eprintln!("pantheon: {warning}");
            }
            attachments::prepare(app.path().app_data_dir().ok());

            app.manage(AppState {
                scan: Mutex::new(None),
                store,
                live: Arc::new(Mutex::new(HashMap::new())),
                retitled: std::sync::OnceLock::new(),
            });
            let handle = app.handle().clone();
            let sink: TitleSink = Arc::new(move |session_id, project_id, title| {
                use tauri::Emitter;
                let _ = handle.emit(
                    "pantheon://session-title",
                    serde_json::json!({ "sessionId": session_id, "projectId": project_id, "title": title }),
                );
            });
            let _ = app.state::<AppState>().retitled.set(sink);
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        // There is no window to show this in, and a release build has no
        // console attached either, so the exit code is the real signal. The
        // message is here for `cargo run` and for a crash reporter later.
        eprintln!("Pantheon could not start: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{picture_mime, servable_picture};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn state(store: pantheon_store::Store, live: HashMap<String, super::Live>) -> super::AppState {
        super::AppState {
            scan: std::sync::Mutex::new(None),
            store: std::sync::Arc::new(store),
            live: std::sync::Mutex::new(live).into(),
            retitled: std::sync::OnceLock::new(),
        }
    }

    /// A fake Claude CLI that records the frame it is sent, then replies.
    #[cfg(windows)]
    fn recording_claude(folder: &Path, frames: &str) -> PathBuf {
        std::fs::create_dir_all(folder).unwrap();
        std::fs::write(folder.join("frames.jsonl"), frames).unwrap();
        let binary = folder.join("claude.cmd");
        std::fs::write(
            &binary,
            "@echo off\r\nset /p turn=\r\n>\"%~dp0turn.txt\" echo(%turn%\r\ntype \"%~dp0frames.jsonl\"\r\nset /p answer=\r\n",
        )
        .unwrap();
        binary
    }

    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("pantheon-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn adding_a_folder_twice_selects_the_existing_project() {
        let folder = scratch("add-twice");
        let state = state(pantheon_store::Store::in_memory().unwrap(), HashMap::new());

        let first = super::open_project_inner(&state, folder.to_str().unwrap()).unwrap();
        assert!(first.created);
        let again = super::open_project_inner(&state, &format!("{}\\", folder.display())).unwrap();
        assert!(!again.created, "the same folder is not added twice");
        assert_eq!(again.project.id, first.project.id);
        assert_eq!(state.store.list_projects().unwrap().len(), 1);

        assert!(
            super::open_project_inner(&state, &folder.join("missing").display().to_string())
                .is_err(),
            "a path that is not a folder is refused"
        );
        let _ = std::fs::remove_dir_all(folder);
    }

    #[test]
    fn removing_a_project_keeps_its_folder_and_files() {
        let folder = scratch("remove-project");
        std::fs::write(folder.join("notes.md"), "mine").unwrap();
        let state = state(pantheon_store::Store::in_memory().unwrap(), HashMap::new());
        let opened = super::open_project_inner(&state, folder.to_str().unwrap()).unwrap();
        let chat = state
            .store
            .create_session(&opened.project.id, "codex", None)
            .unwrap();
        state
            .store
            .append_block(&chat.id, pantheon_core::BlockKind::User, "hello")
            .unwrap();

        super::remove_project_inner(&state, &opened.project.id).unwrap();

        assert_eq!(state.store.list_projects().unwrap().len(), 0);
        assert!(state.store.session(&chat.id).is_err());
        assert!(folder.is_dir(), "the folder stays on disk");
        assert_eq!(
            std::fs::read_to_string(folder.join("notes.md")).unwrap(),
            "mine"
        );
        let _ = std::fs::remove_dir_all(folder);
    }

    #[cfg(windows)]
    #[test]
    fn archiving_stops_a_chat_and_writing_in_it_restores_it() {
        use pantheon_core::{HarnessId, SessionEvent};
        use pantheon_engine::{Session, SessionSpec};
        use std::time::Duration;
        let folder = scratch("archive");
        let frames = "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake\"}\n{\"type\":\"result\",\"stop_reason\":\"end_turn\",\"is_error\":false}\n";
        let binary = recording_claude(&folder, frames);
        let store = pantheon_store::Store::in_memory().unwrap();
        let project = store.open_project(&folder).unwrap();
        let row = store.create_session(&project.id, "claude", None).unwrap();
        let spec = SessionSpec::new(HarnessId::Claude, &binary, &folder);
        let (session, _events) = Session::start(&spec).unwrap();
        let state = state(
            store,
            HashMap::from([(row.id.clone(), super::Live { session })]),
        );

        let archived = super::archive_session_inner(&state, &row.id, true).unwrap();
        assert!(archived.archived_at.is_some());
        assert!(
            !state.live.lock().unwrap().contains_key(&row.id),
            "an archived chat's CLI is stopped"
        );

        let (session, events) = Session::start(&spec).unwrap();
        state
            .live
            .lock()
            .unwrap()
            .insert(row.id.clone(), super::Live { session });
        super::send_turn_inner(&state, &row.id, "Carry on", &[]).unwrap();
        loop {
            if matches!(
                events.recv_timeout(Duration::from_secs(5)).unwrap(),
                SessionEvent::TurnEnded { .. }
            ) {
                break;
            }
        }
        assert_eq!(
            state.store.session(&row.id).unwrap().archived_at,
            None,
            "sending a message brings the chat back to the list"
        );
        let _ = std::fs::remove_dir_all(folder);
    }

    /// A picture attached in the window reaches the CLI as image content, and
    /// the saved message remembers it so reopening the chat shows it.
    #[cfg(windows)]
    #[test]
    fn an_attached_picture_reaches_the_cli_and_stays_on_the_message() {
        use pantheon_core::{HarnessId, SessionEvent};
        use pantheon_engine::{Session, SessionSpec};
        use std::time::Duration;
        let folder = scratch("attach-send");
        super::attachments::prepare(Some(
            std::env::temp_dir().join(format!("pantheon-attach-root-{}", std::process::id())),
        ));
        let root = super::attachments::root().unwrap().to_path_buf();
        std::fs::write(folder.join("cat.png"), b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR").unwrap();
        let attached = super::attachments::import(&root, &folder.join("cat.png")).unwrap();
        let binary = recording_claude(
            &folder,
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake\"}\n{\"type\":\"result\",\"stop_reason\":\"end_turn\",\"is_error\":false}\n",
        );
        let store = pantheon_store::Store::in_memory().unwrap();
        let project = store.create_rootless_project("Attach").unwrap();
        let row = store.create_session(&project.id, "claude", None).unwrap();
        let (session, events) =
            Session::start(&SessionSpec::new(HarnessId::Claude, &binary, &folder)).unwrap();
        let state = state(
            store,
            HashMap::from([(row.id.clone(), super::Live { session })]),
        );

        let seq = super::send_turn_inner(
            &state,
            &row.id,
            "What is this",
            std::slice::from_ref(&attached.path),
        )
        .unwrap();
        while !matches!(
            events.recv_timeout(Duration::from_secs(5)).unwrap(),
            SessionEvent::TurnEnded { .. }
        ) {}

        let frame: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(folder.join("turn.txt"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(frame["message"]["content"][0]["type"], "image");
        assert_eq!(frame["message"]["content"][1]["text"], "What is this");
        let block = state
            .store
            .blocks(&row.id)
            .unwrap()
            .into_iter()
            .find(|b| b.seq == seq)
            .unwrap();
        assert!(block.meta.unwrap().contains("cat.png"));

        // A path outside pantheon's attachments folder is refused before sending.
        let outside = folder.join("cat.png").to_string_lossy().into_owned();
        assert!(super::send_turn_inner(&state, &row.id, "again", &[outside]).is_err());
        let _ = std::fs::remove_dir_all(folder);
    }

    #[cfg(windows)]
    #[test]
    fn a_message_goes_straight_to_the_conversations_cli() {
        use pantheon_core::{HarnessId, SessionEvent};
        use pantheon_engine::{Session, SessionSpec};
        use std::time::Duration;
        let folder =
            std::env::temp_dir().join(format!("pantheon-direct-send-{}", std::process::id()));
        let binary = recording_claude(
            &folder,
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake\"}\n{\"type\":\"result\",\"stop_reason\":\"end_turn\",\"is_error\":false}\n",
        );
        let store = pantheon_store::Store::in_memory().unwrap();
        let project = store.create_rootless_project("Direct").unwrap();
        let row = store.create_session(&project.id, "claude", None).unwrap();
        let (session, events) =
            Session::start(&SessionSpec::new(HarnessId::Claude, &binary, &folder)).unwrap();
        let state = state(
            store,
            HashMap::from([(row.id.clone(), super::Live { session })]),
        );

        let seq = super::send_turn_inner(&state, &row.id, "Fix the heading\n", &[]).unwrap();
        loop {
            if matches!(
                events.recv_timeout(Duration::from_secs(5)).unwrap(),
                SessionEvent::TurnEnded { .. }
            ) {
                break;
            }
        }

        // Exactly what was typed, as the only content of one user frame.
        let frame: serde_json::Value = serde_json::from_str(
            std::fs::read_to_string(folder.join("turn.txt"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(frame["type"], "user");
        assert_eq!(
            frame["message"]["content"],
            serde_json::json!([{ "type": "text", "text": "Fix the heading" }])
        );
        let blocks = state.store.blocks(&row.id).unwrap();
        assert_eq!(blocks[0].seq, seq);
        assert_eq!(blocks[0].text, "Fix the heading");
        assert_eq!(
            state.store.session(&row.id).unwrap().title.as_deref(),
            Some("Fix the heading")
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_permission_change_applies_to_that_conversations_waiting_request() {
        use pantheon_core::{ApprovalOutcome, HarnessId, SessionEvent};
        use pantheon_engine::{Session, SessionSpec};
        use std::time::Duration;
        let folder =
            std::env::temp_dir().join(format!("pantheon-permission-test-{}", std::process::id()));
        let binary = recording_claude(&folder, concat!(
            "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake\"}\n",
            "{\"type\":\"control_request\",\"request_id\":\"edit\",\"request\":{\"subtype\":\"can_use_tool\",\"tool_name\":\"Write\",\"input\":{}}}\n"
        ));
        let store = pantheon_store::Store::in_memory().unwrap();
        let project = store.create_rootless_project("Permissions").unwrap();
        let chosen = store.create_session(&project.id, "claude", None).unwrap();
        let other = store.create_session(&project.id, "claude", None).unwrap();
        let mut live = HashMap::new();
        let mut receivers = Vec::new();
        for row in [&chosen, &other] {
            let (session, events) =
                Session::start(&SessionSpec::new(HarnessId::Claude, &binary, &folder)).unwrap();
            assert!(session.send("test"));
            loop {
                if matches!(
                    events.recv_timeout(Duration::from_secs(5)).unwrap(),
                    SessionEvent::ApprovalRequested { .. }
                ) {
                    break;
                }
            }
            live.insert(row.id.clone(), super::Live { session });
            receivers.push(events);
        }
        let state = state(store, live);
        super::set_approval_mode_inner(&state, &chosen.id, "edits").unwrap();
        loop {
            if let SessionEvent::ApprovalResolved { id, outcome } =
                receivers[0].recv_timeout(Duration::from_secs(5)).unwrap()
            {
                assert_eq!(id, "edit");
                assert_eq!(outcome, ApprovalOutcome::Allowed);
                break;
            }
        }
        // Another conversation's choice is its own.
        assert!(receivers[1]
            .recv_timeout(Duration::from_millis(100))
            .is_err());
    }

    #[test]
    fn permissions_default_to_automatic_and_belong_to_each_conversation() {
        let store = pantheon_store::Store::in_memory().unwrap();
        let project = store.create_rootless_project("Permissions").unwrap();
        let first = store.create_session(&project.id, "codex", None).unwrap();
        let second = store.create_session(&project.id, "claude", None).unwrap();
        let state = state(store, HashMap::new());
        for mode in ["edits", "ask", "auto"] {
            super::set_approval_mode_inner(&state, &first.id, mode).unwrap();
            assert_eq!(
                super::read_approval_mode(&state.store, &first.id).unwrap(),
                mode
            );
        }
        super::set_approval_mode_inner(&state, &first.id, "ask").unwrap();
        assert_eq!(
            super::read_approval_mode(&state.store, &second.id).unwrap(),
            "auto"
        );
        assert!(super::set_approval_mode_inner(&state, &first.id, "invalid").is_err());
        assert!(super::set_approval_mode_inner(&state, "missing", "auto").is_err());
    }

    /// A folder standing in for `~/.codex`, with a picture and a secret in it.
    fn sandbox() -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("pantheon-pictures-{}", std::process::id()));
        let inside = root.join("generated_images");
        std::fs::create_dir_all(&inside).expect("create");
        std::fs::write(inside.join("burger.png"), b"not really a png").expect("write");
        std::fs::write(inside.join("auth.json"), b"{}").expect("write");
        std::fs::write(root.join("secret.png"), b"x").expect("write");
        (root, inside)
    }

    #[test]
    fn a_picture_inside_an_allowed_root_is_served() {
        let (root, inside) = sandbox();
        let roots = vec![root.clone()];
        assert!(servable_picture(&inside.join("burger.png"), &roots).is_some());
    }

    /// The path comes out of model output. Everything here is something a
    /// transcript could claim, and none of it may be opened.
    #[test]
    fn nothing_outside_the_roots_is_served() {
        let (root, inside) = sandbox();
        let roots = vec![inside.clone()];

        assert!(
            servable_picture(&root.join("secret.png"), &roots).is_none(),
            "a sibling of the allowed folder is still outside it"
        );
        assert!(
            servable_picture(&inside.join("..").join("secret.png"), &roots).is_none(),
            "a prefix test alone would pass this; canonicalize is what stops it"
        );
        assert!(
            servable_picture(&inside.join("auth.json"), &roots).is_none(),
            "inside the root, but not a picture"
        );
        assert!(
            servable_picture(&inside.join("missing.png"), &roots).is_none(),
            "a path that names nothing"
        );
        assert!(
            servable_picture(&inside, &roots).is_none(),
            "a directory is not a file"
        );
        assert!(
            servable_picture(&inside.join("burger.png"), &[]).is_none(),
            "no roots means nothing is servable"
        );
    }

    #[test]
    fn only_extensions_a_browser_can_draw_have_a_type() {
        assert_eq!(picture_mime(Path::new("a/b.PNG")), Some("image/png"));
        assert_eq!(picture_mime(Path::new("a/b.jpeg")), Some("image/jpeg"));
        assert_eq!(picture_mime(Path::new("a/b.svg")), None, "scriptable");
        assert_eq!(picture_mime(Path::new("a/b.exe")), None);
        assert_eq!(picture_mime(Path::new("a/b")), None);
    }
}
