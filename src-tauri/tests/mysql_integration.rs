//! Integration test against a live MySQL server.
//!
//! Skipped unless `TABLEX_TEST_MYSQL_URL` is set, e.g.:
//!     mysql://root:rootpw@127.0.0.1:3306/testdb
//!
//! Parses the URL and exercises the `Connection::MySql` path end-to-end:
//! connect, run a query, list databases.

use tablex_lib::__test_api as t;

#[tokio::test]
async fn mysql_roundtrip_when_env_set() {
    let Ok(url) = std::env::var("TABLEX_TEST_MYSQL_URL") else {
        eprintln!("skip: TABLEX_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let res = conn
        .execute("SELECT 1 AS n, 'hello' AS s", None)
        .await
        .expect("query");
    assert_eq!(res.columns.len(), 2);
    assert_eq!(res.rows.len(), 1);
    let dbs = conn.databases().await.expect("show databases");
    assert!(!dbs.is_empty(), "expected at least one database");

    // Regression: `USE` is rejected by MySQL's prepared-statement protocol
    // on servers older than 8.0.23 and on MariaDB (error 1295). Executing a
    // query with a `database` context exercises `apply_use_database`, which
    // must go through the text protocol via `sqlx::raw_sql`.
    if let Some(db) = opts.database.as_deref() {
        let scoped = conn
            .execute("SELECT 1 AS n", Some(db))
            .await
            .expect("scoped query with USE");
        assert_eq!(scoped.rows.len(), 1);
    }

    conn.close().await;
}

/// Regression for the "(影響のあるレコードはありません)" bug: the preview
/// used to snapshot only the first `row_limit` rows of the target table, so
/// an UPDATE or DELETE that touched a row past that window showed empty
/// before/after panes. We now lift the user's WHERE clause out of the
/// statement and use it to filter the BEFORE snapshot, which captures the
/// affected rows regardless of where they sit in the table.
#[tokio::test]
async fn preview_captures_affected_rows_past_row_limit() {
    let Ok(url) = std::env::var("TABLEX_TEST_MYSQL_URL") else {
        eprintln!("skip: TABLEX_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts.database.clone().expect("test url must include a database");
    let conn = t::connect(&opts).await.expect("connect");

    // Fresh table per run — the preview rolls back so leftover rows here
    // would only come from a prior crashed run.
    conn.execute("DROP TABLE IF EXISTS preview_far_row", Some(&db))
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE preview_far_row (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)",
        Some(&db),
    )
    .await
    .expect("create");
    // 150 rows so id=130 sits well past the default 100-row snapshot window.
    let mut values = String::new();
    for i in 1..=150 {
        if i > 1 {
            values.push(',');
        }
        values.push_str(&format!("({},'before')", i));
    }
    conn.execute(
        &format!("INSERT INTO preview_far_row (id, label) VALUES {}", values),
        Some(&db),
    )
    .await
    .expect("seed");

    let preview = conn
        .preview_execute_with_limit(
            "UPDATE preview_far_row SET label = 'after' WHERE id = 130",
            Some(&db),
            100,
        )
        .await
        .expect("preview");

    assert_eq!(preview.rows_affected, 1, "UPDATE should affect 1 row");
    assert_eq!(preview.target_table.as_deref(), Some("preview_far_row"));
    assert_eq!(
        preview.before_rows.len(),
        1,
        "BEFORE snapshot must contain the affected row even though id=130 is past LIMIT 100"
    );
    assert_eq!(
        preview.after_rows.len(),
        1,
        "AFTER snapshot must contain the affected row"
    );
    let id_col = preview
        .columns
        .iter()
        .position(|c| c.name == "id")
        .expect("id column");
    let label_col = preview
        .columns
        .iter()
        .position(|c| c.name == "label")
        .expect("label column");
    assert!(matches!(
        &preview.before_rows[0][id_col],
        t::Value::Int(130)
    ));
    assert!(matches!(
        &preview.before_rows[0][label_col],
        t::Value::String(s) if s == "before"
    ));
    assert!(matches!(
        &preview.after_rows[0][label_col],
        t::Value::String(s) if s == "after"
    ));

    conn.execute("DROP TABLE preview_far_row", Some(&db))
        .await
        .expect("cleanup");
    conn.close().await;
}
