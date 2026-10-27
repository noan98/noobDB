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
    let plan = t::generate_data_sync_sql_via_command(
        &state,
        &diff.desired_diff_id,
        /* allow_delete */ true,
        None,
    )
    .expect("generate from the stored diff");
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
        &diff.desired_diff_id,
        vec![],
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

    // Resolving the conflict as "skip" must drop it from the writeback diff — both
    // in the pure filter and in the SQL rendered from the stored diff by id.
    let skip = vec![conflict_diff.conflicts[0].key.clone()];
    let filtered = t::filter_out_keys(&conflict_diff.desired, &skip);
    assert!(
        filtered
            .rows
            .iter()
            .all(|r| r.key != vec![t::Value::Int(2)]),
        "the skipped key must not appear in the filtered diff"
    );
    let unfiltered_plan =
        t::generate_data_sync_sql_via_command(&state, &conflict_diff.desired_diff_id, true, None)
            .expect("render without skipping");
    let skipped_plan = t::generate_data_sync_sql_via_command(
        &state,
        &conflict_diff.desired_diff_id,
        true,
        Some(&skip),
    )
    .expect("render with the conflict skipped");
    assert!(!unfiltered_plan.statements.is_empty());
    assert!(
        skipped_plan.statements.len() < unfiltered_plan.statements.len(),
        "skipping the conflicting key must drop its statement"
    );

    // A released diff id is gone: rendering / advancing fail with a clear error
    // instead of silently using stale data.
    t::release_data_diffs_via_command(&state, std::slice::from_ref(&conflict_diff.desired_diff_id));
    let gone =
        t::generate_data_sync_sql_via_command(&state, &conflict_diff.desired_diff_id, true, None);
    assert!(matches!(gone, Err(t::AppError::InvalidInput(_))));

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
    .desired_diff_id;

    let err = t::sandbox_advance_base_via_command(
        &state,
        &create.sandbox.id,
        &other_session_id,
        "items",
        &empty_diff,
        vec![],
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
    .desired_diff_id;

    let err = t::sandbox_advance_base_via_command(
        &state,
        &create.sandbox.id,
        &ro_session_id,
        "items",
        &empty_diff,
        vec![],
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

/// FK 付きの表でもサンドボックスを作れる (#1530)。サンドボックスの SQLite は外部キー
/// 強制が有効なので、CREATE に FK を含めると、表名順の投入・行数上限で欠けた親行・
/// 関連テーブルを含めない選択のいずれでも INSERT が失敗する。サンドボックスには FK を
/// 持ち込まない。
#[tokio::test]
async fn create_sandbox_with_foreign_key_tables_does_not_carry_the_constraints() {
    let (source_path, source_conn) = fresh_sqlite("fk_tables").await;
    source_conn
        .execute(
            "CREATE TABLE zparent (id INTEGER PRIMARY KEY, name TEXT)",
            None,
        )
        .await
        .expect("parent");
    source_conn
        .execute(
            "CREATE TABLE achild (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES zparent(id))",
            None,
        )
        .await
        .expect("child");
    source_conn
        .execute(
            "INSERT INTO zparent (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')",
            None,
        )
        .await
        .expect("seed parent");
    source_conn
        .execute(
            "INSERT INTO achild (id, parent_id) VALUES (10, 1), (11, 2), (12, 3)",
            None,
        )
        .await
        .expect("seed child");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_fk_tables",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;

    // 子だけを選ぶ (親は含めない) / 関連込みで行数上限により親が欠ける、の 2 通り。
    for (label, tables, related, limit) in [
        (
            "fk child only",
            vec!["achild".to_string()],
            false,
            Some(100),
        ),
        (
            "fk related truncated",
            vec!["achild".to_string()],
            true,
            Some(2),
        ),
    ] {
        let create = t::create_sandbox_via_command(
            &state,
            &source_session_id,
            None,
            label,
            tables,
            related,
            limit,
        )
        .await
        .unwrap_or_else(|e| panic!("{label}: create_sandbox failed: {e}"));
        let guard = DiscardGuard {
            state: state.clone(),
            sandbox_id: Some(create.sandbox.id.clone()),
            session_id: Some(create.session_id.clone()),
        };
        guard.discard().await;
    }

    let _ = std::fs::remove_file(&source_path);
}

/// #1539: `sandbox_reset_table` は 1 表のライブ行だけを base スナップショットへ戻し、
/// 他の表の作業を残す。base が書き戻しで進んでいれば戻り先もそこまで進む。
#[tokio::test]
async fn sandbox_reset_table_restores_one_table_only() {
    let (source_path, source_conn) = fresh_sqlite("reset_source").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER NOT NULL)",
            None,
        )
        .await
        .expect("create items");
    source_conn
        .execute(
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
            None,
        )
        .await
        .expect("create notes");
    source_conn
        .execute(
            "INSERT INTO items (id, label, qty) VALUES (1, 'apple', 10), (2, 'banana', 5)",
            None,
        )
        .await
        .expect("seed items");
    source_conn
        .execute("INSERT INTO notes (id, body) VALUES (1, 'n1')", None)
        .await
        .expect("seed notes");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_reset_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;
    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "reset sandbox",
        vec!["items".to_string(), "notes".to_string()],
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
    let sandbox_session = state.get(&create.session_id).await.expect("session");

    // 両方の表を編集する。
    for sql in [
        "UPDATE items SET qty = 99 WHERE id = 1",
        "DELETE FROM items WHERE id = 2",
        "INSERT INTO items (id, label, qty) VALUES (3, 'cherry', 1)",
        "UPDATE notes SET body = 'edited' WHERE id = 1",
    ] {
        sandbox_session.conn.execute(sql, None).await.expect(sql);
    }

    // 存在しない表は弾く。
    assert!(t::sandbox_reset_table_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "nope"
    )
    .await
    .is_err());

    let restored =
        t::sandbox_reset_table_via_command(&state, &create.sandbox.id, &create.session_id, "items")
            .await
            .expect("reset items");
    assert_eq!(restored, 2);
    let items = sandbox_session
        .conn
        .execute("SELECT id, label, qty FROM items ORDER BY id", None)
        .await
        .expect("select items");
    let flat: Vec<String> = items.rows.iter().map(|r| format!("{:?}", r)).collect();
    assert_eq!(flat.len(), 2, "{flat:?}");
    assert!(
        flat[0].contains("apple") && flat[0].contains("10"),
        "{flat:?}"
    );
    assert!(
        flat[1].contains("banana") && flat[1].contains("5"),
        "{flat:?}"
    );
    // 他の表の編集はそのまま残る。
    let notes = sandbox_session
        .conn
        .execute("SELECT body FROM notes", None)
        .await
        .expect("select notes");
    assert!(format!("{:?}", notes.rows).contains("edited"));

    // 再度の差分は items だけ空になる。
    let diff = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "items",
        None,
        None,
    )
    .await
    .expect("diff items");
    assert!(diff.desired.rows.is_empty());
    let diff_notes = t::sandbox_table_diff_via_command(
        &state,
        &create.sandbox.id,
        &create.session_id,
        "notes",
        None,
        None,
    )
    .await
    .expect("diff notes");
    assert_eq!(diff_notes.desired.rows.len(), 1);

    guard.discard().await;
    let _ = std::fs::remove_file(&source_path);
}

/// #1539: 読み取り専用セッションと無関係なセッションでは表リセットを拒否する。
#[tokio::test]
async fn sandbox_reset_table_rejects_read_only_and_unrelated_sessions() {
    let (source_path, source_conn) = fresh_sqlite("reset_guard_source").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)",
            None,
        )
        .await
        .expect("create");
    source_conn
        .execute("INSERT INTO items (id, label) VALUES (1, 'a')", None)
        .await
        .expect("seed");
    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_reset_guard",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;
    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "reset guard",
        vec!["items".to_string()],
        false,
        Some(10),
    )
    .await
    .expect("create_sandbox");
    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };

    // 無関係なセッション (元 DB) を渡しても弾かれる。
    let err =
        t::sandbox_reset_table_via_command(&state, &create.sandbox.id, &source_session_id, "items")
            .await
            .expect_err("unrelated session");
    assert!(err.to_string().contains("not the sandbox session"), "{err}");

    // 同じファイルを指す読み取り専用セッション。
    let ro_conn = t::connect(&t::sqlite_options(&create.sandbox.file_path))
        .await
        .expect("connect ro");
    let ro = t::make_session(
        "sbx_reset_ro",
        ro_conn,
        t::sqlite_options(&create.sandbox.file_path),
        true,
    );
    let ro_id = state.insert(ro).await;
    let err = t::sandbox_reset_table_via_command(&state, &create.sandbox.id, &ro_id, "items")
        .await
        .expect_err("read-only");
    assert_eq!(err.kind(), "readOnly", "{err:?}");

    guard.discard().await;
    if let Some(sess) = state.remove(&ro_id).await {
        sess.conn.close().await;
    }
    let _ = std::fs::remove_file(&source_path);
}

/// 表ごとの抽出条件 (WHERE) で、条件に合う行だけをコピーする (#1625)。条件は記録され、
/// 括弧を抜けるような条件・複数文は作成前に拒否される。
#[tokio::test]
async fn create_sandbox_copies_only_rows_matching_the_row_filter() {
    let (source_path, source_conn) = fresh_sqlite("rowfilter").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, qty INTEGER NOT NULL)",
            None,
        )
        .await
        .expect("create source table");
    source_conn
        .execute(
            "INSERT INTO items (id, label, qty) VALUES (1, 'a', 10), (2, 'b', 5), (3, 'c', 20), (4, 'd', 1)",
            None,
        )
        .await
        .expect("seed source rows");
    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_filter_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        false,
    );
    let source_session_id = state.insert(source_session).await;

    // 危険な条件は何も作らずに拒否する。
    for bad in ["1=1; DROP TABLE items", "1=1) OR (1=1", "qty > 1 -- x"] {
        let err = t::create_sandbox_with_filters_via_command(
            &state,
            &source_session_id,
            None,
            "bad",
            vec![t::SandboxTableSpec {
                name: "items".into(),
                filter: Some(bad.into()),
            }],
            false,
            Some(100),
        )
        .await
        .expect_err("a breaking filter must be rejected");
        assert_eq!(err.kind(), "invalidInput", "{bad}");
    }

    let create = t::create_sandbox_with_filters_via_command(
        &state,
        &source_session_id,
        None,
        "filtered",
        vec![t::SandboxTableSpec {
            name: "items".into(),
            filter: Some("qty >= 10".into()),
        }],
        false,
        Some(100),
    )
    .await
    .expect("create_sandbox with filter");
    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };
    assert_eq!(create.sandbox.row_filters.len(), 1);
    assert_eq!(create.sandbox.row_filters[0].table, "items");
    assert_eq!(create.sandbox.row_filters[0].filter, "qty >= 10");
    assert!(create.sandbox.truncated_tables.is_empty());

    let sandbox_session = state
        .get(&create.session_id)
        .await
        .expect("sandbox session registered");
    let copied = sandbox_session
        .conn
        .execute("SELECT id FROM items ORDER BY id", None)
        .await
        .expect("select from sandbox copy");
    let ids: Vec<String> = copied.rows.iter().map(|r| format!("{:?}", r[0])).collect();
    assert_eq!(ids.len(), 2, "{ids:?}");

    // 実 DB の競合検出も同じ条件で読むので、条件外の行 (id 2, 4) は差分に現れない。
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
    assert!(diff.desired.rows.is_empty());

    guard.discard().await;
    let _ = std::fs::remove_file(&source_path);
}

/// SCRATCH 分類 (`readOnlyGuardParity.test.ts`) の実挙動側 (#1882)。read_only の**元セッション**から
/// `create_sandbox` / `discard_sandbox` を行っても、
///   - サンドボックス (スクラッチ領域) の作成・破棄は許可される (元は読むだけ)
///   - 元 DB のデータ・スキーマは一切変わらない
///   - 抽出条件に書き込み文を忍ばせても元 DB へ届かない (`checked_row_filter` が拒否)
/// ことを固定する。SCRATCH のコマンドが将来ユーザセッションへ書き込む経路を得たら、
/// 元の行が変わるのでここが落ちる。
#[tokio::test]
async fn read_only_source_session_can_sandbox_but_source_is_never_written() {
    let (source_path, source_conn) = fresh_sqlite("scratch_ro_source").await;
    source_conn
        .execute(
            "CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
            None,
        )
        .await
        .expect("create source table");
    source_conn
        .execute(
            "INSERT INTO items (id, label) VALUES (1, 'a'), (2, 'b')",
            None,
        )
        .await
        .expect("seed source rows");

    let state = std::sync::Arc::new(t::AppState::default());
    let source_session = t::make_session(
        "sbx_scratch_ro_source",
        source_conn,
        t::sqlite_options(source_path.to_str().expect("utf8 path")),
        /* read_only */ true,
    );
    let source_session_id = state.insert(source_session).await;

    // 書き込み文を忍ばせた抽出条件は拒否され、元 DB には何も届かない。
    let err = t::create_sandbox_with_filters_via_command(
        &state,
        &source_session_id,
        None,
        "evil filter",
        vec![t::SandboxTableSpec {
            name: "items".to_string(),
            filter: Some("1 = 1; DELETE FROM items".to_string()),
        }],
        false,
        Some(100),
    )
    .await
    .expect_err("a filter smuggling a write must be rejected");
    assert!(matches!(err, t::AppError::InvalidInput(_)), "{err:?}");

    // 通常の作成は read_only の元からでも通る (スクラッチ領域への書き込みだけ)。
    let create = t::create_sandbox_via_command(
        &state,
        &source_session_id,
        None,
        "scratch from read-only",
        vec!["items".to_string()],
        false,
        Some(100),
    )
    .await
    .expect("create_sandbox from a read-only source");
    let guard = DiscardGuard {
        state: state.clone(),
        sandbox_id: Some(create.sandbox.id.clone()),
        session_id: Some(create.session_id.clone()),
    };
    let sandbox_session = state
        .get(&create.session_id)
        .await
        .expect("sandbox session registered");
    assert!(
        !sandbox_session.read_only,
        "サンドボックスはスクラッチなので書き込み可能"
    );
    assert_ne!(
        sandbox_session.id, source_session_id,
        "サンドボックスは元とは別セッション"
    );
    let copied = sandbox_session
        .conn
        .execute("SELECT id FROM items ORDER BY id", None)
        .await
        .expect("select from sandbox copy");
    assert_eq!(copied.rows.len(), 2);

    // サンドボックスの破棄 (元セッション ID を渡す誤用を含む) は元セッションを閉じない。
    t::discard_sandbox_via_command(&state, &create.sandbox.id, Some(&source_session_id))
        .await
        .expect("discard with an unrelated session id");
    assert!(
        state.get(&source_session_id).await.is_some(),
        "無関係な session_id の破棄で元セッションが閉じてはならない"
    );
    guard.discard().await;

    // 元 DB は最初のまま (行もスキーマも)。
    let after = state
        .get(&source_session_id)
        .await
        .expect("source session")
        .conn
        .execute("SELECT id, label FROM items ORDER BY id", None)
        .await
        .expect("select source");
    assert_eq!(after.rows.len(), 2, "元の行数が変わらない");
    let tables = state
        .get(&source_session_id)
        .await
        .expect("source session")
        .conn
        .execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            None,
        )
        .await
        .expect("list source tables");
    assert_eq!(
        tables.rows.len(),
        1,
        "元に表が増えていない: {:?}",
        tables.rows
    );

    state
        .get(&source_session_id)
        .await
        .expect("source session")
        .conn
        .close()
        .await;
    let _ = std::fs::remove_file(&source_path);
}
