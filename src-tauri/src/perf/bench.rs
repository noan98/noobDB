//! 代表データセット（小・中・大量行）でのベースライン計測ハーネス (#1094)。
//!
//! 実 DB (MySQL/PostgreSQL/MSSQL) は統合テストと同じく環境変数ゲートが必要に
//! なるため、ここでは常時実走できる SQLite (bundled) 上で「行数だけを変えた
//! 同一形状のクエリ」を実行し、[`Connection::execute`] の `elapsed_ms` を記録する。
//! 実測値そのものは実行環境 (CI ランナーのスペック等) に依存するため、このテスト
//! では極端な悪化だけを検出する緩いしきい値で回帰の土台とし、絶対値の記録は
//! `NOOBDB_PERF_LOG=1 RUST_LOG=noobdb::perf=debug cargo test perf::bench --
//! --nocapture --test-threads=1` を実行し、`tracing` の `noobdb::perf` ログから
//! 拾う運用を想定する (テストバイナリにはアプリ本体と違いトレーシング
//! サブスクライバが既定で無いため、この mod の `tests::init_test_tracing` が
//! 代わりに張る)。
//!
//! データセットは合成データのみで、個人情報もセル実データも含まない。

/// 代表データセットの定義: `(名前, 行数)`。
/// - `small`: 一覧画面を素早く開いたときの体感 (TTFR/TTI) を左右する規模。
/// - `medium`: 通常運用でよく見る規模。
/// - `large`: ストリーミング/仮想化の効果が効いてくる規模。
///
/// `perf` モジュール自体が非公開 (`mod perf;`) なので、テスト以外から参照されない
/// この定数は非テストビルドでは dead_code になる。テストからのみ使うため
/// `#[cfg(test)]` を付ける。
#[cfg(test)]
pub const DATASET_CASES: &[(&str, usize)] = &[("small", 200), ("medium", 5_000), ("large", 30_000)];

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use crate::db::{Connection, DbConnectOptions, DriverKind};

    /// テスト用の一時 SQLite ファイル。`Connection::connect` は
    /// `create_if_missing(false)` で開くため、ファイル自体は事前に作成しておく
    /// 必要がある (`commands::sandbox` と同じ制約)。`Drop` で必ず削除する。
    struct TempSqliteFile(PathBuf);

    impl TempSqliteFile {
        fn create() -> Self {
            let mut path = std::env::temp_dir();
            let unique = format!(
                "noobdb-perf-bench-{}-{}.sqlite",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            path.push(unique);
            // テストコードなので unwrap は許容 (clippy.toml の allow-unwrap-in-tests)。
            std::fs::File::create(&path).expect("failed to create temp sqlite file for perf bench");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempSqliteFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            let _ = std::fs::remove_file(format!("{}-wal", self.0.display()));
            let _ = std::fs::remove_file(format!("{}-shm", self.0.display()));
        }
    }

    async fn connect(path: &Path) -> Connection {
        let opts = DbConnectOptions {
            host: String::new(),
            port: 0,
            user: String::new(),
            password: String::new(),
            database: None,
            driver: DriverKind::Sqlite,
            file_path: Some(path.to_string_lossy().to_string()),
            ssl_mode: None,
            ssl_root_cert: None,
            ssl_client_cert: None,
            ssl_client_key: None,
            init_sql: None,
        };
        Connection::connect(&opts)
            .await
            .expect("failed to open temp sqlite connection for perf bench")
    }

    /// `n` 行の合成データ (実 PII なし) を 1 回の INSERT で流し込む SQL を組み立てる。
    /// ベンチの対象は SELECT 側なので、セットアップの INSERT はできるだけ 1 文に
    /// まとめて速く済ませる。
    fn build_seed_sql(n: usize) -> String {
        let mut sql = String::from(
            "CREATE TABLE bench_rows (id INTEGER PRIMARY KEY, name TEXT NOT NULL, amount REAL NOT NULL, created_at TEXT NOT NULL);\n",
        );
        sql.push_str("INSERT INTO bench_rows (id, name, amount, created_at) VALUES ");
        for i in 0..n {
            if i > 0 {
                sql.push(',');
            }
            sql.push_str(&format!(
                "({i}, 'row-{i}', {amount:.2}, '2026-01-{day:02}T00:00:00Z')",
                i = i,
                amount = (i % 1000) as f64 * 1.5,
                day = (i % 28) + 1,
            ));
        }
        sql.push(';');
        sql
    }

    /// テストバイナリにはアプリ本体 (`lib.rs::run()`) と違いトレーシング
    /// サブスクライバが既定で無いため、モジュール冒頭のドキュメントで案内している
    /// `NOOBDB_PERF_LOG=1 cargo test perf::bench -- --nocapture` を実際に機能させる
    /// には、ここで一度張る必要がある。`try_init` は多重初期化時に `Err` を返す
    /// だけ (panic しない) ので、複数テストから呼んでも安全。
    fn init_test_tracing() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
            .with_test_writer()
            .try_init();
    }

    /// 1 つの代表データセットについて、シード投入 → `SELECT * FROM bench_rows`
    /// を実行し、返ってきた `QueryResult` の行数を検証する。所要時間そのものは
    /// CI ランナーのスペックに依存するため、この関数では緩い上限 (数十秒) しか
    /// 課さない — 目的は「実行できること」と「桁が違う規模の劣化を検出する土台」
    /// であり、厳密な性能アサーションではない。
    async fn run_case(name: &str, n: usize) {
        init_test_tracing();
        let file = TempSqliteFile::create();
        let conn = connect(file.path()).await;
        let seed_sql = build_seed_sql(n);
        conn.execute_transaction(&[seed_sql], None)
            .await
            .unwrap_or_else(|e| panic!("perf bench '{name}' seed failed: {e}"));

        let result = conn
            .execute("SELECT * FROM bench_rows", None)
            .await
            .unwrap_or_else(|e| panic!("perf bench '{name}' query failed: {e}"));

        assert_eq!(
            result.rows.len(),
            n,
            "perf bench '{name}': unexpected row count"
        );
        // 極端な回帰 (例: O(n^2) 劣化やデッドロック) だけを検出する緩い上限。
        // 通常の SQLite 実行なら 30,000 行でも数百 ms 程度で終わる。
        assert!(
            result.elapsed_ms < 30_000,
            "perf bench '{name}' took {}ms — investigate a possible performance regression",
            result.elapsed_ms
        );

        // NOOBDB_PERF_LOG=1 を立てて `cargo test perf::bench -- --nocapture` を
        // 実行すると、ここで実測値がベースラインとして得られる。
        crate::perf::log_query_execute(
            "perf-bench",
            Some(result.elapsed_ms as f64),
            result.rows.len(),
            result.columns.len(),
        );

        conn.close().await;
    }

    #[tokio::test]
    async fn baseline_small_dataset() {
        run_case("small", 200).await;
    }

    #[tokio::test]
    async fn baseline_medium_dataset() {
        run_case("medium", 5_000).await;
    }

    #[tokio::test]
    async fn baseline_large_dataset() {
        run_case("large", 30_000).await;
    }

    #[test]
    fn dataset_cases_are_defined_and_sorted_by_size() {
        let sizes: Vec<usize> = super::DATASET_CASES.iter().map(|(_, n)| *n).collect();
        assert_eq!(sizes.len(), 3);
        assert!(
            sizes.windows(2).all(|w| w[0] < w[1]),
            "dataset cases should grow monotonically"
        );
    }
}
