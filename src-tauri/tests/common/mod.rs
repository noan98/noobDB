//! 統合テスト共通のヘルパ (#1263)。`load_schema_tree` / `open_table(s)` /
//! `list_tables_all` / `table_row_estimate` のコマンド層の結果が、従来フロントが
//! 個別 IPC で組み立てていた内容 (`tables` / `columns` / `list_indexes` /
//! `table_row_estimates` …) と一致することを検証する。

#![allow(dead_code)]

use noobdb_lib::__test_api as t;

/// `tables` は `db` に実在する 4 件以上のテーブル (一括取得の経路も通すため)。
pub async fn assert_tree_and_open_match_individual_ipcs(
    state: &t::AppState,
    sid: &str,
    conn: &t::Connection,
    db: &str,
    tables: &[String],
) {
    assert!(tables.len() >= 4, "need >=4 tables to cover the bulk path");
    let ghost_key = format!("{db}::no_such_table_1263");
    let estimates = conn.table_row_estimates(db).await.expect("estimates");

    // 件数の少ない要求 (テーブルごと) と多い要求 (DB 単位の一括) の両方。
    for take in [1usize, tables.len()] {
        let mut keys: Vec<String> = tables[..take]
            .iter()
            .map(|x| format!("{db}::{x}"))
            .collect();
        keys.push(ghost_key.clone());
        let tree = t::load_schema_tree_via_command(
            state,
            sid,
            vec![
                db.to_string(),
                "no_such_db_1263".to_string(),
                db.to_string(),
            ],
            keys.clone(),
        )
        .await
        .expect("load_schema_tree");

        // 他のテストが別 DB を作る/消す可能性があるので、全体一致ではなく包含で見る。
        assert!(tree.databases.iter().any(|d| d == db));
        assert_eq!(tree.open.len(), 1, "unknown/duplicate dbs are dropped");
        let open = &tree.open[0];
        assert_eq!(open.database, db);
        assert_eq!(open.tables, Some(conn.tables(db).await.expect("tables")));
        assert_eq!(
            format!("{:?}", open.row_estimates),
            format!("{:?}", Some(estimates.clone()))
        );
        assert_eq!(
            format!("{:?}", open.objects),
            format!("{:?}", conn.schema_objects(db).await.expect("objects"))
        );
        assert_eq!(
            format!("{:?}", open.comments),
            format!(
                "{:?}",
                Some(conn.table_comments(db).await.expect("comments"))
            )
        );

        assert_eq!(tree.tables.len(), take, "ghost table is skipped");
        for (i, table) in tables[..take].iter().enumerate() {
            let got = &tree.tables[i];
            assert_eq!(got.key, format!("{db}::{table}"));
            assert_eq!(
                format!("{:?}", got.columns),
                format!("{:?}", conn.columns(db, table).await.expect("columns")),
                "columns of {table} (take={take})"
            );
            assert_eq!(
                format!("{:?}", got.indexes),
                format!("{:?}", conn.list_indexes(db, table).await.expect("indexes")),
                "indexes of {table} (take={take})"
            );
        }
    }

    // open_table: 列・行識別・SQL・行数推定
    let first = &tables[0];
    let opened = t::open_table_via_command(state, sid, db, first, 25, true)
        .await
        .expect("open_table");
    assert_eq!(
        format!("{:?}", opened.columns),
        format!("{:?}", conn.columns(db, first).await.expect("columns"))
    );
    let hidden = opened
        .row_identity
        .as_ref()
        .filter(|i| i.strategy == "rowid" || i.strategy == "ctid")
        .and_then(|i| i.hidden_column.clone());
    let base = t::table_select_sql(conn.driver_kind(), db, first, hidden.as_deref());
    assert_eq!(opened.base, base);
    assert_eq!(opened.sql, format!("{base} LIMIT 25"));
    let expected_est = estimates
        .iter()
        .find(|e| &e.name == first)
        .and_then(|e| e.estimate);
    assert_eq!(opened.row_estimate, expected_est);
    let without = t::open_table_via_command(state, sid, db, first, 25, false)
        .await
        .expect("open_table");
    assert_eq!(without.row_estimate, None);

    // table_row_estimate (1 件) は table_row_estimates から引いた値と一致する。
    for table in tables {
        let single = conn.table_row_estimate(db, table).await.expect("estimate");
        let expected = estimates
            .iter()
            .find(|e| &e.name == table)
            .and_then(|e| e.estimate);
        assert_eq!(single, expected, "row estimate of {table}");
    }
    assert_eq!(
        conn.table_row_estimate(db, "no_such_table_1263")
            .await
            .expect("estimate"),
        None
    );

    // open_tables: 要求順・テーブルごとの失敗の切り分け
    let req = vec![
        (db.to_string(), tables[1].clone()),
        (db.to_string(), "no_such_table_1263".to_string()),
        (db.to_string(), tables[0].clone()),
    ];
    let batch = t::open_tables_via_command(state, sid, req, 10)
        .await
        .expect("open_tables");
    assert_eq!(batch.len(), 3);
    assert_eq!(batch[0].table, tables[1]);
    assert!(batch[0].result.is_some() && batch[0].error.is_none());
    // 存在しないテーブルは `describe_table` と同じ扱い: ドライバによってエラー、
    // または空の列 (従来のフロントの挙動をそのまま保つ)。
    assert_eq!(batch[1].table, "no_such_table_1263");
    match (&batch[1].result, &batch[1].error) {
        (None, Some(_)) => {}
        (Some(r), None) => assert!(r.columns.is_empty()),
        other => panic!("unexpected result for a missing table: {other:?}"),
    }
    assert_eq!(batch[2].table, tables[0]);
    let r = batch[2].result.as_ref().expect("result");
    assert!(r.sql.ends_with(" LIMIT 10"));
    assert_eq!(r.row_estimate, None, "batch open skips the estimate");

    // list_tables_all: 対象 DB のテーブルが list_tables と同一。
    let all = conn.tables_all().await.expect("tables_all");
    let entry = all
        .iter()
        .find(|d| d.database == db)
        .expect("db is listed by tables_all");
    assert_eq!(entry.tables, conn.tables(db).await.expect("tables"));
    let names: Vec<&String> = all.iter().map(|d| &d.database).collect();
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(names.len(), sorted.len(), "no duplicated database entries");
}
