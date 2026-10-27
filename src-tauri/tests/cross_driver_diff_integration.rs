//! ドライバをまたぐデータ比較 (#1869) の実 DB 統合テスト (MySQL ⇔ PostgreSQL)。
//!
//! `NOOBDB_TEST_MYSQL_URL` と `NOOBDB_TEST_POSTGRES_URL` の両方が設定されているときだけ走る
//! (どちらかが無ければスキップ)。同じ内容の表を両側に作り、表現の違い (真偽・decimal・日時・
//! JSON・2^53 超の BIGINT) が差分にならないこと、実際の差分は検出されること、結果が検証専用で
//! 同期 SQL を出さないことを確かめる。

use noobdb_lib::__test_api as t;
use t::{RowStatus, Value};

const TABLE: &str = "noobdb_xdiff_1869";
const TEXT_KEY_TABLE: &str = "noobdb_xdiff_1869_text";

async fn connect_both() -> Option<(t::Connection, String, t::Connection, String)> {
    let (Ok(mysql_url), Ok(pg_url)) = (
        std::env::var("NOOBDB_TEST_MYSQL_URL"),
        std::env::var("NOOBDB_TEST_POSTGRES_URL"),
    ) else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL / NOOBDB_TEST_POSTGRES_URL not both set");
        return None;
    };
    let mysql_opts = t::parse_mysql_url(&mysql_url).expect("valid mysql url");
    let mysql_db = mysql_opts
        .database
        .clone()
        .expect("mysql test url must include a database");
    let mysql = t::connect(&mysql_opts).await.expect("connect mysql");
    let pg = t::connect(&t::parse_postgres_url(&pg_url).expect("valid postgres url"))
        .await
        .expect("connect postgres");
    // PostgreSQL では「データベース」軸がスキーマ。
    Some((mysql, mysql_db, pg, "public".to_string()))
}

async fn run(conn: &t::Connection, db: &str, sql: &str) {
    conn.execute(sql, Some(db))
        .await
        .unwrap_or_else(|e| panic!("sql failed: {sql}: {e}"));
}

async fn setup(mysql: &t::Connection, mysql_db: &str, pg: &t::Connection, pg_db: &str) {
    for (conn, db) in [(mysql, mysql_db), (pg, pg_db)] {
        for table in [TABLE, TEXT_KEY_TABLE] {
            run(conn, db, &format!("DROP TABLE IF EXISTS {table}")).await;
        }
    }
    run(
        mysql,
        mysql_db,
        &format!(
            "CREATE TABLE {TABLE} (id BIGINT PRIMARY KEY, flag TINYINT(1), price DECIMAL(10,2), \
             at DATETIME(6), doc JSON, name VARCHAR(20))"
        ),
    )
    .await;
    run(
        pg,
        pg_db,
        &format!(
            "CREATE TABLE {TABLE} (id BIGINT PRIMARY KEY, flag BOOLEAN, price NUMERIC(10,2), \
             at TIMESTAMP(6), doc JSONB, name VARCHAR(20))"
        ),
    )
    .await;
    let rows = "(1, {T}, 1.10, '2024-01-02 03:04:05', '{\"a\":1,\"b\":[1,2]}', 'x'), \
                (2, {F}, 2.50, '2024-01-02 03:04:05.5', '{\"k\": \"v\"}', NULL), \
                (9007199254740993, {T}, 0.00, '2024-12-31 23:59:59.999999', '[1, 2, 3]', 'big')";
    let insert = |t: &str, f: &str| {
        format!(
            "INSERT INTO {TABLE} (id, flag, price, at, doc, name) VALUES {}",
            rows.replace("{T}", t).replace("{F}", f)
        )
    };
    run(mysql, mysql_db, &insert("1", "0")).await;
    run(pg, pg_db, &insert("true", "false")).await;
    for (conn, db) in [(mysql, mysql_db), (pg, pg_db)] {
        run(
            conn,
            db,
            &format!("CREATE TABLE {TEXT_KEY_TABLE} (code VARCHAR(10) PRIMARY KEY, v INT)"),
        )
        .await;
    }
}

async fn cleanup(mysql: &t::Connection, mysql_db: &str, pg: &t::Connection, pg_db: &str) {
    for (conn, db) in [(mysql, mysql_db), (pg, pg_db)] {
        for table in [TABLE, TEXT_KEY_TABLE] {
            let _ = conn
                .execute(&format!("DROP TABLE IF EXISTS {table}"), Some(db))
                .await;
        }
    }
}

#[tokio::test]
async fn mysql_vs_postgres_data_diff_normalizes_and_stays_verify_only() {
    let Some((mysql, mysql_db, pg, pg_db)) = connect_both().await else {
        return;
    };
    setup(&mysql, &mysql_db, &pg, &pg_db).await;

    for all_rows in [false, true] {
        // 表現が違うだけなので差分なし。
        let (diff, normalized) = t::compare_table_data_via_core(
            &mysql, &mysql_db, &pg, &pg_db, TABLE, TABLE, None, all_rows, None,
        )
        .await
        .expect("compare");
        assert!(
            diff.rows.is_empty(),
            "representation-only differences must not be reported (all_rows={all_rows}): {:?}",
            diff.rows
        );
        assert_eq!(diff.source_count, 3);
        assert_eq!(diff.target_count, 3);
        let kinds: Vec<_> = normalized
            .iter()
            .map(|n| (n.column.as_str(), n.kind))
            .collect();
        for expected in [
            ("flag", t::NormalizeKind::Boolean),
            ("price", t::NormalizeKind::DecimalScale),
            ("at", t::NormalizeKind::TimestampFormat),
            ("doc", t::NormalizeKind::Json),
        ] {
            assert!(
                kinds.contains(&expected),
                "missing {expected:?} in {kinds:?}"
            );
        }
    }

    // 実際の差分: MySQL だけの 4、PostgreSQL だけの 5、price が違う 2。
    run(
        &mysql,
        &mysql_db,
        &format!("INSERT INTO {TABLE} VALUES (4, 1, 4.00, '2024-02-02 00:00:00', '{{}}', 'm')"),
    )
    .await;
    run(
        &pg,
        &pg_db,
        &format!("INSERT INTO {TABLE} VALUES (5, true, 5.00, '2024-02-02 00:00:00', '{{}}', 'p')"),
    )
    .await;
    run(
        &pg,
        &pg_db,
        &format!("UPDATE {TABLE} SET price = 2.51 WHERE id = 2"),
    )
    .await;
    // 無視列にした列は差分にならない (name を変えても出ない)。
    run(
        &pg,
        &pg_db,
        &format!("UPDATE {TABLE} SET name = 'changed' WHERE id = 1"),
    )
    .await;

    for all_rows in [false, true] {
        let (diff, _) = t::compare_table_data_via_core(
            &mysql,
            &mysql_db,
            &pg,
            &pg_db,
            TABLE,
            TABLE,
            None,
            all_rows,
            Some(vec!["name".to_string()]),
        )
        .await
        .expect("compare with diffs");
        let status_of = |s: RowStatus| -> Vec<Vec<Value>> {
            diff.rows
                .iter()
                .filter(|r| r.status == s)
                .map(|r| r.key.clone())
                .collect()
        };
        assert_eq!(status_of(RowStatus::SourceOnly), vec![vec![Value::Int(4)]]);
        assert_eq!(status_of(RowStatus::TargetOnly), vec![vec![Value::Int(5)]]);
        assert_eq!(status_of(RowStatus::Different), vec![vec![Value::Int(2)]]);
        let changed = diff
            .rows
            .iter()
            .find(|r| r.status == RowStatus::Different)
            .map(|r| r.changed_columns.clone());
        assert_eq!(changed, Some(vec!["price".to_string()]));

        // 検証専用: 同期 SQL は出さない。
        let plan = t::generate_data_sync_sql(&diff, true);
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
        assert!(!plan.warnings.is_empty());
    }

    // 文字列の主キーは並びがドライバで違うので比較しない。
    let err = t::compare_table_data_via_core(
        &mysql,
        &mysql_db,
        &pg,
        &pg_db,
        TEXT_KEY_TABLE,
        TEXT_KEY_TABLE,
        None,
        false,
        None,
    )
    .await
    .expect_err("text primary keys are rejected across drivers");
    assert!(err.to_string().contains("integer primary keys"), "{err}");

    cleanup(&mysql, &mysql_db, &pg, &pg_db).await;
}
