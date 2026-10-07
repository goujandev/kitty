//! `cargo run -p pantheon-probe --example probe`
//!
//! Runs the real discovery against this machine and prints what it found. This
//! is the headless version of slice 1's screen, and the quickest way to see
//! what pantheon will say about your setup.

fn main() {
    let started = std::time::Instant::now();
    let env = pantheon_probe::EnvSnapshot::capture();
    let captured = started.elapsed();

    println!(
        "environment: {} PATH directories in {:?}\n",
        env.path_dirs().len(),
        captured
    );

    let probe_started = std::time::Instant::now();
    let statuses = pantheon_probe::probe_all(&env);
    let probed = probe_started.elapsed();

    for status in &statuses {
        let mark = if status.ready { "ready" } else { "blocked" };
        println!("{} ({})  [{mark}]", status.label, status.vendor);

        match &status.install {
            pantheon_core::InstallState::Found { path, version } => {
                print!("  install   {version} at {path}");
                if status.newer_than_verified {
                    print!("  (newer than the {} we verified)", status.verified_version);
                }
                println!();
            }
            pantheon_core::InstallState::NotFound => println!("  install   not found"),
            pantheon_core::InstallState::UnsupportedVersion {
                path,
                found,
                required,
            } => println!("  install   {found} at {path}, needs {required}"),
            pantheon_core::InstallState::Unidentified { path, output } => {
                println!("  install   unidentified at {path}: {output}");
            }
            pantheon_core::InstallState::ProbeFailed { path, message } => {
                println!("  install   probe failed at {path}: {message}");
            }
        }

        match &status.login {
            pantheon_core::LoginState::LoggedIn {
                plan,
                expires_at_ms,
            } => {
                let plan = plan.as_deref().unwrap_or("unknown plan");
                match expires_at_ms {
                    Some(ms) => println!(
                        "  login     signed in ({plan}), token valid for {}",
                        human_remaining(*ms)
                    ),
                    None => println!("  login     signed in ({plan})"),
                }
            }
            pantheon_core::LoginState::LoggedOut => println!("  login     signed out"),
            pantheon_core::LoginState::Expired { expired_at_ms } => {
                println!(
                    "  login     expired {} ago",
                    human_remaining(*expired_at_ms)
                );
            }
            pantheon_core::LoginState::Unknown { reason } => {
                println!("  login     unknown: {reason}");
            }
        }

        if let Some(hint) = &status.hint {
            println!("  next      {}", hint.message);
            if let Some(command) = &hint.command {
                println!("            $ {command}");
            }
        }
        println!();
    }

    println!("probed {} harnesses in {probed:?}", statuses.len());
}

fn human_remaining(target_ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
    let delta = (target_ms - now).abs() / 1000;
    match delta {
        s if s < 90 => format!("{s}s"),
        s if s < 5400 => format!("{}m", s / 60),
        s if s < 172_800 => format!("{}h", s / 3600),
        s => format!("{}d", s / 86400),
    }
}
