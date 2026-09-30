//! ストリーミング結果のバッチ合流・逐次統計・自動リフレッシュ差分 (#1257) を、実際の
//! SQLite の `execute_stream` に通して検証する。
//!
//! `spawn_query_stream` は Tauri の `AppHandle` / `Channel` を要するため統合テストから
//! 直接は駆動できない。ここでは同じ部品 (`StreamBatcher` / `StreamStats` /
//! `RefreshBuilder`) を、`spawn_query_stream` と同じ順序 (ドライバのバッチ → 合流 →
//! 統計) で実ドライバの出力に当てる。外部サーバ不要で常時実行できる。

use std::time::Instant;

use noobdb_lib::__test_api as t;

async fn sqlite_conn(tag: &str) -> (t::Connection, std::path::PathBuf) {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_batching_{tag}_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let conn = t::connect(&t::sqlite_options(path.to_str().expect("utf8 path")))
        .await
        .expect("connect");
    (conn, path)
}

/// `n` 行の表 (id 主キー, name, amount は NULL / 文字列の数値を混ぜる)。
async fn seed(conn: &t::Connection, n: i64) {
    conn.execute(
        "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, amount TEXT)",
        None,
    )
    .await
    .expect("create");
    conn.execute(
        &format!(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < {n}) \
             INSERT INTO t SELECT x, 'n' || x, CASE WHEN x % 10 = 0 THEN NULL ELSE CAST(x % 97 AS TEXT) || '.5' END FROM c"
        ),
        None,
    )
    .await
    .expect("seed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn coalescing_reduces_messages_and_keeps_first_batch_and_totals() {
    let (conn, path) = sqlite_conn("coalesce").await;
    seed(&conn, 10_000).await;

    let mut batcher = t::StreamBatcher::new(200);
    let mut stats = t::StreamStats::new();
    let mut sent: Vec<usize> = Vec::new();
    let res = conn
        .execute_stream("SELECT * FROM t ORDER BY id", None, 200, 200, |batch| {
            if let t::StreamBatch::Rows(rows) = batch {
                if let Some(out) = batcher.push(rows, Instant::now()) {
                    stats.observe(&out);
                    sent.push(out.len());
                }
            }
            Ok(())
        })
        .await
        .expect("stream");
    if let Some(rest) = batcher.finish() {
        stats.observe(&rest);
        sent.push(rest.len());
    }

    assert_eq!(res.rows_affected, 10_000);
    assert_eq!(
        sent.iter().sum::<usize>(),
        10_000,
        "合流しても総行数は変わらない"
    );
    // 初回バッチは合流させず即送信 (最初の行が出るまでの時間を悪化させない)。
    assert_eq!(sent[0], 200);
    // 50 回 (10,000 / 200) のドライババッチが、明らかに少ない送信回数にまとまる。
    assert!(
        sent.len() < 25,
        "合流後の送信回数が多すぎる: {}",
        sent.len()
    );

    let snap = stats.snapshot();
    assert_eq!(snap.row_count, 10_000);
    // amount は x % 10 = 0 の行が NULL。
    assert_eq!(snap.null_counts[2], 1_000);
    assert_eq!(snap.null_counts[0], 0);
    // id は 1..=10000、amount は "0.5".."96.5" の文字列 (数値として扱う)。
    assert_eq!(snap.num_min[0], Some(1.0));
    assert_eq!(snap.num_max[0], Some(10_000.0));
    assert_eq!(snap.num_min[2], Some(0.5));
    assert_eq!(snap.num_max[2], Some(96.5));
    assert_eq!(snap.num_min[1], None, "非数値文字列の列は min/max なし");
    assert_eq!(snap.duplicate_rows, Some(false));

    drop(conn);
    let _ = std::fs::remove_file(&path);
}

/// `RefreshBuilder` を実ドライバの出力で回し、再構成したパッチが新しい結果と一致する。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refresh_patch_reconstructs_the_new_result_from_real_rows() {
    let (conn, path) = sqlite_conn("refresh").await;
    seed(&conn, 500).await;

    async fn run(
        conn: &t::Connection,
        prev: Option<std::sync::Arc<t::RefreshSnapshot>>,
    ) -> (Vec<Vec<t::Value>>, t::RefreshOutcome) {
        let mut builder = None;
        let mut rows_all = Vec::new();
        conn.execute_stream("SELECT * FROM t ORDER BY id", None, 50, 50, |batch| {
            match batch {
                t::StreamBatch::Columns(cols) => {
                    builder = t::RefreshBuilder::new(prev.clone(), &[0], &cols);
                }
                t::StreamBatch::Rows(rows) => {
                    let b = builder.as_mut().expect("columns first");
                    for r in &rows {
                        b.observe(r);
                    }
                    rows_all.extend(rows);
                }
            }
            Ok(())
        })
        .await
        .expect("stream");
        (rows_all, builder.expect("builder").finish())
    }

    // 1 回目: 全行 + スナップショット。
    let (first_rows, first) = run(&conn, None).await;
    let mut snap = first.snapshot.expect("snapshot");
    snap.id = 1;
    let snap = std::sync::Arc::new(snap);

    // 変更なし: unchanged。
    let (_, again) = run(&conn, Some(snap.clone())).await;
    let p = again.patch.expect("patch");
    assert!(p.unchanged);
    assert_eq!(p.total_rows, 500);

    // 更新 1 行・削除 1 行・追加 1 行。
    conn.execute("UPDATE t SET name = 'changed' WHERE id = 250", None)
        .await
        .expect("update");
    conn.execute("DELETE FROM t WHERE id = 100", None)
        .await
        .expect("delete");
    conn.execute("INSERT INTO t VALUES (9999, 'new', '1.5')", None)
        .await
        .expect("insert");
    let (second_rows, second) = run(&conn, Some(snap)).await;
    let p = second.patch.expect("patch");
    assert!(!p.unchanged);
    assert_eq!(p.removed_count, 1);
    assert_eq!(p.total_rows, second_rows.len() as u64);

    // パッチを前回結果に適用すると今回の結果と一致する。
    let mut rebuilt: Vec<Vec<t::Value>> = Vec::new();
    let mut inline_rows = 0;
    for run in &p.runs {
        match run {
            t::PatchRun::Keep { from, count } => {
                rebuilt.extend_from_slice(&first_rows[*from as usize..(*from + *count) as usize]);
            }
            t::PatchRun::Rows { rows, .. } => {
                inline_rows += rows.len();
                rebuilt.extend(rows.iter().cloned());
            }
        }
    }
    assert_eq!(rebuilt, second_rows);
    // 実データで送るのは変更行と追加行の 2 行だけ。
    assert_eq!(inline_rows, 2);

    drop(conn);
    let _ = std::fs::remove_file(&path);
}
