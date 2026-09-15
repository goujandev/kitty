//! `cargo run -p kitty-catalog --example models`
//!
//! Asks each installed CLI what it can run, and prints it. The headless
//! version of the model picker.

fn main() -> std::process::ExitCode {
    let env = kitty_probe::EnvSnapshot::capture();
    let cwd = std::env::current_dir().unwrap_or_else(|_| ".".into());
    let mut any = false;

    for harness in kitty_core::HarnessId::ALL {
        let status = kitty_probe::probe_one(harness, &env);
        let kitty_core::InstallState::Found { path, version } = &status.install else {
            eprintln!("{}: not available", status.label);
            continue;
        };

        let started = std::time::Instant::now();
        match kitty_catalog::probe(
            harness,
            std::path::Path::new(path),
            &cwd,
            &version.to_string(),
        ) {
            Ok(catalog) => {
                any = true;
                println!(
                    "\n{} {} — {} models in {:?}",
                    status.label,
                    version,
                    catalog.models.len(),
                    started.elapsed()
                );
                for model in &catalog.models {
                    let mark = if model.is_default { "*" } else { " " };
                    println!("  {mark} {:<24} {}", model.id, model.display_name);
                    if !model.efforts.is_empty() {
                        println!(
                            "      effort {} (default {})",
                            model.efforts.join(", "),
                            model.default_effort.as_deref().unwrap_or("none")
                        );
                    }
                }
            }
            Err(e) => eprintln!("{}: {e}", status.label),
        }
    }

    if any {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}
