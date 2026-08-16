//! Integration test for the sandbox (branch) feature, issue #747.
//!
//! SQLite → SQLite, exactly as the issue anticipates ("統合テストは SQLite→SQLite
//! で外部サーバ不要にできるはず"): the "source" side is a temp-file SQLite database
//! standing in for the real DB, and the sandbox itself is always SQLite. No
//! external server is needed, so this always runs (like `sqlite_integration.rs`).
//!
//! `create_sandbox` / `discard_sandbox` / `list_sandboxes` are the only IPC
//! commands in this codebase that persist to a JSON store under the real OS
//! data directory (`sandboxes.json` + `<data_dir>/sandboxes/*.sqlite`, via
//! `sandboxes::store`) rather than an injectable path — unlike `history.sqlite`,
//! there's no `skip_history`-style escape hatch. This test therefore creates
//! exactly one sandbox record with a fresh random id (collision-proof) and
//! unconditionally discards it before returning (`Drop` guard below), so it
//! never leaves residue in a real user's data directory even on assertion
//! failure — the same "create it, then clean up after yourself" footprint an
//! interactive user leaves after trying and discarding a sandbox.

use std::path::PathBuf;

use noobdb_lib::__test_api as t;

fn temp_db_path(tag: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    p.push(format!("noobdb_sandbox_{tag}_{}.db", std::process::id()));
    p
}

async fn fresh_sqlite(tag: &str) -> (PathBuf, t::Connection) {
    let path = temp_db_path(tag);
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect");
    (path, conn)
}

/// Ensures the sandbox created during the test is discarded (file + JSON
/// record) even if an assertion panics partway through — see the module doc.
struct DiscardGuard {
    state: std::sync::Arc<t::AppState>,
    sandbox_id: Option<String>,
    session_id: Option<String>,
}

impl Drop for DiscardGuard {
    fn drop(&mut self) {
        if let Some(id) = self.sandbox_id.take() {
            let state = self.state.clone();
            let session_id = self.session_id.take();
            // Best effort, synchronous context: spawn a detached task. Tests
            // that want a guaranteed-awaited cleanup call `discard()` explicitly
            // before returning; this is the safety net for the panic path.
            tokio::spawn(async move {
                let _ = t::discard_sandbox_via_command(&state, &id, session_id.as_deref()).await;
            });
        }
    }
}

impl DiscardGuard {
    async fn discard(mut self) {
        if let Some(id) = self.sandbox_id.take() {
            let session_id = self.session_id.take();
            let _ = t::discard_sandbox_via_command(&self.state, &id, session_id.as_deref()).await;
        }
    }
}

#[tokio::test]
async fn sandbox_create_diff_writeback_and_discard_round_trip() {
    let (source_path, source_conn) = fresh_sqlite("source").await;

    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER NOT NULL)",
            None,
        )
        .await
        .expect("create source table");
    source_conn
        .execute(
            "INSERT INTO items (id, label, qty) VALUES (1, 'apple', 10), (2, 'banana', 5)",
            None,
        )
        .await
        .expect("seed source rows");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        /* read_only */ false,
    );
    let source_session_id = state.insert(source_session).await;

    // --- create_sandbox: copies `items` into a fresh local SQLite file. ---
    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "test sandbox",
        vec!["items".to_string()],
        false,
        Some(100),
    )
    .await
    .expect("create_sandbox");
    assert_eq!(create.sandbox.tables, vec!["items".to_string()]);
    assert_eq!(create.sandbox.truncated_tables, Vec::<String>::new());
    assert!(std::path::Path::new(&create.sandbox.file_path).exists());

    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };

    // Listing surfaces the freshly created record.
    let listed = t::list_sandboxes_via_command().expect("list_sandboxes");
    assert!(listed.iter().any(|r| r.id == create.sandbox.id));

    // The sandbox session is a normal, independent connection: querying it
    // must return the copied rows.
    let sandbox_session = state
        .get(&create.session_id)
        .await
        .expect("sandbox session registered");
    let copied = sandbox_session
        .conn
        .execute("SELECT id, label, qty FROM items ORDER BY id", None)
        .await
        .expect("select from sandbox copy");
    assert_eq!(copied.rows.len(), 2);

    // --- Experiment in the sandbox: update one row, insert another. ---
    sandbox_session
        .conn
        .execute("UPDATE items SET qty = 99 WHERE id = 1", None)
        .await
        .expect("update in sandbox");
    sandbox_session
        .conn
        .execute(
            "INSERT INTO items (id, label, qty) VALUES (3, 'cherry', 7)",
            None,
        )
        .await
        .expect("insert in sandbox");

    // --- Diff: no external changes yet, so no conflicts. ---
    let diff = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        Some(&source_session_id),
        None,
    )
    .await
    .expect("sandbox_table_diff");
    assert!(diff.source_checked);
    assert!(diff.conflicts.is_empty());
    assert_eq!(diff.desired.rows.len(), 2, "one update + one insert");
    assert_eq!(diff.desired.target_driver, t::DriverKind::Sqlite);

    // Render + apply the writeback SQL to the *source* session, reusing the
    // existing (already-tested) generate_data_sync_sql / apply_sync_sql path
    // unchanged — this is the crux of the reuse design (see module doc).
    let plan = t::generate_data_sync_sql(&diff.desired, /* allow_delete */ true);
    assert!(!plan.statements.is_empty());
    let statements: Vec<String> = plan.statements.into_iter().map(|s| s.sql).collect();
    t::apply_sync_sql_via_command(&state, &source_session_id, None, statements)
        .await
        .expect("apply writeback to source");

    let after = state
        .get(&source_session_id)
        .await
        .expect("source session still registered")
        .conn
        .execute("SELECT id, label, qty FROM items ORDER BY id", None)
        .await
        .expect("select from source after writeback");
    assert_eq!(after.rows.len(), 3, "writeback must add the new row");
    // id=1's qty must now be 99 (the sandbox's change), id=3 must exist.
    let qty_of = |rows: &[Vec<t::Value>], id: i64| -> Option<i64> {
        rows.iter().find_map(|r| match &r[0] {
            t::Value::Int(v) if *v == id => match &r[2] {
                t::Value::Int(q) => Some(*q),
                _ => None,
            },
            _ => None,
        })
    };
    assert_eq!(qty_of(&after.rows, 1), Some(99));
    assert_eq!(qty_of(&after.rows, 3), Some(7));

    // Advance the sandbox's frozen base for the rows just written back.
    // Without this, id=1/id=3 would show up as phantom conflicts below (both
    // "sides" now hold the post-writeback value, which isn't a real conflict).
    t::sandbox_advance_base_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        diff.desired,
        true,
    )
    .await
    .expect("sandbox_advance_base");

    let post_advance = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        Some(&source_session_id),
        None,
    )
    .await
    .expect("sandbox_table_diff after advancing the base");
    assert!(
        post_advance.desired.rows.is_empty(),
        "id=1/id=3 are now fully in sync; the base must have advanced: {:?}",
        post_advance.desired.rows,
    );
    assert!(
        post_advance.conflicts.is_empty(),
        "advancing the base must not manufacture phantom conflicts: {:?}",
        post_advance.conflicts,
    );

    // --- Conflict detection: change the *same* row on both sides. ---
    sandbox_session
        .conn
        .execute("UPDATE items SET qty = 1000 WHERE id = 2", None)
        .await
        .expect("sandbox changes id=2 again");
    state
        .get(&source_session_id)
        .await
        .expect("source session")
        .conn
        .execute("UPDATE items SET qty = 2000 WHERE id = 2", None)
        .await
        .expect("source independently changes id=2");

    let conflict_diff = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        Some(&source_session_id),
        None,
    )
    .await
    .expect("sandbox_table_diff after concurrent edit");
    assert_eq!(
        conflict_diff.conflicts.len(),
        1,
        "id=2 changed on both sides since the snapshot must be flagged"
    );
    assert_eq!(conflict_diff.conflicts[0].key, vec![t::Value::Int(2)],);

    // Resolving the conflict as "skip" must drop it from the writeback diff.
    let filtered = t::filter_sandbox_data_diff(
        conflict_diff.desired.clone(),
        vec![conflict_diff.conflicts[0].key.clone()],
    );
    assert!(
        filtered
            .rows
            .iter()
            .all(|r| r.key != vec![t::Value::Int(2)]),
        "the skipped key must not appear in the filtered diff"
    );

    // --- Schema diff: sandbox-only structural change is surfaced too. ---
    sandbox_session
        .conn
        .execute("ALTER TABLE items ADD COLUMN note TEXT", None)
        .await
        .expect("alter sandbox schema");
    let schema_diff = t::sandbox_schema_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        Some(&source_session_id),
    )
    .await
    .expect("sandbox_schema_diff");
    let items_diff = schema_diff
        .desired
        .tables
        .iter()
        .find(|tb| tb.name == "items")
        .expect("items present in schema diff");
    assert_eq!(items_diff.status, t::DiffStatus::Different);
    assert!(items_diff.columns.iter().any(|c| c.name == "note"));

    // --- Discard: file and metadata must both disappear. ---
    let sandbox_file = create.sandbox.file_path.clone();
    guard.discard().await;
    assert!(
        !std::path::Path::new(&sandbox_file).exists(),
        "discard must delete the sandbox's SQLite file"
    );
    let listed_after = t::list_sandboxes_via_command().expect("list_sandboxes after discard");
    assert!(!listed_after.iter().any(|r| r.id == create.sandbox.id));

    let _ = std::fs::remove_file(&source_path);
}

/// #H3: `sandbox_advance_base` must verify that `sandbox_session_id` is really
/// the session for `sandbox_id` before touching its shadow/base tables. A
/// completely unrelated session (different backing SQLite file — e.g. another
/// sandbox, or an ordinary connection) must be rejected rather than silently
/// having its tables read/written.
#[tokio::test]
async fn sandbox_advance_base_rejects_unrelated_session() {
    let (source_path, source_conn) = fresh_sqlite("advance_unrelated_source").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
            None,
        )
        .await
        .expect("create source table");
    source_conn
        .execute("INSERT INTO items (id, label) VALUES (1, 'a')", None)
        .await
        .expect("seed source rows");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_adv_unrel_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;

    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "advance unrelated test",
        vec!["items".to_string()],
        false,
        Some(100),
    )
    .await
    .expect("create_sandbox");
    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };

    // A second, wholly unrelated session (a different backing SQLite file, not
    // registered as this sandbox's session) must not be accepted in its place.
    let (other_path, other_conn) = fresh_sqlite("advance_unrelated_other").await;
    let other_session = t::make_session(
        "sbx_adv_unrel_other",
        other_conn,
        t::sqlite_options(other_path.to_str().expect("utf8 path")),
        false,
    );
    let other_session_id = state.insert(other_session).await;

    // An (effectively) empty diff still exercises the ownership check, which
    // runs before any statement is built from `applied`.
    let empty_diff = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        None,
        None,
    )
    .await
    .expect("sandbox_table_diff")
    .desired;

    let err = t::sandbox_advance_base_via_command(
        &state,
        &create.sandbox.id,
        &other_session_id,
        "items",
        empty_diff,
        true,
    )
    .await
    .expect_err("an unrelated session must not be accepted as this sandbox's session");
    let msg = err.to_string();
    assert!(
        msg.contains("not the sandbox session"),
        "unexpected error message: {msg}"
    );

    guard.discard().await;
    if let Some(sess) = state.remove(&other_session_id).await {
        sess.conn.close().await;
    }
    let _ = std::fs::remove_file(&source_path);
    let _ = std::fs::remove_file(&other_path);
}

/// #H3: `sandbox_advance_base` must reject a read-only session even when it
/// legitimately points at the sandbox's own SQLite file (mirrors
/// `apply_sync_sql` / `apply_privilege_sql` rejecting read-only targets).
#[tokio::test]
async fn sandbox_advance_base_rejects_read_only_session() {
    let (source_path, source_conn) = fresh_sqlite("advance_ro_source").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
            None,
        )
        .await
        .expect("create source table");
    source_conn
        .execute("INSERT INTO items (id, label) VALUES (1, 'a')", None)
        .await
        .expect("seed source rows");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_adv_ro_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;

    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "advance read-only test",
        vec!["items".to_string()],
        false,
        Some(100),
    )
    .await
    .expect("create_sandbox");
    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };

    // Open a second connection to the *same* sandbox SQLite file, this time
    // marked read-only. It legitimately identifies as this sandbox's session
    // (same file_path) so the ownership check alone must not be enough to
    // stop it — the read_only guard has to catch it.
    let ro_opts = t::sqlite_options(&create.sandbox.file_path);
    let ro_conn = t::connect(&ro_opts).await.expect("connect read-only copy");
    let ro_session = t::make_session("sbx_adv_ro_copy", ro_conn, ro_opts, true);
    let ro_session_id = state.insert(ro_session).await;

    let empty_diff = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        None,
        None,
    )
    .await
    .expect("sandbox_table_diff")
    .desired;

    let err = t::sandbox_advance_base_via_command(
        &state,
        &create.sandbox.id,
        &ro_session_id,
        "items",
        empty_diff,
        true,
    )
    .await
    .expect_err("a read-only session must not be able to advance the sandbox base");
    assert_eq!(err.kind(), "readOnly", "unexpected error kind: {err:?}");

    guard.discard().await;
    if let Some(sess) = state.remove(&ro_session_id).await {
        sess.conn.close().await;
    }
    let _ = std::fs::remove_file(&source_path);
}

/// #H4: the reserved shadow-table prefix check must also apply to tables
/// pulled in transitively via `include_related` (FK closure), not just the
/// tables the caller explicitly selected. Otherwise a real table that happens
/// to be named with the reserved prefix can be dragged in through a foreign
/// key and collide with its own shadow ("base") mirror.
#[tokio::test]
async fn create_sandbox_rejects_reserved_prefix_pulled_in_via_fk_closure() {
    // Must match `db::sandbox::SHADOW_PREFIX` (not re-exported to tests).
    const SHADOW_PREFIX: &str = "__noobdb_sandbox_base__";
    let reserved_table = format!("{SHADOW_PREFIX}parent");

    let (source_path, source_conn) = fresh_sqlite("fk_reserved_prefix").await;
    source_conn
        .execute(
            &format!("CREATE TABLE \"{reserved_table}\" (id INTEGER PRIMARY KEY)"),
            None,
        )
        .await
        .expect("create reserved-prefix parent table");
    source_conn
        .execute(
            &format!(
                "CREATE TABLE child (id INTEGER PRIMARY KEY, ref_id INTEGER REFERENCES \"{reserved_table}\"(id))"
            ),
            None,
        )
        .await
        .expect("create child table with FK to the reserved-prefix table");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_fk_reserved_prefix",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;

    // Selecting only `child` with `include_related = true` must pull in the
    // reserved-prefix parent via FK closure — and that must be rejected, not
    // silently accepted into a sandbox where it would collide with its own
    // shadow table.
    let err = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "fk reserved prefix test",
        vec!["child".to_string()],
        true,
        Some(100),
    )
    .await
    .expect_err("a reserved-prefix table pulled in via FK closure must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains(&reserved_table) && msg.contains("reserved sandbox prefix"),
        "unexpected error message: {msg}"
    );

    // Nothing should have been persisted: no sandbox record, no leftover file.
    let listed = t::list_sandboxes_via_command().expect("list_sandboxes");
    assert!(
        !listed.iter().any(|r| r.name == "fk reserved prefix test"),
        "a rejected sandbox creation must not leave a record behind"
    );

    let _ = std::fs::remove_file(&source_path);
}
