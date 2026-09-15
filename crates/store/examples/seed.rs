//! Seeds a project and a session into kitty's database.
//!
//! ```text
//! cargo run -p kitty-store --example seed -- <db-path> <project-dir> [harness]
//! ```
//!
//! Exists so the app can be driven end to end without going through a native
//! folder dialog, which nothing can automate. A developer tool, not shipped.

fn main() -> std::process::ExitCode {
    let mut args = std::env::args().skip(1);
    let (Some(db), Some(root)) = (args.next(), args.next()) else {
        eprintln!("usage: seed <db-path> <project-dir> [claude|codex]");
        return std::process::ExitCode::from(2);
    };
    let harness = args.next().unwrap_or_else(|| "claude".to_owned());

    let store = match kitty_store::Store::open(&db) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("could not open {db}: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    let project = match store.open_project(std::path::Path::new(&root)) {
        Ok(project) => project,
        Err(e) => {
            eprintln!("could not open the project: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };

    match store.create_session(&project.id, &harness, None) {
        Ok(session) => {
            println!("project {} ({})", project.name, project.id);
            println!("session {} on {harness}", session.id);
            std::process::ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("could not create a session: {e}");
            std::process::ExitCode::FAILURE
        }
    }
}
