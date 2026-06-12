//! スキーマ introspection のドライバ横断ゴールデン統合テスト。
//!
//! `tables()` / `columns()` / `schema_overview()` / `foreign_keys()` の出力を、
//! 既知スキーマに対するゴールデン (期待値固定) として検証する。introspection は
//! `information_schema` / `pg_catalog` / `sqlite_master` を叩くドライバ依存 SQL で
//! `db/{mysql,postgres,sqlite}.rs` に分散しているため、列順・型マップ・PK/FK・
//! NULL 可否のズレをここで継続検出する。
//!
//! SQLite は環境変数不要で常時実行 (CLAUDE.md)。MySQL/PostgreSQL は
//! `NOOBDB_TEST_{MYSQL,POSTGRES}_URL` 設定時のみ実走し、CI の `rust (test)` で
//! カバーされる。

use noobdb_lib::__test_api as t;
use t::{Connection, TableColumnInfo};

/// 列名で `TableColumnInfo` を引く。見つからなければ panic (ゴールデンの取りこぼし)。
fn col<'a>(cols: &'a [TableColumnInfo], name: &str) -> &'a TableColumnInfo {
    cols.iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("column '{name}' not found in {:?}", cols))
}

/// authors / books の 2 テーブル (FK・NOT NULL・DEFAULT 込み) を作る共通スキーマ。
/// 各ドライバの DDL 方言に合わせて呼び分ける。
async fn seed(conn: &Connection, authors_ddl: &str, books_ddl: &str, db: Option<&str>) {
    for sql in [
        "DROP TABLE IF EXISTS books",
        "DROP TABLE IF EXISTS authors",
        authors_ddl,
        books_ddl,
    ] {
        conn.execute(sql, db).await.unwrap_or_else(|e| {
            panic!("seed failed for `{sql}`: {e}");
        });
    }
}

async fn drop_all(conn: &Connection, db: Option<&str>) {
    for sql in ["DROP TABLE IF EXISTS books", "DROP TABLE IF EXISTS authors"] {
        let _ = conn.execute(sql, db).await;
    }
}

// ---------------------------------------------------------------------------
// SQLite — 常時実行のゴールデン
// ---------------------------------------------------------------------------

#[tokio::test]
async fn sqlite_introspection_golden() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_introspect_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");

    let conn = t::connect(&t::sqlite_options(path.to_str().unwrap()))
        .await
        .expect("connect");

    seed(
        &conn,
        "CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, bio TEXT)",
        "CREATE TABLE books (\
            id INTEGER PRIMARY KEY, \
            author_id INTEGER NOT NULL, \
            title TEXT NOT NULL DEFAULT 'untitled', \
            published INTEGER, \
            FOREIGN KEY (author_id) REFERENCES authors(id))",
        None,
    )
    .await;

    // tables(): 名前昇順で base table / view を返す。
    let tables = conn.tables("main").await.expect("tables");
    assert_eq!(tables, vec!["authors".to_string(), "books".to_string()]);

    // columns(authors): 定義順・型・NULL 可否・PK。
    let authors = conn
        .columns("main", "authors")
        .await
        .expect("columns authors");
    assert_eq!(
        authors.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "name", "bio"]
    );
    let id = col(&authors, "id");
    assert_eq!(id.data_type, "INTEGER");
    assert_eq!(id.key, "PRI");
    assert!(
        id.nullable,
        "SQLite の INTEGER PRIMARY KEY は notnull 制約なし"
    );
    let name = col(&authors, "name");
    assert_eq!(name.data_type, "TEXT");
    assert_eq!(name.key, "");
    assert!(!name.nullable, "name は NOT NULL");
    assert!(col(&authors, "bio").nullable);

    // columns(books): DEFAULT と FK の解決を固定。
    let books = conn.columns("main", "books").await.expect("columns books");
    assert_eq!(
        books.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "author_id", "title", "published"]
    );
    let author_id = col(&books, "author_id");
    assert!(!author_id.nullable);
    assert_eq!(author_id.referenced_table.as_deref(), Some("authors"));
    assert_eq!(author_id.referenced_column.as_deref(), Some("id"));
    let title = col(&books, "title");
    assert!(!title.nullable);
    // SQLite の dflt_value はリテラルをそのまま返す ('untitled' を含む)。
    assert_eq!(title.default.as_deref(), Some("'untitled'"));
    assert!(col(&books, "published").nullable);

    // schema_overview(): テーブルごとの列名リスト。
    let overview = conn.schema_overview("main").await.expect("overview");
    let by = |name: &str| overview.iter().find(|s| s.name == name).unwrap();
    assert_eq!(by("authors").columns, vec!["id", "name", "bio"]);
    assert_eq!(
        by("books").columns,
        vec!["id", "author_id", "title", "published"]
    );

    // foreign_keys(): books.author_id → authors.id の 1 本。
    let fks = conn.foreign_keys("main").await.expect("fks");
    assert_eq!(fks.len(), 1, "got: {fks:?}");
    let fk = &fks[0];
    assert_eq!(fk.table, "books");
    assert_eq!(fk.column, "author_id");
    assert_eq!(fk.referenced_table, "authors");
    assert_eq!(fk.referenced_column.as_deref(), Some("id"));

    conn.close().await;
    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// MySQL — NOOBDB_TEST_MYSQL_URL 設定時のみ
// ---------------------------------------------------------------------------

#[tokio::test]
async fn mysql_introspection_golden_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    let opts = t::parse_mysql_url(&url).expect("valid mysql url");
    let db = opts.database.clone().expect("database in url");
    let conn = t::connect(&opts).await.expect("connect mysql");

    seed(
        &conn,
        "CREATE TABLE authors (id INT PRIMARY KEY, name VARCHAR(100) NOT NULL, bio TEXT)",
        "CREATE TABLE books (\
            id INT PRIMARY KEY, \
            author_id INT NOT NULL, \
            title VARCHAR(200) NOT NULL DEFAULT 'untitled', \
            published INT, \
            CONSTRAINT fk_books_author FOREIGN KEY (author_id) REFERENCES authors(id))",
        Some(&db),
    )
    .await;

    let authors = conn.columns(&db, "authors").await.expect("columns authors");
    assert_eq!(
        authors.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "name", "bio"]
    );
    let id = col(&authors, "id");
    assert_eq!(id.data_type.to_lowercase(), "int");
    assert_eq!(id.key, "PRI");
    assert!(!id.nullable);
    let name = col(&authors, "name");
    assert_eq!(name.data_type.to_lowercase(), "varchar(100)");
    assert!(!name.nullable);
    assert!(col(&authors, "bio").nullable);

    let books = conn.columns(&db, "books").await.expect("columns books");
    assert_eq!(
        books.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "author_id", "title", "published"]
    );
    let author_id = col(&books, "author_id");
    assert!(!author_id.nullable);
    assert_eq!(author_id.referenced_table.as_deref(), Some("authors"));
    assert_eq!(author_id.referenced_column.as_deref(), Some("id"));

    // foreign_keys(): books.author_id → authors.id。
    let fks = conn.foreign_keys(&db).await.expect("fks");
    let fk = fks
        .iter()
        .find(|f| f.table == "books" && f.column == "author_id")
        .expect("books.author_id fk");
    assert_eq!(fk.referenced_table, "authors");
    assert_eq!(fk.referenced_column.as_deref(), Some("id"));

    // schema_overview(): 列名リスト。
    let overview = conn.schema_overview(&db).await.expect("overview");
    let books_ov = overview.iter().find(|s| s.name == "books").unwrap();
    assert_eq!(
        books_ov.columns,
        vec!["id", "author_id", "title", "published"]
    );

    drop_all(&conn, Some(&db)).await;
    conn.close().await;
}

// ---------------------------------------------------------------------------
// PostgreSQL — NOOBDB_TEST_POSTGRES_URL 設定時のみ
// ---------------------------------------------------------------------------

#[tokio::test]
async fn postgres_introspection_golden_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid postgres url");
    let conn = t::connect(&opts).await.expect("connect postgres");
    // introspection はスキーマ単位。テスト用テーブルは public に作る。
    let schema = "public";

    seed(
        &conn,
        "CREATE TABLE authors (id integer PRIMARY KEY, name varchar(100) NOT NULL, bio text)",
        "CREATE TABLE books (\
            id integer PRIMARY KEY, \
            author_id integer NOT NULL, \
            title varchar(200) NOT NULL DEFAULT 'untitled', \
            published integer, \
            CONSTRAINT fk_books_author FOREIGN KEY (author_id) REFERENCES authors(id))",
        None,
    )
    .await;

    let authors = conn
        .columns(schema, "authors")
        .await
        .expect("columns authors");
    assert_eq!(
        authors.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "name", "bio"]
    );
    let id = col(&authors, "id");
    assert_eq!(id.data_type, "integer");
    assert_eq!(id.key, "PRI");
    assert!(!id.nullable);
    let name = col(&authors, "name");
    assert_eq!(name.data_type, "character varying");
    assert!(!name.nullable);
    let bio = col(&authors, "bio");
    assert_eq!(bio.data_type, "text");
    assert!(bio.nullable);

    let books = conn.columns(schema, "books").await.expect("columns books");
    assert_eq!(
        books.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
        vec!["id", "author_id", "title", "published"]
    );
    let author_id = col(&books, "author_id");
    assert!(!author_id.nullable);
    assert_eq!(author_id.referenced_table.as_deref(), Some("authors"));
    assert_eq!(author_id.referenced_column.as_deref(), Some("id"));

    let fks = conn.foreign_keys(schema).await.expect("fks");
    let fk = fks
        .iter()
        .find(|f| f.table == "books" && f.column == "author_id")
        .expect("books.author_id fk");
    assert_eq!(fk.referenced_table, "authors");
    assert_eq!(fk.referenced_column.as_deref(), Some("id"));

    drop_all(&conn, None).await;
    conn.close().await;
}
