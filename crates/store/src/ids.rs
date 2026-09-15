//! Sortable, locally unique identifiers.
//!
//! Time-ordered so `ORDER BY id` is chronological and an index on it stays
//! append-friendly. Uniqueness only has to hold within one machine, so this
//! avoids a UUID dependency: milliseconds, then a per-process counter, then
//! the process id.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A new id, e.g. `01a0a3b4c5d6-0007-3f2c`.
#[must_use]
pub fn new_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{:012x}-{:04x}-{:04x}",
        millis & 0xffff_ffff_ffff,
        counter & 0xffff,
        std::process::id() & 0xffff
    )
}

#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_millis()).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::new_id;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique() {
        let ids: HashSet<String> = (0..10_000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 10_000, "ids collided");
    }

    #[test]
    fn ids_sort_chronologically() {
        let first = new_id();
        let second = new_id();
        assert!(first < second, "{first} should sort before {second}");
    }

    #[test]
    fn ids_have_a_stable_shape() {
        let id = new_id();
        assert_eq!(id.len(), 22, "{id}");
        assert_eq!(id.matches('-').count(), 2);
    }
}
