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
fn a_sequence_number_is_never_handed_out_twice() {
    // The frontend keys its transcript, its row heights and its search hits on
    // this number, and is never told a sequence changed meaning. Reusing one
    // put an answer inside a thinking bubble.
    let (store, session) = seeded();

    let mut seen = Vec::new();
    for kind in [
        BlockKind::User,
        BlockKind::Reasoning,
        BlockKind::Assistant,
        BlockKind::Tool,
    ] {
        seen.push(store.append_block(&session, kind, "text").expect("append"));
    }

    let mut unique = seen.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), seen.len(), "sequences repeated: {seen:?}");
    assert_eq!(seen, vec![0, 1, 2, 3]);
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
fn a_list_stays_where_it_was_put() {
    let store = store();
    let project = store
        .open_project(std::path::Path::new(r"C:\work\kitty"))
        .expect("project");

    let first = store
        .create_session(&project.id, "claude", None)
        .expect("first");
    std::thread::sleep(std::time::Duration::from_millis(2));
    let second = store
        .create_session(&project.id, "codex", None)
        .expect("second");

    // Newest at the top to begin with.
    let listed = store.list_sessions(&project.id).expect("list");
    assert_eq!(listed[0].id, second.id);

    // Talking in the older one used to float it to the top, which is the
    // behaviour this replaces: a list that reshuffles while you are reading it
    // cannot be learned.
    store
        .append_block(&first.id, BlockKind::User, "ping")
        .expect("touch");

    let listed = store.list_sessions(&project.id).expect("list");
    assert_eq!(listed[0].id, second.id, "using one must not move it");
    assert_eq!(listed[1].id, first.id);

    // It moves when, and only when, it is moved.
    store
        .reorder_sessions(&[first.id.clone(), second.id.clone()])
        .expect("reorder");
    let listed = store.list_sessions(&project.id).expect("list");
    assert_eq!(listed[0].id, first.id);
    assert_eq!(listed[1].id, second.id);
}

#[test]
fn opening_a_project_does_not_move_it() {
    let store = store();
    let a = store
        .open_project(std::path::Path::new(r"C:\one"))
        .expect("a");
    std::thread::sleep(std::time::Duration::from_millis(2));
    let b = store
        .open_project(std::path::Path::new(r"C:\two"))
        .expect("b");

    let listed = store.list_projects().expect("list");
    assert_eq!(listed[0].id, b.id, "newest first to begin with");

    store.touch_project(&a.id).expect("open the older one");
    let listed = store.list_projects().expect("list");
    assert_eq!(listed[0].id, b.id, "opening one must not move it");

    store
        .reorder_projects(&[a.id.clone(), b.id.clone()])
        .expect("reorder");
    let listed = store.list_projects().expect("list");
    assert_eq!(listed[0].id, a.id);
    assert_eq!(listed[1].id, b.id);

    // A project made after a hand-ordering still arrives at the top, or a new
    // one would appear at the bottom of a long list and look like nothing
    // happened.
    let fresh = store
        .open_project(std::path::Path::new(r"C:\three"))
        .expect("c");
    let listed = store.list_projects().expect("list");
    assert_eq!(listed[0].id, fresh.id);
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

#[test]
fn deleting_a_project_removes_its_sessions_and_their_search_entries() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = Store::open(dir.path().join("kitty.db")).expect("open");

    let kept = store
        .open_project(&dir.path().join("kept"))
        .expect("kept project");
    let doomed = store
        .open_project(&dir.path().join("doomed"))
        .expect("doomed project");

    let keep = store
        .create_session(&kept.id, "claude", None)
        .expect("session");
    let drop = store
        .create_session(&doomed.id, "codex", None)
        .expect("session");
    store
        .append_block(&keep.id, BlockKind::Assistant, "keep parsnips")
        .expect("block");
    store
        .append_block(&drop.id, BlockKind::Assistant, "drop parsnips")
        .expect("block");

    assert_eq!(store.search("parsnips", 10).expect("search").len(), 2);

    store.delete_project(&doomed.id).expect("delete");

    let hits = store.search("parsnips", 10).expect("search");
    assert_eq!(hits.len(), 1, "search still returns a deleted project");
    assert_eq!(hits[0].session_id, keep.id);
    assert!(store.session(&drop.id).is_err());
    assert!(store.session(&keep.id).is_ok());
    assert_eq!(store.list_projects().expect("list").len(), 1);
}

#[test]
fn session_counts_are_reported_per_project() {
    let store = store();
    let a = store
        .open_project(std::path::Path::new(r"C:\a"))
        .expect("a");
    let b = store
        .open_project(std::path::Path::new(r"C:\b"))
        .expect("b");

    store.create_session(&a.id, "claude", None).expect("s1");
    store.create_session(&a.id, "codex", None).expect("s2");
    store.create_session(&b.id, "claude", None).expect("s3");

    let counts = store.session_counts().expect("counts");
    let find = |id: &str| counts.iter().find(|(p, _)| p == id).map(|(_, n)| *n);
    assert_eq!(find(&a.id), Some(2));
    assert_eq!(find(&b.id), Some(1));
}

// ------------------------------------------------- projects without a folder

#[test]
fn a_project_without_a_folder_is_not_keyed_on_one() {
    let store = store();
    let first = store.create_rootless_project("New chat").expect("first");
    let second = store.create_rootless_project("New chat").expect("second");

    assert_eq!(first.root, None);
    assert_eq!(second.root, None);
    // The old schema made `root` NOT NULL UNIQUE, which allowed exactly one of
    // these and only if you gave it a fake path. Two identically named chats
    // with nothing behind either is the normal case, not the edge case.
    assert_ne!(first.id, second.id);
    assert_eq!(store.list_projects().expect("list").len(), 2);
}

#[test]
fn a_chat_takes_its_name_from_what_was_asked() {
    let store = store();
    let project = store.create_rootless_project("New chat").expect("project");
    let session = store
        .create_session(&project.id, "claude", None)
        .expect("session");

    store
        .set_title_if_unset(&session.id, "how do i rotate a matrix")
        .expect("title");

    let named = store
        .list_projects()
        .expect("list")
        .into_iter()
        .find(|p| p.id == project.id)
        .expect("still there");
    assert_eq!(named.name, "how do i rotate a matrix");
}

#[test]
fn a_folder_project_keeps_its_folder_name() {
    let store = store();
    let project = store
        .open_project(std::path::Path::new(r"C:\code\kitty"))
        .expect("project");
    let session = store
        .create_session(&project.id, "claude", None)
        .expect("session");

    store
        .set_title_if_unset(&session.id, "why is the transcript empty")
        .expect("title");

    let named = store
        .list_projects()
        .expect("list")
        .into_iter()
        .find(|p| p.id == project.id)
        .expect("still there");
    assert_eq!(
        named.name, "kitty",
        "a folder project is named after its folder, not after one question"
    );
}

#[test]
fn pruning_takes_the_empty_chats_and_nothing_else() {
    let store = store();
    let empty = store.create_rootless_project("New chat").expect("empty");
    let open_now = store.create_rootless_project("New chat").expect("open");
    let used = store.create_rootless_project("New chat").expect("used");
    let folder = store
        .open_project(std::path::Path::new(r"C:\code\thing"))
        .expect("folder");

    store.create_session(&used.id, "claude", None).expect("s");

    let removed = store.prune_empty_chats(&open_now.id).expect("prune");
    assert_eq!(removed, 1);

    let left: Vec<String> = store
        .list_projects()
        .expect("list")
        .into_iter()
        .map(|p| p.id)
        .collect();
    assert!(!left.contains(&empty.id), "an abandoned chat is swept");
    assert!(left.contains(&open_now.id), "the one on screen is spared");
    assert!(left.contains(&used.id), "a chat with a session is spared");
    // An empty folder project is still a bookmark someone chose to keep.
    assert!(left.contains(&folder.id), "folder projects are never swept");
}

#[test]
fn opening_a_project_by_id_marks_it_opened() {
    let store = store();
    let project = store.create_rootless_project("New chat").expect("project");
    std::thread::sleep(std::time::Duration::from_millis(2));

    let reopened = store.touch_project(&project.id).expect("touch");
    assert_eq!(reopened.id, project.id);
    assert!(reopened.last_opened_at > project.last_opened_at);
}
