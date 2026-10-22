//! DROP COLUMN の依存オブジェクト検出 (#1758) の統合テスト。
//!
//! SQLite (一時ファイル) は常時実走する。MySQL / PostgreSQL は `NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用のデータベース / スキーマ
//! (`nb1758_*`) に閉じる。

use std::sync::Arc;

use noobdb_lib::__test_api as t;

async fn session_for(tag: &str, conn: t::Connection, opts: t::DbConnectOptions) -> Arc<t::Session> {
    let state = t::AppState::default();
    let id = state.insert(t::make_session(tag, conn, opts, false)).await;
    state.get(&id).await.expect("session exists")
}

/// `kind:name` の昇順一覧にする (依存元の列は `column` で絞る)。
async fn deps(
    session: &Arc<t::Session>,
    database: &str,
    table: &str,
    columns: &[&str],
    column: &str,
) -> Vec<String> {
    let cols: Vec<String> = columns.iter().map(|c| c.to_string()).collect();
    let report = t::column_dependencies_core(session.clone(), database, table, &cols)
        .await
        .expect("column_dependencies");
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    let mut v: Vec<String> = report
        .dependencies
        .iter()
        .filter(|d| d.column == column)
        .map(|d| format!("{}:{}", d.kind, d.name))
        .collect();
    v.sort();
    v
}

#[tokio::test]
async fn sqlite_column_dependencies() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_coldeps_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    for ddl in [
        "CREATE TABLE nb1758_u (id INTEGER PRIMARY KEY)",
        "CREATE TABLE nb1758_p (id INTEGER PRIMARY KEY, price INTEGER, qty INTEGER, owner INTEGER REFERENCES nb1758_u(id), \
         total INTEGER GENERATED ALWAYS AS (price * qty) VIRTUAL)",
        "CREATE TABLE nb1758_c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES nb1758_p(id))",
        "CREATE TABLE nb1758_k (a INTEGER, b INTEGER, PRIMARY KEY (a, b))",
        "CREATE TABLE nb1758_kc (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES nb1758_k(a, b))",
        "CREATE INDEX nb1758_idx ON nb1758_p (price, qty)",
        "CREATE VIEW nb1758_v AS SELECT id, price FROM nb1758_p",
        "CREATE TRIGGER nb1758_t AFTER INSERT ON nb1758_p BEGIN UPDATE nb1758_p SET qty = NEW.price WHERE id = NEW.id; END",
    ] {
        conn.execute(ddl, None).await.expect("ddl");
    }
    let session = session_for("coldeps_sqlite", conn, opts).await;
    assert_eq!(
        deps(&session, "main", "nb1758_p", &["price"], "price").await,
        vec![
            "generated_column:total",
            "index:nb1758_idx",
            "trigger:nb1758_t",
            "view:nb1758_v"
        ]
    );
    assert_eq!(
        deps(&session, "main", "nb1758_p", &["id"], "id").await,
        vec![
            "referenced_by:nb1758_c",
            "trigger:nb1758_t",
            "view:nb1758_v"
        ]
    );
    assert_eq!(
        deps(&session, "main", "nb1758_p", &["owner"], "owner").await,
        vec!["foreign_key:nb1758_p:0"]
    );
    // 生成列自身も一緒に消すなら、その生成列は依存に数えない。
    assert_eq!(
        deps(&session, "main", "nb1758_p", &["price", "total"], "price").await,
        vec!["index:nb1758_idx", "trigger:nb1758_t", "view:nb1758_v"]
    );
    // 複合 FK で参照される列 (#1758)。
    assert!(deps(&session, "main", "nb1758_k", &["a"], "a")
        .await
        .contains(&"referenced_by:nb1758_kc".to_string()));
    // 依存の無い列は何も返さない。
    assert!(deps(&session, "main", "nb1758_c", &["pid"], "unused")
        .await
        .is_empty());
    let _ = std::fs::remove_file(path);
}

const MYSQL_DB: &str = "nb1758_deps_db";

#[tokio::test]
async fn mysql_column_dependencies_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        format!("DROP DATABASE IF EXISTS {MYSQL_DB}"),
        format!("CREATE DATABASE {MYSQL_DB}"),
        format!("CREATE TABLE {MYSQL_DB}.nb1758_u (id INT PRIMARY KEY)"),
        format!(
            "CREATE TABLE {MYSQL_DB}.nb1758_p (id INT PRIMARY KEY, price INT, qty INT, owner INT, \
             total INT AS (price * qty) VIRTUAL, a INT, b INT, nm VARCHAR(20), \
             label VARCHAR(40) AS (concat('x', nm)) VIRTUAL, UNIQUE KEY nb1758_ab (a, b), KEY nb1758_idx (price, qty), \
             CONSTRAINT nb1758_fk FOREIGN KEY (owner) REFERENCES nb1758_u(id))"
        ),
        format!("CREATE TABLE {MYSQL_DB}.nb1758_c (id INT PRIMARY KEY, pid INT, CONSTRAINT nb1758_cfk FOREIGN KEY (pid) REFERENCES nb1758_p(id))"),
        format!("CREATE TABLE {MYSQL_DB}.nb1758_cc (x INT, y INT, CONSTRAINT nb1758_ccfk FOREIGN KEY (x, y) REFERENCES nb1758_p(a, b))"),
        format!("CREATE VIEW {MYSQL_DB}.nb1758_v AS SELECT id, price FROM {MYSQL_DB}.nb1758_p"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    t::mysql_exec_text(
        &opts,
        &format!("CREATE TRIGGER {MYSQL_DB}.nb1758_t BEFORE INSERT ON {MYSQL_DB}.nb1758_p FOR EACH ROW SET NEW.qty = NEW.price + 1"),
    )
    .await
    .expect("trigger ddl");
    let session = session_for("coldeps_mysql", conn, opts).await;
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["price"], "price").await,
        vec![
            "generated_column:total",
            "index:nb1758_idx",
            "trigger:nb1758_t",
            "view:nb1758_v"
        ]
    );
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["id"], "id").await,
        vec!["index:PRIMARY", "referenced_by:nb1758_c", "view:nb1758_v"]
    );
    // 複合 FK で参照される列 (#1758)。
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["a"], "a").await,
        vec!["index:nb1758_ab", "referenced_by:nb1758_cc"]
    );
    // 文字列リテラル入りの生成列の式 (MySQL 8.0 は `\\'` 付きで返す)。
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["nm"], "nm").await,
        vec!["generated_column:label"]
    );
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["owner"], "owner").await,
        vec!["foreign_key:nb1758_fk", "index:nb1758_fk"]
    );
    assert_eq!(
        deps(&session, MYSQL_DB, "nb1758_p", &["price", "total"], "price").await,
        vec!["index:nb1758_idx", "trigger:nb1758_t", "view:nb1758_v"]
    );
    session
        .conn
        .execute(&format!("DROP DATABASE {MYSQL_DB}"), None)
        .await
        .expect("cleanup");
}

const PG_SCHEMA: &str = "nb1758_deps";

#[tokio::test]
async fn postgres_column_dependencies_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        format!("DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"),
        format!("CREATE SCHEMA {PG_SCHEMA}"),
        format!("CREATE TABLE {PG_SCHEMA}.nb1758_u (id int PRIMARY KEY)"),
        format!(
            "CREATE TABLE {PG_SCHEMA}.nb1758_p (id int PRIMARY KEY, price int, qty int, \
             owner int CONSTRAINT nb1758_fk REFERENCES {PG_SCHEMA}.nb1758_u(id), \
             total int GENERATED ALWAYS AS (price * qty) STORED)"
        ),
        format!("CREATE TABLE {PG_SCHEMA}.nb1758_c (id int PRIMARY KEY, pid int CONSTRAINT nb1758_cfk REFERENCES {PG_SCHEMA}.nb1758_p(id))"),
        format!("CREATE INDEX nb1758_idx ON {PG_SCHEMA}.nb1758_p (price, qty)"),
        format!("CREATE VIEW {PG_SCHEMA}.nb1758_v AS SELECT id, price FROM {PG_SCHEMA}.nb1758_p"),
        format!("CREATE MATERIALIZED VIEW {PG_SCHEMA}.nb1758_mv AS SELECT price FROM {PG_SCHEMA}.nb1758_p"),
        format!("CREATE FUNCTION {PG_SCHEMA}.nb1758_trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.qty := NEW.price + 1; RETURN NEW; END $$"),
        format!("CREATE TRIGGER nb1758_t BEFORE UPDATE OF price ON {PG_SCHEMA}.nb1758_p FOR EACH ROW EXECUTE FUNCTION {PG_SCHEMA}.nb1758_trg()"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    // PostgreSQL のトリガー関数の本体は定義に含まれないので、`UPDATE OF 列` / `WHEN` で参照する
    // トリガーだけが検出できる (Where-used と同じ限界)。
    let session = session_for("coldeps_pg", conn, opts).await;
    assert_eq!(
        deps(&session, PG_SCHEMA, "nb1758_p", &["price"], "price").await,
        vec![
            "generated_column:total",
            "index:nb1758_idx",
            "materialized_view:nb1758_mv",
            "trigger:nb1758_t",
            "view:nb1758_v"
        ]
    );
    assert_eq!(
        deps(&session, PG_SCHEMA, "nb1758_p", &["id"], "id").await,
        vec![
            "index:nb1758_p_pkey",
            "referenced_by:nb1758_c",
            "view:nb1758_v"
        ]
    );
    assert_eq!(
        deps(&session, PG_SCHEMA, "nb1758_p", &["owner"], "owner").await,
        vec!["foreign_key:nb1758_fk"]
    );
    assert_eq!(
        deps(
            &session,
            PG_SCHEMA,
            "nb1758_p",
            &["price", "total"],
            "price"
        )
        .await,
        vec![
            "index:nb1758_idx",
            "materialized_view:nb1758_mv",
            "trigger:nb1758_t",
            "view:nb1758_v"
        ]
    );
    session
        .conn
        .execute(&format!("DROP SCHEMA {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("cleanup");
}
