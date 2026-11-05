//! MySQL / PostgreSQL ネイティブ SQL ダンプ (#2033) のラウンドトリップ統合テスト。
//!
//! `NOOBDB_TEST_MYSQL_URL` / `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行する (未設定ならスキップ)。
//! 専用の DB / スキーマ (`nb2033_*`) に閉じる。流れ:
//!
//! 1. 元の DB に表・ビュー・トリガー・ルーチンと、境界値 (64bit 整数・バイナリ・NULL・
//!    クォート・バックスラッシュ・改行・非 ASCII) を含む行を作る。
//! 2. `dump_native_core` で SQL ダンプを書く (外部の mysqldump / pg_dump は使わない)。
//! 3. 元の DB を消し、ダンプを `mysql` / `psql` クライアントで流し込んで復元する
//!    (クライアントが無ければスキップ)。
//! 4. 復元後の全行が元と一致し、オブジェクトが揃っていることを確かめる。

use std::process::{Command, Stdio};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use noobdb_lib::__test_api as t;

const MYSQL_DB: &str = "nb2033_dump_db";
const PG_SCHEMA: &str = "nb2033_dump";

fn options(extra: serde_json::Value) -> t::DumpOptions {
    let mut base = serde_json::json!({
        "singleTransaction": false,
        "routines": true,
        "events": true,
        "triggers": true,
        "addDropTable": true,
        "extendedInsert": true,
        "completeInsert": false,
        "noData": false,
        "noCreateInfo": false,
        "native": true
    });
    if let (Some(b), Some(e)) = (base.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            b.insert(k.clone(), v.clone());
        }
    }
    serde_json::from_value(base).expect("DumpOptions json")
}

async fn dump_to_string(
    conn: &t::Connection,
    database: &str,
    options: &t::DumpOptions,
) -> Result<String, String> {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_dump_native_{}_{}.sql",
        std::process::id(),
        database
    ));
    let file = std::fs::File::create(&path).expect("create dump file");
    let counter = Arc::new(AtomicU64::new(0));
    let r = t::dump_native_core(
        conn,
        database,
        false,
        file,
        options,
        &counter,
        Arc::new(|_, _, _| {}),
    )
    .await;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    match r {
        Ok(bytes) => {
            assert_eq!(bytes as usize, text.len(), "byte counter matches the file");
            Ok(text)
        }
        Err(e) => Err(e.to_string()),
    }
}

fn client_available(bin: &str) -> bool {
    Command::new(bin)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

async fn rows_of(conn: &t::Connection, sql: &str) -> String {
    let r = conn.execute(sql, None).await.expect("select");
    format!("{:?}", r.rows)
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const MYSQL_SELECTS: &[&str] = &[
    "SELECT id, name, note, big, ubig, f, HEX(bin), d, dt, dec_v, js, flag, gen_v, ts, UNIX_TIMESTAMP(ts) FROM nb2033_dump_db.parent ORDER BY id",
    "SELECT id, pid, label FROM nb2033_dump_db.a_child ORDER BY id",
    "SELECT * FROM nb2033_dump_db.v_parent ORDER BY id",
    "SELECT * FROM nb2033_dump_db.a_v_over ORDER BY id",
];

async fn mysql_setup(opts: &t::DbConnectOptions) {
    let conn = t::connect(opts).await.expect("connect");
    for sql in [
        format!("DROP DATABASE IF EXISTS {MYSQL_DB}"),
        format!("CREATE DATABASE {MYSQL_DB} CHARACTER SET utf8mb4"),
        format!(
            "CREATE TABLE {MYSQL_DB}.parent (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, \
             name VARCHAR(100), note TEXT, big BIGINT, ubig BIGINT UNSIGNED, f DOUBLE, bin BLOB, d DATE, \
             dt DATETIME(3), dec_v DECIMAL(20,4), js JSON, flag TINYINT(1), \
             gen_v INT AS (flag * 2) VIRTUAL, ts TIMESTAMP(3) NULL DEFAULT NULL, UNIQUE KEY nb2033_name (name))"
        ),
        // 名前順で親より先に来る子表 (FK 先行順に頼らず FOREIGN_KEY_CHECKS=0 で復元できること)。
        format!(
            "CREATE TABLE {MYSQL_DB}.a_child (id INT PRIMARY KEY, pid BIGINT UNSIGNED, label VARCHAR(20), \
             CONSTRAINT nb2033_fk FOREIGN KEY (pid) REFERENCES parent(id) ON DELETE CASCADE)"
        ),
        format!("CREATE TABLE {MYSQL_DB}.empty_t (id INT PRIMARY KEY)"),
        format!("CREATE VIEW {MYSQL_DB}.v_parent AS SELECT id, name FROM {MYSQL_DB}.parent WHERE flag = 1"),
        // 名前順では v_parent より前に来るが、v_parent に依存するビュー (依存順に出ること)。
        format!("CREATE VIEW {MYSQL_DB}.a_v_over AS SELECT id FROM {MYSQL_DB}.v_parent"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    t::mysql_exec_text(
        opts,
        &format!(
            "CREATE TRIGGER {MYSQL_DB}.nb2033_trg BEFORE INSERT ON {MYSQL_DB}.a_child FOR EACH ROW \
             BEGIN SET NEW.label = IFNULL(NEW.label, 'trg'); END"
        ),
    )
    .await
    .expect("trigger");
    t::mysql_exec_text(
        opts,
        &format!(
            "CREATE PROCEDURE {MYSQL_DB}.nb2033_proc() BEGIN SELECT COUNT(*) FROM {MYSQL_DB}.parent; END"
        ),
    )
    .await
    .expect("procedure");
    t::mysql_exec_text(
        opts,
        &format!(
            "CREATE EVENT {MYSQL_DB}.nb2033_ev ON SCHEDULE EVERY 1 DAY STARTS '2099-01-01 00:00:00' \
             DISABLE DO DELETE FROM {MYSQL_DB}.empty_t"
        ),
    )
    .await
    .expect("event");
    // 境界値の行。`\` と `'` と改行・タブ・絵文字・日本語、64bit の両端、NULL、バイナリ。
    t::mysql_exec_text(
        opts,
        &format!(
            "INSERT INTO {MYSQL_DB}.parent (id, name, note, big, ubig, f, bin, d, dt, dec_v, js, flag, ts) VALUES \
             (1, 'plain', 'a', -9223372036854775808, 18446744073709551615, 0.1, X'00FF10', '2024-02-29', '2024-02-29 23:59:59.123', 12345678901234.5678, '{{\"k\": [1, 2]}}', 1, '2024-06-01 12:00:00.250'), \
             (2, 'it''s \\\\ back\\nslash \"dq\" \\t tab', 'emoji \u{1F600} \u{65E5}\u{672C}\u{8A9E}', 9007199254740993, 9007199254740993, -1.5e10, X'', NULL, NULL, NULL, NULL, 0, NULL), \
             (3, NULL, NULL, NULL, NULL, NULL, NULL, '1000-01-01', '9999-12-31 00:00:00.000', -0.0001, 'null', NULL, '2038-01-19 03:14:07.000'), \
             (0, 'zero-id', 'nul\\0z\\Zend', 0, 0, 0, X'27225C', '2000-01-01', '2000-01-01 00:00:00.000', 0, '{{}}', 1, '1970-01-02 00:00:00.000')"
        ),
    )
    .await
    .expect("insert parent");
    t::mysql_exec_text(
        opts,
        &format!(
            "INSERT INTO {MYSQL_DB}.a_child (id, pid, label) VALUES (1, 1, 'x'), (2, 2, NULL), (3, NULL, 'o''k')"
        ),
    )
    .await
    .expect("insert child");
}

fn mysql_cli_sql(opts: &t::DbConnectOptions, sql: &str) -> bool {
    let mut cmd = Command::new("mysql");
    cmd.arg(format!("--host={}", opts.host))
        .arg(format!("--port={}", opts.port))
        .arg(format!("--user={}", opts.user))
        .arg("-e")
        .arg(sql);
    if !opts.password.is_empty() {
        cmd.env("MYSQL_PWD", &opts.password);
    }
    cmd.output().is_ok_and(|o| o.status.success())
}

fn mysql_cli(
    opts: &t::DbConnectOptions,
    db: Option<&str>,
    sql_file: Option<&std::path::Path>,
) -> bool {
    let mut cmd = Command::new("mysql");
    cmd.arg(format!("--host={}", opts.host))
        .arg(format!("--port={}", opts.port))
        .arg(format!("--user={}", opts.user))
        .arg("--default-character-set=utf8mb4");
    if !opts.password.is_empty() {
        cmd.env("MYSQL_PWD", &opts.password);
    }
    if let Some(db) = db {
        cmd.arg(db);
    }
    match sql_file {
        Some(p) => {
            cmd.stdin(std::fs::File::open(p).expect("open dump"));
        }
        None => {
            cmd.stdin(Stdio::null());
        }
    }
    let out = cmd.output().expect("run mysql");
    if !out.status.success() {
        eprintln!("mysql: {}", String::from_utf8_lossy(&out.stderr));
    }
    out.status.success()
}

#[tokio::test]
async fn mysql_native_dump_roundtrips_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_MYSQL_URL") else {
        eprintln!("skip: NOOBDB_TEST_MYSQL_URL not set");
        return;
    };
    if !client_available("mysql") {
        eprintln!("skip: mysql client not found");
        return;
    }
    let opts = t::parse_mysql_url(&url).expect("valid url");
    // 非 UTC のサーバ既定タイムゾーンで TIMESTAMP がずれないこと。権限が無ければこの部分は飛ばす。
    let admin = t::connect(&opts).await.expect("connect");
    let _ = admin.execute("SET GLOBAL time_zone = '+09:00'", None).await;
    mysql_setup(&opts).await;
    let conn = t::connect(&opts).await.expect("connect");
    // アプリの接続は UTC 固定なので、+09:00 のクライアントセッションから TIMESTAMP を入れ直す。
    assert!(
        mysql_cli_sql(
            &opts,
            &format!(
                "SET time_zone = '+09:00'; UPDATE {MYSQL_DB}.parent SET ts = '2024-06-01 12:00:00.250' WHERE id = 1"
            )
        ),
        "update via client"
    );

    let mut before = Vec::new();
    for sql in MYSQL_SELECTS {
        before.push(rows_of(&conn, sql).await);
    }
    assert!(before[0].contains("18446744073709551615"));

    // 全部入り。
    let dump = dump_to_string(&conn, MYSQL_DB, &options(serde_json::json!({})))
        .await
        .expect("dump");
    assert!(dump.contains("DROP TABLE IF EXISTS `parent`;"));
    assert!(dump.contains("SET TIME_ZONE='+00:00'"));
    assert!(
        !dump.contains('\0') && !dump.contains('\u{1a}'),
        "NUL / Ctrl-Z are escaped"
    );
    assert!(dump.contains("nul\\0z\\Zend"));
    // +09:00 のセッションで入れた TIMESTAMP (12:00 JST = 03:00 UTC) が UTC で出る。
    assert!(dump.contains("'2024-06-01 03:00:00.250'"), "{dump}");
    // ビューは依存順 (v_parent が a_v_over より前)。
    let (pv, ov) = (
        dump.find("VIEW `nb2033_dump_db`.`v_parent`"),
        dump.find("VIEW `nb2033_dump_db`.`a_v_over`"),
    );
    assert!(pv.is_some() && ov.is_some() && pv < ov);
    assert!(dump.contains("DELIMITER ;;"));
    assert!(
        !dump.contains("gen_v`) VALUES"),
        "generated column not inserted"
    );
    // 空表も CREATE は出る。
    assert!(dump.contains("CREATE TABLE `empty_t`"));

    // 復元: 元 DB を消し、ダンプだけから作り直す。
    conn.execute(&format!("DROP DATABASE {MYSQL_DB}"), None)
        .await
        .expect("drop");
    conn.execute(
        &format!("CREATE DATABASE {MYSQL_DB} CHARACTER SET utf8mb4"),
        None,
    )
    .await
    .expect("create");
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_dump_native_restore_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path, &dump).expect("write dump");
    assert!(
        mysql_cli(&opts, Some(MYSQL_DB), Some(&path)),
        "restore failed\n{dump}"
    );
    let _ = std::fs::remove_file(&path);

    for (i, sql) in MYSQL_SELECTS.iter().enumerate() {
        assert_eq!(rows_of(&conn, sql).await, before[i], "rows differ: {sql}");
    }
    let objs = rows_of(
        &conn,
        &format!(
            "SELECT 'trg', COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '{MYSQL_DB}' \
             UNION ALL SELECT 'proc', COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = '{MYSQL_DB}' \
             UNION ALL SELECT 'ev', COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '{MYSQL_DB}' \
             UNION ALL SELECT 'fk', COUNT(*) FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = '{MYSQL_DB}'"
        ),
    )
    .await;
    assert_eq!(objs.matches("Int(1)").count(), 4, "{objs}");

    // 再ダンプしても同じ内容 (往復で安定)。
    let again = dump_to_string(&conn, MYSQL_DB, &options(serde_json::json!({})))
        .await
        .expect("dump again");
    assert_eq!(again, dump);

    // 1 行 1 文 / データなし / スキーマなし / テーブル指定。
    let single = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({"extendedInsert": false})),
    )
    .await
    .expect("dump");
    assert!(single.matches("INSERT INTO `parent`").count() == 4);
    let no_data = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({"noData": true})),
    )
    .await
    .expect("dump");
    assert!(!no_data.contains("INSERT INTO"));
    let data_only = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({"noCreateInfo": true})),
    )
    .await
    .expect("dump");
    assert!(!data_only.contains("CREATE TABLE") && !data_only.contains("DROP TABLE"));
    assert!(data_only.contains("INSERT INTO `parent`"));
    let scoped = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({"tables": ["a_child"]})),
    )
    .await
    .expect("dump");
    assert!(scoped.contains("INSERT INTO `a_child`") && !scoped.contains("INSERT INTO `parent`"));
    assert!(!scoped.contains("CREATE PROCEDURE") && !scoped.contains("CREATE EVENT"));
    let missing = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({"tables": ["nope"]})),
    )
    .await;
    assert!(missing.is_err());

    // マスキング: 指定列の元の値が出力に残らない。
    let masked = dump_to_string(
        &conn,
        MYSQL_DB,
        &options(serde_json::json!({
            "masks": [{"column": "name", "rule": {"kind": "fixed", "value": "***"}}]
        })),
    )
    .await
    .expect("masked dump");
    assert!(masked.contains("'***'"));
    assert!(!masked.contains("plain") && !masked.contains("zero-id"));
    assert!(masked.contains("emoji"), "unmasked columns stay");

    conn.execute(&format!("DROP DATABASE {MYSQL_DB}"), None)
        .await
        .expect("cleanup");
    let _ = admin.execute("SET GLOBAL time_zone = 'SYSTEM'", None).await;
}

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

const PG_SELECTS: &[&str] = &[
    "SELECT id, name, note, big, num, f, encode(bin, 'hex'), d, ts, js::text, flag, u::text, arr::text, gen_v, mo::text, pz::int FROM nb2033_dump.parent ORDER BY id",
    "SELECT id, pid, label FROM nb2033_dump.a_child ORDER BY id",
    "SELECT * FROM nb2033_dump.v_parent ORDER BY id",
    "SELECT * FROM nb2033_dump.mv_parent ORDER BY 1",
    "SELECT * FROM nb2033_dump.\"Odd \"\"Name\" ORDER BY 1",
    "SELECT * FROM nb2033_dump.a_view_over ORDER BY 1",
    "SELECT id, v FROM nb2033_dump.ident_always ORDER BY id",
    "SELECT id, v FROM nb2033_dump.ident_def ORDER BY id",
    "SELECT pg_sequence_last_value(pg_get_serial_sequence('nb2033_dump.ident_always', 'id')::regclass), \
            pg_sequence_last_value(pg_get_serial_sequence('nb2033_dump.ident_def', 'id')::regclass)",
    "SELECT * FROM nb2033_dump.tree ORDER BY id",
    "SELECT * FROM nb2033_dump.cx ORDER BY id",
    "SELECT * FROM nb2033_dump.cy ORDER BY id",
    "SELECT id, r::text, pt::text, tsv::text, tz::text, ts_inf::text, d_inf::text, n_inf::text FROM nb2033_dump.odd ORDER BY id",
    "SELECT * FROM ONLY nb2033_dump.inh_parent ORDER BY id",
    "SELECT * FROM ONLY nb2033_dump.inh_child ORDER BY id",
    "SELECT * FROM nb2033_dump.ident_explicit ORDER BY id",
    "SELECT * FROM nb2033_dump.use_fn ORDER BY id",
];

async fn pg_setup(conn: &t::Connection) {
    for sql in [
        format!("DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"),
        format!("CREATE SCHEMA {PG_SCHEMA}"),
        format!("CREATE TYPE {PG_SCHEMA}.mood AS ENUM ('ok', 'sad', 'it''s')"),
        format!("CREATE DOMAIN {PG_SCHEMA}.posint AS int CHECK (VALUE > 0)"),
        format!("CREATE SEQUENCE {PG_SCHEMA}.standalone_seq START 100 INCREMENT 5"),
        format!(
            "CREATE TABLE {PG_SCHEMA}.parent (id bigserial PRIMARY KEY, name text UNIQUE, note text, big bigint, \
             num numeric(20,4), f double precision, bin bytea, d date, ts timestamptz, js jsonb, flag boolean, \
             u uuid, arr text[], gen_v int GENERATED ALWAYS AS (length(coalesce(name, ''))) STORED, \
             seq_v bigint DEFAULT nextval('{PG_SCHEMA}.standalone_seq'), \
             mo {PG_SCHEMA}.mood DEFAULT 'ok', pz {PG_SCHEMA}.posint)"
        ),
        // 名前順で親より先 (FK 先行順の並べ替えで復元できること)。
        format!(
            "CREATE TABLE {PG_SCHEMA}.a_child (id int PRIMARY KEY, pid bigint, label text, \
             CONSTRAINT nb2033_fk FOREIGN KEY (pid) REFERENCES {PG_SCHEMA}.parent(id) ON DELETE CASCADE)"
        ),
        format!("CREATE TABLE {PG_SCHEMA}.\"Odd \"\"Name\" (\"Col A\" int PRIMARY KEY, \"select\" text)"),
        format!("CREATE INDEX nb2033_idx ON {PG_SCHEMA}.parent (big)"),
        format!("CREATE TABLE {PG_SCHEMA}.ident_always (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text)"),
        format!("CREATE TABLE {PG_SCHEMA}.ident_def (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text)"),
        // 自己参照と循環の外部キー (CREATE TABLE に埋め込まず後付けされること)。
        format!("CREATE TABLE {PG_SCHEMA}.tree (id int PRIMARY KEY, parent int REFERENCES {PG_SCHEMA}.tree(id))"),
        format!("CREATE TABLE {PG_SCHEMA}.cx (id int PRIMARY KEY, y_id int)"),
        format!("CREATE TABLE {PG_SCHEMA}.cy (id int PRIMARY KEY, x_id int)"),
        format!("ALTER TABLE {PG_SCHEMA}.cx ADD CONSTRAINT cx_fk FOREIGN KEY (y_id) REFERENCES {PG_SCHEMA}.cy(id)"),
        format!("ALTER TABLE {PG_SCHEMA}.cy ADD CONSTRAINT cy_fk FOREIGN KEY (x_id) REFERENCES {PG_SCHEMA}.cx(id) DEFERRABLE INITIALLY DEFERRED"),
        // クライアントのバイナリデコードが対応しない型。
        format!(
            "CREATE TABLE {PG_SCHEMA}.odd (id int PRIMARY KEY, r int4range, pt point, tsv tsvector, tz timetz, \
             ts_inf timestamptz, d_inf date, n_inf numeric)"
        ),
        format!("CREATE TABLE {PG_SCHEMA}.ident_explicit (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text)"),
        // 表の DEFAULT から呼ばれる関数 (表より前に作られる必要がある)。
        format!("CREATE FUNCTION {PG_SCHEMA}.early_fn() RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT 42'"),
        format!("CREATE TABLE {PG_SCHEMA}.use_fn (id int PRIMARY KEY, n int DEFAULT {PG_SCHEMA}.early_fn())"),
        format!("CREATE TABLE {PG_SCHEMA}.inh_parent (id int)"),
        format!("CREATE TABLE {PG_SCHEMA}.inh_child (extra int) INHERITS ({PG_SCHEMA}.inh_parent)"),
        // 表に依存する関数 (表より前だと作れない): SETOF 表 と BEGIN ATOMIC。
        format!("CREATE FUNCTION {PG_SCHEMA}.ret_tbl() RETURNS SETOF {PG_SCHEMA}.tree LANGUAGE sql AS 'SELECT * FROM {PG_SCHEMA}.tree'"),
        format!("CREATE FUNCTION {PG_SCHEMA}.atomic_fn() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM {PG_SCHEMA}.tree; END"),
        format!("CREATE VIEW {PG_SCHEMA}.v_parent AS SELECT id, name FROM {PG_SCHEMA}.parent WHERE flag"),
        format!("CREATE MATERIALIZED VIEW {PG_SCHEMA}.mv_parent AS SELECT id FROM {PG_SCHEMA}.parent"),
        // 名前順では v_parent より前に来るが、v_parent に依存するビュー。
        format!("CREATE VIEW {PG_SCHEMA}.a_view_over AS SELECT id FROM {PG_SCHEMA}.v_parent"),
        format!(
            "CREATE FUNCTION {PG_SCHEMA}.nb2033_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.label := coalesce(NEW.label, 'trg'); RETURN NEW; END $$"
        ),
        format!(
            "CREATE TRIGGER nb2033_trg BEFORE INSERT ON {PG_SCHEMA}.a_child FOR EACH ROW EXECUTE FUNCTION {PG_SCHEMA}.nb2033_fn()"
        ),
        format!(
            "INSERT INTO {PG_SCHEMA}.parent (id, name, note, big, num, f, bin, d, ts, js, flag, u, arr) VALUES \
             (1, 'plain', 'a', -9223372036854775808, 12345678901234.5678, 0.1, '\\x00ff10', '2024-02-29', '2024-02-29 23:59:59.123456+00', '{{\"k\": [1, 2]}}', true, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{{a,\"b,c\",\"d e\"}}'), \
             (2, 'it''s \\ back{nl}slash \"dq\" {tab} tab', 'emoji \u{1F600} \u{65E5}\u{672C}\u{8A9E}', 9223372036854775807, NULL, 'NaN', ''::bytea, NULL, NULL, NULL, false, NULL, NULL), \
             (3, NULL, NULL, NULL, -0.0001, 'Infinity', NULL, '0001-01-01', NULL, 'null', NULL, NULL, '{{}}'), \
             (4, 'zero', '', 0, 0, -1.5e10, '\\x275c22', '2000-01-01', '2000-01-01 00:00:00+00', '{{}}', true, NULL, '{{NULL}}')",
            nl = "\n",
            tab = "\t"
        ),
        format!("UPDATE {PG_SCHEMA}.parent SET mo = 'it''s', pz = 5 WHERE id = 2"),
        format!("INSERT INTO {PG_SCHEMA}.a_child (id, pid, label) VALUES (1, 1, 'x'), (2, 2, NULL), (3, NULL, 'o''k')"),
        format!("INSERT INTO {PG_SCHEMA}.ident_always (id, v) OVERRIDING SYSTEM VALUE VALUES (10, 'a'), (20, 'b')"),
        format!("INSERT INTO {PG_SCHEMA}.ident_always (v) VALUES ('auto')"),
        format!("INSERT INTO {PG_SCHEMA}.ident_def (id, v) VALUES (7, 'x')"),
        format!("INSERT INTO {PG_SCHEMA}.ident_def (v) VALUES ('auto')"),
        format!("INSERT INTO {PG_SCHEMA}.tree VALUES (1, NULL), (2, 1), (3, 2)"),
        format!("INSERT INTO {PG_SCHEMA}.cx VALUES (1, NULL)"),
        format!("INSERT INTO {PG_SCHEMA}.cy VALUES (1, 1)"),
        format!("UPDATE {PG_SCHEMA}.cx SET y_id = 1"),
        format!(
            "INSERT INTO {PG_SCHEMA}.odd VALUES \
             (1, '[1,10)', '(1,2)', to_tsvector('simple', 'a b'), '12:00:00+09', 'infinity', '-infinity', 'Infinity'), \
             (2, 'empty', NULL, NULL, NULL, '-infinity', 'infinity', '-Infinity'), \
             (3, NULL, NULL, NULL, NULL, NULL, NULL, 'NaN')"
        ),
        format!("INSERT INTO {PG_SCHEMA}.inh_parent VALUES (1)"),
        format!("INSERT INTO {PG_SCHEMA}.inh_child VALUES (2, 9)"),
        // 一度も採番されず、明示値だけ入った identity (最大値を下限に setval されること)。
        format!("INSERT INTO {PG_SCHEMA}.ident_explicit (id, v) VALUES (5, 'a'), (9, 'b')"),
        format!("INSERT INTO {PG_SCHEMA}.use_fn (id) VALUES (1)"),
        format!("INSERT INTO {PG_SCHEMA}.\"Odd \"\"Name\" VALUES (1, 'select'), (2, NULL)"),
        format!("REFRESH MATERIALIZED VIEW {PG_SCHEMA}.mv_parent"),
        // 採番の現在値 (復元後の次の値が続くこと)。
        format!("SELECT setval('{PG_SCHEMA}.parent_id_seq', 4)"),
        format!("SELECT nextval('{PG_SCHEMA}.standalone_seq')"),
    ] {
        conn.execute(&sql, None)
            .await
            .unwrap_or_else(|e| panic!("ddl failed: {e}\n{sql}"));
    }
}

fn psql_cli(opts: &t::DbConnectOptions, sql_file: &std::path::Path) -> bool {
    let mut cmd = Command::new("psql");
    cmd.arg("-h")
        .arg(&opts.host)
        .arg("-p")
        .arg(opts.port.to_string())
        .arg("-U")
        .arg(&opts.user)
        .arg("-v")
        .arg("ON_ERROR_STOP=1")
        .arg("-q")
        .arg("-X");
    if let Some(db) = opts.database.as_deref().filter(|d| !d.is_empty()) {
        cmd.arg("-d").arg(db);
    }
    if !opts.password.is_empty() {
        cmd.env("PGPASSWORD", &opts.password);
    }
    cmd.arg("-f").arg(sql_file);
    let out = cmd.output().expect("run psql");
    if !out.status.success() {
        eprintln!("psql: {}", String::from_utf8_lossy(&out.stderr));
    }
    out.status.success()
}

#[tokio::test]
async fn postgres_native_dump_roundtrips_when_env_set() {
    let Ok(url) = std::env::var("NOOBDB_TEST_POSTGRES_URL") else {
        eprintln!("skip: NOOBDB_TEST_POSTGRES_URL not set");
        return;
    };
    if !client_available("psql") {
        eprintln!("skip: psql client not found");
        return;
    }
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    pg_setup(&conn).await;

    let mut before = Vec::new();
    for sql in PG_SELECTS {
        before.push(rows_of(&conn, sql).await);
    }
    let next_serial_before = rows_of(
        &conn,
        &format!("SELECT nextval('{PG_SCHEMA}.standalone_seq')"),
    )
    .await;

    let dump = dump_to_string(&conn, PG_SCHEMA, &options(serde_json::json!({})))
        .await
        .expect("dump");
    assert!(dump.contains(&format!(
        "DROP TABLE IF EXISTS \"{PG_SCHEMA}\".\"parent\" CASCADE;"
    )));
    assert!(dump.contains("standard_conforming_strings = on"));
    assert!(
        !dump.contains("gen_v\") VALUES"),
        "generated column not inserted"
    );
    assert!(dump.contains("OVERRIDING SYSTEM VALUE VALUES"));
    assert!(dump.contains("inherits from another table"));
    // 外部キーは CREATE TABLE に埋め込まず、データの後に ALTER TABLE で付く。
    let create_a = dump
        .find("CREATE TABLE \"nb2033_dump\".\"a_child\"")
        .expect("a_child ddl");
    let fk_alter = dump.find("ADD CONSTRAINT nb2033_fk").expect("fk alter");
    assert!(fk_alter > create_a);
    assert!(!dump[create_a..fk_alter].contains("REFERENCES"));
    assert!(dump.contains("SET IntervalStyle = 'postgres'"));
    assert!(dump.contains("$noobdb$") && !dump.contains("DO $$"));
    // スキーマ全体のダンプは CASCADE、関数は依存に応じた位置に出る。
    assert!(dump.contains("DROP TABLE IF EXISTS \"nb2033_dump\".\"parent\" CASCADE;"));
    let early = dump
        .find("FUNCTION nb2033_dump.early_fn")
        .expect("early_fn");
    let use_fn_tbl = dump
        .find("CREATE TABLE \"nb2033_dump\".\"use_fn\"")
        .expect("use_fn");
    assert!(
        early < use_fn_tbl,
        "default-referenced function precedes tables"
    );
    let tree_tbl = dump
        .find("CREATE TABLE \"nb2033_dump\".\"tree\"")
        .expect("tree");
    let late = dump.find("FUNCTION nb2033_dump.ret_tbl").expect("ret_tbl");
    let atomic = dump
        .find("FUNCTION nb2033_dump.atomic_fn")
        .expect("atomic_fn");
    let view1 = dump.find("CREATE VIEW \"nb2033_dump\"").expect("view");
    assert!(
        tree_tbl < late && tree_tbl < atomic,
        "table-dependent functions follow tables"
    );
    assert!(late < view1 && atomic < view1);
    // add_drop_table の DROP は、シーケンス作成より前にまとめて出る。
    let last_drop = dump.rfind("DROP TABLE IF EXISTS").expect("drop");
    assert!(last_drop < dump.find("CREATE SEQUENCE").expect("seq"));
    // ビューは依存順。
    let (pv, ov) = (
        dump.find("VIEW \"nb2033_dump\".\"v_parent\" AS"),
        dump.find("VIEW \"nb2033_dump\".\"a_view_over\" AS"),
    );
    assert!(pv.is_some() && ov.is_some() && pv < ov);
    // トリガー関数は routines オフでも出る (トリガーだけだと復元できない)。
    let no_routines = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"routines": false})),
    )
    .await
    .expect("dump");
    assert!(no_routines.contains("nb2033_fn"));
    assert!(no_routines.contains("CREATE OR REPLACE FUNCTION"));

    // 復元: スキーマごと消してダンプだけから作り直す。
    conn.execute(&format!("DROP SCHEMA {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("drop");
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_dump_native_pg_restore_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path, &dump).expect("write dump");
    let ok = psql_cli(&opts, &path);
    let _ = std::fs::remove_file(&path);
    assert!(ok, "restore failed\n{dump}");

    for (i, sql) in PG_SELECTS.iter().enumerate() {
        // 復元でスナップショットが作り直されるマテビューも内容は同じ。
        assert_eq!(rows_of(&conn, sql).await, before[i], "rows differ: {sql}");
    }
    // 既存のオブジェクトがある状態へもう一度復元できる (DROP が先にあり、所有シーケンスの
    // 道連れ削除で CREATE が失敗しない)。復元前に足した行は消える。
    conn.execute(
        &format!("INSERT INTO {PG_SCHEMA}.tree VALUES (99, NULL)"),
        None,
    )
    .await
    .expect("junk row");
    let mut path2 = std::env::temp_dir();
    path2.push(format!(
        "noobdb_dump_native_pg_restore2_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path2, &dump).expect("write dump");
    let ok2 = psql_cli(&opts, &path2);
    let _ = std::fs::remove_file(&path2);
    assert!(ok2, "restore over existing objects failed");
    for (i, sql) in PG_SELECTS.iter().enumerate() {
        assert_eq!(
            rows_of(&conn, sql).await,
            before[i],
            "rows differ after 2nd restore: {sql}"
        );
    }
    // 明示値だけの identity は最大値の次から採番される。
    conn.execute(
        &format!("INSERT INTO {PG_SCHEMA}.ident_explicit (v) VALUES ('n')"),
        None,
    )
    .await
    .expect("insert explicit");
    let ie = rows_of(
        &conn,
        &format!("SELECT id FROM {PG_SCHEMA}.ident_explicit WHERE v = 'n'"),
    )
    .await;
    assert!(ie.contains("Int(10)"), "{ie}");
    // データだけのダンプ (no_create_info) でも、行は FK の親→子の順に出る (子が名前順で先でも)。
    let data_only_fk = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"noCreateInfo": true, "tables": ["a_child", "parent"]})),
    )
    .await
    .expect("data-only dump");
    let p_at = data_only_fk
        .find("INSERT INTO \"nb2033_dump\".\"parent\"")
        .expect("parent rows");
    let c_at = data_only_fk
        .find("INSERT INTO \"nb2033_dump\".\"a_child\"")
        .expect("child rows");
    assert!(p_at < c_at, "parent rows precede child rows");
    assert!(!data_only_fk.contains("CASCADE"));
    conn.execute(&format!("TRUNCATE {PG_SCHEMA}.parent CASCADE"), None)
        .await
        .expect("truncate");
    let mut path3 = std::env::temp_dir();
    path3.push(format!(
        "noobdb_dump_native_pg_data_only_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path3, &data_only_fk).expect("write dump");
    let ok3 = psql_cli(&opts, &path3);
    let _ = std::fs::remove_file(&path3);
    assert!(ok3, "data-only restore failed\n{data_only_fk}");
    for (i, sql) in PG_SELECTS.iter().enumerate().take(2) {
        assert_eq!(
            rows_of(&conn, sql).await,
            before[i],
            "rows differ after data-only restore: {sql}"
        );
    }
    // identity の続きから採番される (ALWAYS / BY DEFAULT どちらも)。
    conn.execute(
        &format!("INSERT INTO {PG_SCHEMA}.ident_always (v) VALUES ('n')"),
        None,
    )
    .await
    .expect("insert after restore");
    let ia = rows_of(
        &conn,
        &format!("SELECT id FROM {PG_SCHEMA}.ident_always WHERE v = 'n'"),
    )
    .await;
    assert!(ia.contains("Int(2)"), "{ia}");
    conn.execute(
        &format!("INSERT INTO {PG_SCHEMA}.ident_def (v) VALUES ('n')"),
        None,
    )
    .await
    .expect("insert after restore");
    let id = rows_of(
        &conn,
        &format!("SELECT id FROM {PG_SCHEMA}.ident_def WHERE v = 'n'"),
    )
    .await;
    assert!(id.contains("Int(2)"), "{id}");
    // 標準シーケンスの続き (setval が効いている) と、serial の既定値・FK・トリガー・索引。
    let next_after = rows_of(
        &conn,
        &format!("SELECT nextval('{PG_SCHEMA}.standalone_seq')"),
    )
    .await;
    assert_ne!(
        next_after, next_serial_before,
        "sequence advanced past dumped value"
    );
    let nid = rows_of(
        &conn,
        &format!("SELECT nextval('{PG_SCHEMA}.parent_id_seq')"),
    )
    .await;
    assert!(
        nid.contains("Int(5)"),
        "serial continues after the dumped rows: {nid}"
    );
    let objs = rows_of(
        &conn,
        &format!(
            "SELECT (SELECT COUNT(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '{PG_SCHEMA}' AND NOT t.tgisinternal), \
                    (SELECT COUNT(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = '{PG_SCHEMA}' AND k.contype = 'f'), \
                    (SELECT COUNT(*) FROM pg_indexes WHERE schemaname = '{PG_SCHEMA}' AND indexname = 'nb2033_idx')"
        ),
    )
    .await;
    // トリガー 1 / 外部キー 4 (a_child, tree, cx, cy) / 索引 1。
    assert!(
        objs.contains("Int(4)") && objs.matches("Int(1)").count() == 2,
        "{objs}"
    );

    // 1 行 1 文 / データなし / データのみ / テーブル指定 / マスキング。
    let single = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"extendedInsert": false})),
    )
    .await
    .expect("dump");
    assert_eq!(
        single
            .matches("INSERT INTO \"nb2033_dump\".\"parent\"")
            .count(),
        4
    );
    let no_data = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"noData": true})),
    )
    .await
    .expect("dump");
    assert!(!no_data.contains("INSERT INTO") && !no_data.contains("setval"));
    let data_only = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"noCreateInfo": true})),
    )
    .await
    .expect("dump");
    assert!(!data_only.contains("CREATE TABLE") && !data_only.contains("CREATE SEQUENCE"));
    assert!(data_only.contains("setval"));
    let scoped = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({"tables": ["a_child"]})),
    )
    .await
    .expect("dump");
    // 部分ダンプでは CASCADE を付けない (範囲外の FK やビューを巻き込まない)。
    assert!(!scoped.contains("CASCADE"));
    assert!(
        scoped.contains("\"a_child\"")
            && !scoped.contains("INSERT INTO \"nb2033_dump\".\"parent\"")
    );
    let masked = dump_to_string(
        &conn,
        PG_SCHEMA,
        &options(serde_json::json!({
            "masks": [{"column": "name", "rule": {"kind": "fixed", "value": "***"}}]
        })),
    )
    .await
    .expect("masked dump");
    assert!(masked.contains("'***'") && !masked.contains("'plain'") && !masked.contains("'zero'"));

    conn.execute(&format!("DROP SCHEMA {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("cleanup");

    // パーティション親は未対応として明示エラー。
    for sql in [
        "DROP SCHEMA IF EXISTS nb2033_part CASCADE",
        "CREATE SCHEMA nb2033_part",
        "CREATE TABLE nb2033_part.pt (id int) PARTITION BY RANGE (id)",
    ] {
        conn.execute(sql, None).await.expect("partition ddl");
    }
    let err = dump_to_string(&conn, "nb2033_part", &options(serde_json::json!({})))
        .await
        .expect_err("partitioned table is rejected");
    assert!(err.contains("partitioned table"), "{err}");
    conn.execute("DROP SCHEMA nb2033_part CASCADE", None)
        .await
        .expect("cleanup partition");
}
