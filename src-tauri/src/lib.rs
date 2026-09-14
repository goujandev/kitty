//! The Tauri host.
//!
//! Slice 1's entire IPC surface is two commands. That is deliberate:
//! `MonoCode` registers 164 commands in one flat block, with a single
//! 6,550-line file holding 53 of them across four unrelated concerns
//! (ADR-0003). kitty keeps the surface narrow and grouped per crate.
//!
//! Nothing here probes a CLI during startup. `run()` builds the window and
//! returns; the frontend asks for a scan once it has painted, which is what
//! keeps cold start off the critical path of a slow `npm` shim.

use std::sync::Mutex;

use kitty_core::Scan;
use kitty_probe::EnvSnapshot;
use tauri::{Manager, State};

/// Last completed scan, so a reopened window or a re-render can render
/// something without paying for another probe.
#[derive(Default)]
struct Scans {
    latest: Mutex<Option<Scan>>,
}

/// Returns the last scan, or `None` if nothing has been scanned yet.
///
/// Cheap and synchronous: this is what the window calls on first paint.
// Tauri resolves `State` by value; the signature is not ours to choose.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
fn harness_snapshot(state: State<'_, Scans>) -> Option<Scan> {
    state.latest.lock().ok().and_then(|guard| guard.clone())
}

/// Runs a full scan and caches it.
///
/// Off the async runtime's worker threads, because discovery spawns child
/// processes and blocks on their output for up to fifteen seconds each.
#[tauri::command]
async fn harness_rescan(state: State<'_, Scans>) -> Result<Scan, String> {
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
    .map_err(|e| format!("the scan did not finish: {e}"))?;

    if let Ok(mut guard) = state.latest.lock() {
        *guard = Some(scan.clone());
    }
    Ok(scan)
}

/// Copying a hint's command to the clipboard is done in the frontend. The
/// webview runs on a localhost origin, which browsers treat as a secure
/// context, so the Clipboard API is available and a command here would only
/// add a hop.
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Scans::default())
        .invoke_handler(tauri::generate_handler![harness_snapshot, harness_rescan])
        .setup(|app| {
            // Make sure the window is real before the frontend starts talking
            // to us, and fail loudly rather than silently showing nothing.
            app.get_webview_window("main")
                .ok_or("the main window is missing from tauri.conf.json")?;
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
