//! 結果ハンドル (#1264) を、実際の SQLite の `execute_stream` に通して検証する。
//!
//! `spawn_query_stream` は Tauri の `AppHandle` / `Channel` を要するため統合テストから
//! 直接は駆動できない。ここでは同じ部品 (`ResultBuilder` → `ResultStore` → `result_*`
//! コマンドのコア) を、`spawn_query_stream` と同じ順序 (ドライバのバッチ → 行の複製 →
//! 成功後にストアへ確定) で実ドライバの出力に当てる。メモリ上限・LRU・超過時のフォール
//! バック (ハンドルなし) もここで確認する。外部サーバ不要で常時実行できる。

use noobdb_lib::__test_api as t;

async fn sqlite_conn(tag: &str) -> (t::Connection, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_result_handle_{tag}_{}.db",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().expect("utf8 path")))
        .await
        .expect("connect");
    (conn, path)
}

async fn seed(conn: &t::Connection, n: i64) {
    conn.execute(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        &format!(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < {n}) \
             INSERT INTO t SELECT x, 'name' || (x % 1000), CASE WHEN x % 7 = 0 THEN NULL ELSE (x * 37) % 1000 / 4.0 END FROM c"
        ),
        None,
    )
    .await
    .expect("seed");
}

/// `spawn_query_stream` と同じ手順で、ストリームしながら行を複製して溜める。
/// 戻り値は (ストリームで流れた総行数, builder.finish())。
async fn stream_into_builder(
    conn: &t::Connection,
    sql: &str,
    limit: usize,
) -> (usize, Option<(Vec<Vec<t::Value>>, usize)>, usize) {
    let mut builder = t::ResultBuilder::new(limit);
    let mut delivered = 0usize;
    let mut cols = 0usize;
    conn.execute_stream(sql, None, 200, 200, |batch| {
        match batch {
            t::StreamBatch::Columns(c) => cols = c.len(),
            t::StreamBatch::Rows(rows) => {
                delivered += rows.len();
                builder.push_batch(&rows);
            }
        }
        Ok(())
    })
    .await
    .expect("stream");
    (delivered, builder.finish(), cols)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retained_rows_answer_sort_filter_find_and_export_like_the_database() {
    let (conn, path) = sqlite_conn("ops").await;
    seed(&conn, 12_000).await;

    let (delivered, kept, cols) =
        stream_into_builder(&conn, "SELECT * FROM t ORDER BY id", usize::MAX).await;
    assert_eq!(delivered, 12_000);
    let (rows, bytes) = kept.expect("12,000 行は保持される");
    assert_eq!(rows.len(), 12_000);

    let state = t::AppState::default();
    assert!(state.results.lock().expect("lock").insert(
        "r1".into(),
        "sess".into(),
        cols,
        rows,
        bytes
    ));

    // 降順ソート: 先頭は id = 12000。NULL の score は最後 (昇順) / 最初 (降順)。
    let order = t::result_sort_filter_inner(
        &state,
        "r1",
        vec![t::SortSpec {
            col: 0,
            kind: t::SortKind::Numeric,
            desc: true,
        }],
        vec![],
        String::new(),
    )
    .await
    .expect("sort")
    .expect("handle exists");
    assert_eq!(order.len(), 12_000);
    assert_eq!(order[0], 11_999);
    assert_eq!(order[11_999], 0);

    // score 昇順: NULL (x % 7 = 0) は最後にまとまり、その中は元の行順。
    let by_score = t::result_sort_filter_inner(
        &state,
        "r1",
        vec![t::SortSpec {
            col: 2,
            kind: t::SortKind::Numeric,
            desc: false,
        }],
        vec![],
        String::new(),
    )
    .await
    .expect("sort")
    .expect("handle exists");
    let nulls = 12_000 / 7;
    let tail = &by_score[by_score.len() - nulls..];
    assert!(tail.windows(2).all(|w| w[0] < w[1]), "NULL 群は元の行順");
    assert!(tail.iter().all(|&i| (i + 1) % 7 == 0));

    // フィルタ: name が "name99" を含む行 (x % 1000 が 99 / 990..=999 → name99, name990..name999)。
    let filtered = t::result_sort_filter_inner(
        &state,
        "r1",
        vec![],
        vec![t::FilterSpec {
            col: 1,
            op: t::FilterOp::Contains,
            value: "NAME99".into(),
            value2: String::new(),
            null_mode: t::NullMode::Any,
        }],
        String::new(),
    )
    .await
    .expect("filter")
    .expect("handle exists");
    let expected = conn
        .execute(
            "SELECT count(*) FROM t WHERE lower(name) LIKE '%name99%'",
            None,
        )
        .await
        .expect("count");
    let expected_count = match &expected.rows[0][0] {
        t::Value::Int(n) => *n as usize,
        other => panic!("unexpected count value {other:?}"),
    };
    assert_eq!(filtered.len(), expected_count);

    // 検索: 上限で打ち切り、総数は数え続ける。
    let found = t::result_find_inner(
        &state,
        "r1",
        "name99".into(),
        t::FindOptions {
            case_sensitive: true,
            whole_cell: false,
        },
        5,
    )
    .await
    .expect("find")
    .expect("handle exists");
    assert_eq!(found.hits.len(), 5);
    assert_eq!(found.total as usize, expected_count);
    assert!(found.truncated);

    // 列統計: id の件数・最小・最大。
    let stats = t::result_column_stats_inner(&state, "r1", 0)
        .await
        .expect("stats")
        .expect("handle exists");
    assert_eq!(stats.count, 12_000);
    assert_eq!(stats.min, Some(1.0));
    assert_eq!(stats.max, Some(12_000.0));

    // エクスポート文字列: ハンドル経由と、DB から取り直した行の直接渡しが一致する。
    let columns = vec![
        t::Column {
            name: "id".into(),
            type_name: "INTEGER".into(),
        },
        t::Column {
            name: "name".into(),
            type_name: "TEXT".into(),
        },
        t::Column {
            name: "score".into(),
            type_name: "REAL".into(),
        },
    ];
    let direct = conn
        .execute("SELECT * FROM t ORDER BY id", None)
        .await
        .expect("select");
    let request = |rows: Vec<Vec<t::Value>>, result_id: Option<String>| t::RenderExportRequest {
        format: t::ExportFormat::Csv,
        columns: columns.clone(),
        rows,
        result_id,
        query: None,
        table: None,
        driver: None,
        batch_size: None,
        masks: None,
    };
    let via_handle = t::render_export_text_inner(&state, request(vec![], Some("r1".into())))
        .await
        .expect("render via handle");
    let via_rows = t::render_export_text_inner(&state, request(direct.rows, None))
        .await
        .expect("render via rows");
    assert_eq!(via_handle, via_rows);

    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_result_over_the_memory_limit_gets_no_handle_but_still_streams_fully() {
    let (conn, path) = sqlite_conn("limit").await;
    seed(&conn, 8_000).await;

    // 全行の概算サイズを測ってから、その半分を上限にする。
    let (_, full, _) = stream_into_builder(&conn, "SELECT * FROM t", usize::MAX).await;
    let (_, full_bytes) = full.expect("unbounded retains");

    let (delivered, kept, _) = stream_into_builder(&conn, "SELECT * FROM t", full_bytes / 2).await;
    assert_eq!(
        delivered, 8_000,
        "保持できなくてもストリーム自体は全行流れる"
    );
    assert!(
        kept.is_none(),
        "上限超過の結果はハンドルなし (JS 経路へフォールバック)"
    );

    // 小さすぎる結果 (MIN_RETAIN_ROWS 未満) も保持しない。
    let (delivered, kept, _) =
        stream_into_builder(&conn, "SELECT * FROM t WHERE id <= 100", usize::MAX).await;
    assert_eq!(delivered, 100);
    assert!(kept.is_none());

    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_store_evicts_least_recently_used_results_and_reports_gone() {
    let (conn, path) = sqlite_conn("lru").await;
    seed(&conn, 6_000).await;
    let (_, kept, cols) = stream_into_builder(&conn, "SELECT * FROM t", usize::MAX).await;
    let (rows, bytes) = kept.expect("retained");

    // 2 つまで入る上限。
    let state = t::AppState::default();
    *state.results.lock().expect("lock") = t::ResultStore::new(bytes * 2 + bytes / 2);
    for id in ["a", "b"] {
        assert!(state.results.lock().expect("lock").insert(
            id.into(),
            "sess".into(),
            cols,
            rows.clone(),
            bytes
        ));
    }
    // a を使って b を最古にしてから c を入れる → b が追い出される。
    assert!(t::result_column_stats_inner(&state, "a", 0)
        .await
        .expect("stats")
        .is_some());
    assert!(state.results.lock().expect("lock").insert(
        "c".into(),
        "sess".into(),
        cols,
        rows.clone(),
        bytes
    ));
    assert!(t::result_column_stats_inner(&state, "b", 0)
        .await
        .expect("stats")
        .is_none());
    assert!(
        t::result_sort_filter_inner(&state, "b", vec![], vec![], String::new())
            .await
            .expect("sort")
            .is_none()
    );
    let err = t::resolve_rows(&state, Some("b"), vec![]).expect_err("gone");
    assert!(err.to_string().contains(t::RESULT_GONE));
    {
        let store = state.results.lock().expect("lock");
        assert!(store.used_bytes() <= store.limit());
        assert_eq!(store.len(), 2);
    }

    // セッション切断相当: 同じセッションの結果は全て破棄される。
    assert_eq!(
        state.results.lock().expect("lock").release_session("sess"),
        2
    );
    assert!(state.results.lock().expect("lock").is_empty());

    drop(conn);
    let _ = std::fs::remove_file(&path);
}
