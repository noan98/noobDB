//! Integration test against a live MySQL server.
//!
//! Skipped unless `NOOBDB_TEST_MYSQL_URL` is set, e.g.:
//!     mysql://root:rootpw@127.0.0.1:3306/testdb
//!
//! Parses the URL and exercises the `Connection::MySql` path end-to-end:
//! connect, run a query, list databases.

use noobdb_lib::__test_api as t;

#[tokio::test]
async fn mysql_roundtrip_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
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
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .expect("test url must include a database");
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

/// Regression for #188: a CTE-prefixed DELETE/UPDATE/INSERT starts with `WITH`
/// but mutates rows. It used to take the result-set path and report an empty
/// "0 rows" grid, hiding the fact that data changed. It must now take the
/// execute path and return `rows_affected`.
#[tokio::test]
async fn with_cte_dml_reports_rows_affected() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .expect("test url must include a database");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS cte_dml_test", Some(&db))
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE cte_dml_test (id INT PRIMARY KEY, keep TINYINT NOT NULL)",
        Some(&db),
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO cte_dml_test (id, keep) VALUES (1,1),(2,0),(3,0),(4,1)",
        Some(&db),
    )
    .await
    .expect("seed");

    // WITH ... DELETE: deletes the two rows with keep = 0.
    let deleted = conn
        .execute(
            "WITH doomed AS (SELECT id FROM cte_dml_test WHERE keep = 0) \
             DELETE FROM cte_dml_test WHERE id IN (SELECT id FROM doomed)",
            Some(&db),
        )
        .await
        .expect("cte delete");
    assert_eq!(
        deleted.rows_affected, 2,
        "WITH ... DELETE should affect 2 rows"
    );
    assert!(
        deleted.columns.is_empty() && deleted.rows.is_empty(),
        "a mutation must not return a result grid"
    );

    // WITH ... UPDATE: flips the remaining rows.
    let updated = conn
        .execute(
            "WITH live AS (SELECT id FROM cte_dml_test) \
             UPDATE cte_dml_test SET keep = 0 WHERE id IN (SELECT id FROM live)",
            Some(&db),
        )
        .await
        .expect("cte update");
    assert_eq!(
        updated.rows_affected, 2,
        "WITH ... UPDATE should affect 2 rows"
    );

    // WITH ... SELECT must still return a result set.
    let selected = conn
        .execute(
            "WITH live AS (SELECT id FROM cte_dml_test) SELECT * FROM live ORDER BY id",
            Some(&db),
        )
        .await
        .expect("cte select");
    assert_eq!(selected.rows.len(), 2, "WITH ... SELECT should return rows");
    assert_eq!(selected.rows_affected, 0);

    conn.execute("DROP TABLE cte_dml_test", Some(&db))
        .await
        .expect("cleanup");
    conn.close().await;
}

/// Regression for #189: `CALL proc()` used to take the execute path and only
/// report `rows_affected`, so a stored procedure that returns a result set
/// never surfaced its rows in the grid. It must now take the result-set path.
#[tokio::test]
async fn call_stored_procedure_returns_result_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .expect("test url must include a database");
    let conn = t::connect(&opts).await.expect("connect");

    // CREATE/DROP PROCEDURE are rejected by the prepared-statement protocol
    // (error 1295), so set the procedure up via the text protocol.
    t::mysql_exec_text(&opts, "DROP PROCEDURE IF EXISTS noobdb_call_test")
        .await
        .expect("drop proc");
    // Single-statement body needs no DELIMITER/BEGIN..END.
    t::mysql_exec_text(
        &opts,
        "CREATE PROCEDURE noobdb_call_test() SELECT 7 AS answer, 'ok' AS label",
    )
    .await
    .expect("create proc");

    let res = conn
        .execute("CALL noobdb_call_test()", Some(&db))
        .await
        .expect("call proc");
    assert_eq!(
        res.columns.len(),
        2,
        "CALL should surface the result set columns"
    );
    assert_eq!(res.rows.len(), 1, "CALL should surface the result set rows");
    let answer_col = res
        .columns
        .iter()
        .position(|c| c.name == "answer")
        .expect("answer column");
    assert!(matches!(&res.rows[0][answer_col], t::Value::Int(7)));

    t::mysql_exec_text(&opts, "DROP PROCEDURE noobdb_call_test")
        .await
        .expect("cleanup");
    conn.close().await;
}

/// Regression for #196: a `CALL` whose body only runs DML (no SELECT) returns
/// no result set. Routing every CALL through the result-set path used to report
/// `rows_affected = 0`; runtime detection via `fetch_many` must now sum the
/// procedure's affected-row counts and surface them instead.
#[tokio::test]
async fn call_dml_only_procedure_reports_rows_affected() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .expect("test url must include a database");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS call_dml_test", Some(&db))
        .await
        .expect("drop table");
    conn.execute(
        "CREATE TABLE call_dml_test (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL)",
        Some(&db),
    )
    .await
    .expect("create table");

    // CREATE/DROP PROCEDURE are rejected by the prepared-statement protocol
    // (error 1295), so set the procedure up via the text protocol.
    t::mysql_exec_text(&opts, "DROP PROCEDURE IF EXISTS noobdb_call_dml")
        .await
        .expect("drop proc");
    // Single-statement body needs no DELIMITER/BEGIN..END. Inserts 3 rows and
    // returns no result set.
    t::mysql_exec_text(
        &opts,
        "CREATE PROCEDURE noobdb_call_dml() \
         INSERT INTO call_dml_test (id, label) VALUES (1,'a'),(2,'b'),(3,'c')",
    )
    .await
    .expect("create proc");

    let res = conn
        .execute("CALL noobdb_call_dml()", Some(&db))
        .await
        .expect("call proc");
    assert!(
        res.columns.is_empty() && res.rows.is_empty(),
        "a DML-only CALL must not return a result grid"
    );
    assert_eq!(
        res.rows_affected, 3,
        "CALL should report the procedure's affected-row count"
    );

    // The CALL was not rolled back: the rows are really there.
    let check = conn
        .execute("SELECT COUNT(*) AS n FROM call_dml_test", Some(&db))
        .await
        .expect("count");
    assert_eq!(check.rows.len(), 1);

    t::mysql_exec_text(&opts, "DROP PROCEDURE noobdb_call_dml")
        .await
        .expect("drop proc cleanup");
    conn.execute("DROP TABLE call_dml_test", Some(&db))
        .await
        .expect("cleanup");
    conn.close().await;
}

/// Regression: MySQL `TIMESTAMP` and `TIME` columns used to decode to
/// `Value::Null`. `decode_cell` only tried `NaiveDateTime`/`NaiveDate`, but in
/// sqlx-mysql `NaiveDateTime` is compatible *only* with the DATETIME column
/// type — TIMESTAMP needs `DateTime<Utc>` and TIME needs `NaiveTime`. The
/// mismatched `try_get` errored on the compatibility check and the value fell
/// through to NULL. In the dry-run preview this made columns set to `NOW()`
/// read NULL in both panes, so they never highlighted as changed.
#[tokio::test]
async fn temporal_columns_decode_to_strings() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let db = opts
        .database
        .clone()
        .expect("test url must include a database");
    let conn = t::connect(&opts).await.expect("connect");

    conn.execute("DROP TABLE IF EXISTS temporal_decode", Some(&db))
        .await
        .expect("drop");
    conn.execute(
        "CREATE TABLE temporal_decode (\
            id INT PRIMARY KEY, \
            d DATE NOT NULL, \
            t TIME NOT NULL, \
            dt DATETIME NOT NULL, \
            ts TIMESTAMP NOT NULL)",
        Some(&db),
    )
    .await
    .expect("create");
    conn.execute(
        "INSERT INTO temporal_decode (id, d, t, dt, ts) VALUES \
         (1, '2026-05-26', '13:45:30', '2026-05-26 13:45:30', '2026-05-26 13:45:30')",
        Some(&db),
    )
    .await
    .expect("seed");

    let res = conn
        .execute(
            "SELECT id, d, t, dt, ts FROM temporal_decode WHERE id = 1",
            Some(&db),
        )
        .await
        .expect("select");
    assert_eq!(res.rows.len(), 1);
    let col = |name: &str| {
        res.columns
            .iter()
            .position(|c| c.name == name)
            .unwrap_or_else(|| panic!("{name} column"))
    };
    let row = &res.rows[0];
    // The whole point: none of these are NULL, and TIME / TIMESTAMP in
    // particular now carry a string value rather than dropping to NULL.
    assert!(
        matches!(&row[col("d")], t::Value::String(s) if s == "2026-05-26"),
        "DATE decoded as {:?}",
        row[col("d")]
    );
    assert!(
        matches!(&row[col("t")], t::Value::String(s) if s == "13:45:30"),
        "TIME decoded as {:?}",
        row[col("t")]
    );
    assert!(
        matches!(&row[col("dt")], t::Value::String(s) if s == "2026-05-26 13:45:30"),
        "DATETIME decoded as {:?}",
        row[col("dt")]
    );
    assert!(
        matches!(&row[col("ts")], t::Value::String(s) if s == "2026-05-26 13:45:30"),
        "TIMESTAMP decoded as {:?}",
        row[col("ts")]
    );

    // And through the preview path, a column set to NOW() must differ between
    // BEFORE (NULL/old) and AFTER so the frontend diff highlights it.
    let preview = conn
        .preview_execute_with_limit(
            "UPDATE temporal_decode SET ts = NOW() + INTERVAL 1 DAY WHERE id = 1",
            Some(&db),
            100,
        )
        .await
        .expect("preview");
    let ts_col = preview
        .columns
        .iter()
        .position(|c| c.name == "ts")
        .expect("ts column");
    let as_str = |v: &t::Value| match v {
        t::Value::String(s) => Some(s.clone()),
        t::Value::Null => None,
        other => panic!("ts decoded to an unexpected variant: {other:?}"),
    };
    let before_ts = as_str(&preview.before_rows[0][ts_col]);
    let after_ts = as_str(&preview.after_rows[0][ts_col]);
    assert!(
        after_ts.is_some(),
        "AFTER ts must be a non-null timestamp, got {:?}",
        preview.after_rows[0][ts_col]
    );
    assert_ne!(
        before_ts, after_ts,
        "NOW()-updated TIMESTAMP must differ between BEFORE and AFTER"
    );

    conn.execute("DROP TABLE temporal_decode", Some(&db))
        .await
        .expect("cleanup");
    conn.close().await;
}
