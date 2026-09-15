//! Behaviour of the store, including the properties ADR-0005 exists for.
//!
//! ADR-0001 denies `expect` outside tests. clippy's `allow-expect-in-tests`
//! only recognises `#[cfg(test)]` modules, not integration-test crates, so the
//! exemption is stated here instead.
#![allow(clippy::expect_used)]

use kitty_core::Usage;
use kitty_store::{BlockKind, Store};

fn store() -> Store {
    Store::in_memory().expect("open in-memory store")
}

fn seeded() -> (Store, String) {
    let store = store();
    let project = store
        .open_project(std::path::Path::new(r"C:\work\kitty"))
        .expect("project");
    let session = store
        .create_session(&project.id, "claude", Some("claude-opus-5"))
        .expect("session");
    (store, session.id)
}

#[test]
fn opening_the_same_directory_twice_reuses_the_project() {
    let store = store();
    let path = std::path::Path::new(r"C:\work\kitty");

    let first = store.open_project(path).expect("first");
    let second = store.open_project(path).expect("second");

    assert_eq!(first.id, second.id, "a project must not be duplicated");
    assert_eq!(second.name, "kitty", "the name comes from the folder");
    assert_eq!(store.list_projects().expect("list").len(), 1);
}

#[test]
fn blocks_append_in_order() {
    let (store, session) = seeded();

    assert_eq!(
        store
            .append_block(&session, BlockKind::User, "hello")
            .expect("user"),
        0
    );
    assert_eq!(
        store
            .append_block(&session, BlockKind::Assistant, "hi")
            .expect("assistant"),
        1
    );

    let blocks = store.blocks(&session).expect("blocks");
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0].kind, BlockKind::User);
    assert_eq!(blocks[0].text, "hello");
    assert_eq!(blocks[1].kind, BlockKind::Assistant);
}

#[test]
fn extending_a_block_touches_one_row() {
    // This is the ADR-0005 property: a streaming update must not rewrite the
    // transcript. Growing one block must leave every other block untouched.
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::User, "a long earlier message")
        .expect("first");
    let streaming = store
        .append_block(&session, BlockKind::Assistant, "")
        .expect("second");

    let before = store.blocks(&session).expect("before");

    let mut text = String::new();
    for chunk in ["Hello", ",", " lovely", " human", "."] {
        text.push_str(chunk);
        store
            .set_block_text(&session, streaming, &text)
            .expect("update");
    }

    let after = store.blocks(&session).expect("after");
    assert_eq!(after[0], before[0], "an unrelated block was rewritten");
    assert_eq!(after[1].text, "Hello, lovely human.");
}

#[test]
fn whitespace_in_a_block_survives_a_round_trip() {
    // Acceptance criterion 5 reaches all the way to disk.
    let (store, session) = seeded();
    let text = "one\n\ntwo   three\t\nfour ";
    let seq = store
        .append_block(&session, BlockKind::Assistant, text)
        .expect("append");

    let blocks = store.blocks(&session).expect("blocks");
    assert_eq!(blocks[usize::try_from(seq).expect("seq")].text, text);
}

#[test]
fn an_empty_block_can_be_discarded() {
    let (store, session) = seeded();
    let seq = store
        .append_block(&session, BlockKind::Assistant, "")
        .expect("append");

    assert!(store
        .discard_block_if_empty(&session, seq)
        .expect("discard"));
    assert!(store.blocks(&session).expect("blocks").is_empty());
}

#[test]
fn a_block_with_text_is_never_discarded() {
    let (store, session) = seeded();
    let seq = store
        .append_block(&session, BlockKind::Assistant, "partial answer")
        .expect("append");

    assert!(!store
        .discard_block_if_empty(&session, seq)
        .expect("discard"));
    assert_eq!(store.blocks(&session).expect("blocks").len(), 1);
}

#[test]
fn the_provider_session_is_remembered_for_resume() {
    let (store, session) = seeded();
    store
        .set_provider_session(&session, "b954e202-d655")
        .expect("set");

    assert_eq!(
        store.session(&session).expect("session").provider_session,
        Some("b954e202-d655".to_owned())
    );
}

#[test]
fn the_first_message_titles_the_session_and_later_ones_do_not() {
    let (store, session) = seeded();
    store
        .set_title_if_unset(&session, "  explain the build  ")
        .expect("first");
    store
        .set_title_if_unset(&session, "something else entirely")
        .expect("second");

    assert_eq!(
        store.session(&session).expect("session").title.as_deref(),
        Some("explain the build")
    );
}

#[test]
fn sessions_list_most_recently_updated_first() {
    let store = store();
    let project = store
        .open_project(std::path::Path::new(r"C:\work\kitty"))
        .expect("project");

    let older = store
        .create_session(&project.id, "claude", None)
        .expect("older");
    let newer = store
        .create_session(&project.id, "codex", None)
        .expect("newer");

    // Touching the older session should float it to the top.
    store
        .append_block(&older.id, BlockKind::User, "ping")
        .expect("touch");

    let listed = store.list_sessions(&project.id).expect("list");
    assert_eq!(listed[0].id, older.id);
    assert_eq!(listed[1].id, newer.id);
}

#[test]
fn search_finds_a_block_by_word() {
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::Assistant, "the quick brown fox")
        .expect("append");
    store
        .append_block(&session, BlockKind::Assistant, "nothing relevant here")
        .expect("append");

    let hits = store.search("brown", 10).expect("search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id, session);
    assert!(hits[0].snippet.contains("brown"));
}

#[test]
fn search_survives_punctuation_a_user_might_type() {
    // A bare FTS5 MATCH would treat these as syntax and error.
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::Assistant, "call foo(bar) then stop")
        .expect("append");

    for query in ["foo(bar)", "foo(", "\"quoted", "a AND"] {
        let hits = store.search(query, 10);
        assert!(hits.is_ok(), "query {query:?} errored: {hits:?}");
    }
}

#[test]
fn search_reflects_an_edited_block() {
    let (store, session) = seeded();
    let seq = store
        .append_block(&session, BlockKind::Assistant, "")
        .expect("append");
    store
        .set_block_text(&session, seq, "now it mentions parsnips")
        .expect("update");

    assert_eq!(store.search("parsnips", 10).expect("search").len(), 1);
}

#[test]
fn an_empty_search_returns_nothing_rather_than_everything() {
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::User, "hello")
        .expect("append");

    assert!(store.search("   ", 10).expect("search").is_empty());
}

#[test]
fn turns_record_their_usage() {
    let (store, session) = seeded();
    store
        .record_turn(
            &session,
            "endTurn",
            Usage {
                input_tokens: 2,
                output_tokens: 9,
                cache_read_tokens: 15_445,
                cache_write_tokens: 9_091,
                reasoning_tokens: 0,
            },
        )
        .expect("record");
}

#[test]
fn settings_round_trip_and_overwrite() {
    let store = store();
    store
        .set_setting("global", "", "defaultHarness", "claude")
        .expect("set");
    assert_eq!(
        store.setting("global", "", "defaultHarness").expect("get"),
        Some("claude".to_owned())
    );

    store
        .set_setting("global", "", "defaultHarness", "codex")
        .expect("overwrite");
    assert_eq!(
        store.setting("global", "", "defaultHarness").expect("get"),
        Some("codex".to_owned())
    );
    assert_eq!(store.setting("global", "", "missing").expect("get"), None);
}

#[test]
fn a_transcript_survives_closing_and_reopening_the_file() {
    // Acceptance criterion 6, at the storage layer.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kitty.db");

    let session_id = {
        let store = Store::open(&path).expect("open");
        let project = store.open_project(dir.path()).expect("project");
        let session = store
            .create_session(&project.id, "codex", Some("gpt-5.6-terra"))
            .expect("session");
        store
            .append_block(&session.id, BlockKind::User, "say hello")
            .expect("user");
        store
            .append_block(&session.id, BlockKind::Assistant, "Hello, lovely human.")
            .expect("assistant");
        session.id
    };

    let reopened = Store::open(&path).expect("reopen");
    let blocks = reopened.blocks(&session_id).expect("blocks");
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[1].text, "Hello, lovely human.");
    assert_eq!(
        reopened
            .session(&session_id)
            .expect("session")
            .model
            .as_deref(),
        Some("gpt-5.6-terra")
    );
}

#[test]
fn a_missing_session_is_an_error_not_a_panic() {
    let store = store();
    assert!(store.session("nope").is_err());
}

#[test]
fn an_unused_session_is_pruned_and_a_used_one_is_not() {
    // Picking an agent and changing your mind should leave nothing behind.
    let store = store();
    let project = store
        .open_project(std::path::Path::new(r"C:\work\kitty"))
        .expect("project");

    let used = store
        .create_session(&project.id, "claude", None)
        .expect("used");
    let abandoned = store
        .create_session(&project.id, "codex", None)
        .expect("abandoned");
    store
        .append_block(&used.id, BlockKind::User, "hello")
        .expect("block");

    assert_eq!(store.prune_empty_sessions(&project.id).expect("prune"), 1);

    let left = store.list_sessions(&project.id).expect("list");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].id, used.id);
    assert!(store.session(&abandoned.id).is_err());
}

#[test]
fn deleting_a_session_removes_it_from_search() {
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::Assistant, "mentions parsnips")
        .expect("block");
    assert_eq!(store.search("parsnips", 10).expect("search").len(), 1);

    store.delete_session(&session).expect("delete");

    assert!(
        store.search("parsnips", 10).expect("search").is_empty(),
        "search still returns a conversation that no longer exists"
    );
    assert!(store.blocks(&session).expect("blocks").is_empty());
}

#[test]
fn a_migration_added_after_release_applies_to_an_existing_database() {
    // Migration 2 added `blocks.meta`. A database created before it must gain
    // the column on open, which is the whole point of forward-only migrations.
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("kitty.db");

    let session_id = {
        let store = Store::open(&path).expect("open");
        let project = store.open_project(dir.path()).expect("project");
        let session = store
            .create_session(&project.id, "claude", None)
            .expect("session");
        let seq = store
            .append_block(&session.id, BlockKind::Tool, "Write src/main.rs")
            .expect("tool block");
        store
            .set_block_meta(&session.id, seq, r#"{"status":"ok"}"#)
            .expect("meta");
        session.id
    };

    let reopened = Store::open(&path).expect("reopen");
    let blocks = reopened.blocks(&session_id).expect("blocks");
    assert_eq!(blocks[0].kind, BlockKind::Tool);
    assert_eq!(blocks[0].meta.as_deref(), Some(r#"{"status":"ok"}"#));
}

#[test]
fn a_block_without_meta_reads_back_as_none() {
    let (store, session) = seeded();
    store
        .append_block(&session, BlockKind::Assistant, "plain")
        .expect("append");
    assert_eq!(store.blocks(&session).expect("blocks")[0].meta, None);
}
