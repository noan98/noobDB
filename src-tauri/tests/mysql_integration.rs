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
