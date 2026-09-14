//! kitty domain types.
//!
//! No I/O, no Tauri, no filesystem, no network. Everything here is a plain
//! value that can be serialized, compared and tested in isolation. Layers
//! above may depend on this crate; it depends on nothing above it
//! (ARCHITECTURE.md §3).

mod harness;
mod status;
mod version;

pub use harness::{HarnessDescriptor, HarnessId, CLAUDE, CODEX};
pub use status::{HarnessStatus, Hint, InstallState, LoginState, Scan};
pub use version::Version;
