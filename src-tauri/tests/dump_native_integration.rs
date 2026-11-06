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

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::process::{Command, Stdio};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use noobdb_lib::__test_api as t;

const MYSQL_DB: &str = "nb2033_dump_db";
const PG_SCHEMA: &str = "nb2033_dump";
const PART_SCHEMA: &str = "nb2098_part";

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
    let Some(url) = common::require_env("NOOBDB_TEST_MYSQL_URL") else {
        return;
    };
    if !client_available("mysql") {
        common::skip_external("mysql client not found");
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
        // 関数を呼ぶ domain (関数の後に制約を付ける必要がある)。
        format!("CREATE FUNCTION {PG_SCHEMA}.is_pos(int) RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT $1 > 0'"),
        format!("CREATE DOMAIN {PG_SCHEMA}.posint2 AS int DEFAULT 1 CHECK ({PG_SCHEMA}.is_pos(VALUE))"),
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
        format!("CREATE TABLE {PG_SCHEMA}.use_fn (id int PRIMARY KEY, n int DEFAULT {PG_SCHEMA}.early_fn(), m {PG_SCHEMA}.posint2)"),
        format!("CREATE TABLE {PG_SCHEMA}.inh_parent (id int)"),
        format!("CREATE TABLE {PG_SCHEMA}.inh_child (extra int) INHERITS ({PG_SCHEMA}.inh_parent)"),
        // 表に依存する関数 (表より前だと作れない): SETOF 表 と BEGIN ATOMIC。
        format!("CREATE FUNCTION {PG_SCHEMA}.ret_tbl() RETURNS SETOF {PG_SCHEMA}.tree LANGUAGE sql AS 'SELECT * FROM {PG_SCHEMA}.tree'"),
        format!("CREATE FUNCTION {PG_SCHEMA}.atomic_fn() RETURNS bigint LANGUAGE sql BEGIN ATOMIC SELECT count(*) FROM {PG_SCHEMA}.tree; END"),
        format!("CREATE VIEW {PG_SCHEMA}.v_parent AS SELECT id, name FROM {PG_SCHEMA}.parent WHERE flag"),
        format!("CREATE MATERIALIZED VIEW {PG_SCHEMA}.mv_parent AS SELECT id FROM {PG_SCHEMA}.parent"),
        format!("CREATE UNIQUE INDEX nb2033_mv_idx ON {PG_SCHEMA}.mv_parent (id)"),
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
        format!("INSERT INTO {PG_SCHEMA}.use_fn (id, m) VALUES (1, 3), (2, DEFAULT)"),
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
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    if !client_available("psql") {
        common::skip_external("psql client not found");
        return;
    }
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    pg_setup(&conn).await;
    // 拡張 (contrib が入っているときだけ)。拡張が持つビュー・関数は独立した DDL にならない。
    let ext_ok = conn
        .execute("CREATE EXTENSION pg_buffercache SCHEMA nb2033_dump", None)
        .await
        .is_ok();

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
    // domain の制約は、それが呼ぶ関数の後に付く。
    let f_at = dump.find("FUNCTION nb2033_dump.is_pos").expect("is_pos");
    let d_at = dump
        .find("ALTER DOMAIN nb2033_dump.posint2 ADD CONSTRAINT")
        .expect("domain constraint");
    assert!(f_at < d_at);
    // 拡張が所有する表・ビューは独立した DDL にならず、CREATE EXTENSION だけが出る。
    if ext_ok {
        assert!(dump.contains("CREATE EXTENSION IF NOT EXISTS \"pg_buffercache\""));
        assert!(
            !dump.contains("pg_buffercache\" AS") && !dump.contains("\"pg_buffercache\" CASCADE")
        );
        assert!(!dump.contains("CREATE VIEW \"nb2033_dump\".\"pg_buffercache\""));
    }
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
    // マテビューの索引が復元され、CONCURRENTLY で更新できる。
    let mvi = rows_of(
        &conn,
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'nb2033_mv_idx'",
    )
    .await;
    assert!(mvi.contains("Int(1)"), "{mvi}");
    conn.execute(
        &format!("REFRESH MATERIALIZED VIEW CONCURRENTLY {PG_SCHEMA}.mv_parent"),
        None,
    )
    .await
    .expect("refresh concurrently");
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

    // 親子 2 表の部分ダンプを、既存の (旧データが残った) 表へ復元できる。DROP は子→親の順で、
    // CASCADE なしでも親が子の FK に阻まれない。
    for sql in [
        "DROP SCHEMA IF EXISTS nb2033_pair CASCADE",
        "CREATE SCHEMA nb2033_pair",
        "CREATE TABLE nb2033_pair.pp (id int PRIMARY KEY, v text)",
        "CREATE TABLE nb2033_pair.cc (id int PRIMARY KEY, pid int REFERENCES nb2033_pair.pp(id))",
        "INSERT INTO nb2033_pair.pp VALUES (1, 'a'), (2, 'b')",
        "INSERT INTO nb2033_pair.cc VALUES (1, 1), (2, 2)",
    ] {
        conn.execute(sql, None).await.expect("pair ddl");
    }
    let pair_sel = [
        "SELECT * FROM nb2033_pair.pp ORDER BY id",
        "SELECT * FROM nb2033_pair.cc ORDER BY id",
    ];
    let pair_before = [
        rows_of(&conn, pair_sel[0]).await,
        rows_of(&conn, pair_sel[1]).await,
    ];
    let pair_dump = dump_to_string(
        &conn,
        "nb2033_pair",
        &options(serde_json::json!({"tables": ["cc", "pp"]})),
    )
    .await
    .expect("pair dump");
    assert!(!pair_dump.contains("CASCADE"));
    assert!(
        pair_dump.find("DROP TABLE IF EXISTS \"nb2033_pair\".\"cc\"")
            < pair_dump.find("DROP TABLE IF EXISTS \"nb2033_pair\".\"pp\"")
    );
    conn.execute("INSERT INTO nb2033_pair.pp VALUES (99, 'old')", None)
        .await
        .expect("old parent row");
    conn.execute("INSERT INTO nb2033_pair.cc VALUES (99, 99)", None)
        .await
        .expect("old child row");
    let mut path4 = std::env::temp_dir();
    path4.push(format!(
        "noobdb_dump_native_pg_pair_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path4, &pair_dump).expect("write dump");
    let ok4 = psql_cli(&opts, &path4);
    let _ = std::fs::remove_file(&path4);
    assert!(
        ok4,
        "partial restore over existing tables failed\n{pair_dump}"
    );
    for (i, sql) in pair_sel.iter().enumerate() {
        assert_eq!(rows_of(&conn, sql).await, pair_before[i], "{sql}");
    }
    conn.execute("DROP SCHEMA nb2033_pair CASCADE", None)
        .await
        .expect("cleanup pair");
}

// ---------------------------------------------------------------------------
// PostgreSQL パーティション表 (#2098)
// ---------------------------------------------------------------------------

/// 元と復元先で突き合わせる SELECT。行は親経由 (全葉の合算) と、葉ごとの配置 (`tableoid`) の両方を見る。
const PART_ROW_SELECTS: &[&str] = &[
    "SELECT id, created, region, payload, ref_id, rid FROM nb2098_part.events ORDER BY id, created",
    "SELECT tableoid::regclass::text, id FROM nb2098_part.events ORDER BY 1, 2",
    "SELECT id, region, v FROM nb2098_part.by_region ORDER BY id",
    "SELECT tableoid::regclass::text, id FROM nb2098_part.by_region ORDER BY 1, 2",
    "SELECT id, v FROM nb2098_part.hp ORDER BY id",
    "SELECT tableoid::regclass::text, id FROM nb2098_part.hp ORDER BY 1, 2",
    "SELECT id, event_id, event_created FROM nb2098_part.child_ref ORDER BY id",
    "SELECT id, label FROM nb2098_part.ref_t ORDER BY id",
    "SELECT tableoid::regclass::text, id, pid, kind FROM nb2098_part.tree ORDER BY 1, 2",
    // 子だけ式が違う生成列 (gc1 は a*3、gc2 は親と同じ a*2)。値は復元先でも子の式で再計算される。
    "SELECT tableoid::regclass::text, a, g FROM nb2098_part.gen_p ORDER BY 1, 2",
];

/// 定義側の突き合わせ。パーティション構造・索引・制約・トリガー。
const PART_DEF_SELECTS: &[&str] = &[
    "SELECT c.relname, c.relkind::text, c.relispartition, pg_get_partkeydef(c.oid), \
            pg_get_expr(c.relpartbound, c.oid), \
            (SELECT pc.relname FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent WHERE i.inhrelid = c.oid) \
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
      WHERE n.nspname = 'nb2098_part' AND c.relkind IN ('r', 'p') ORDER BY 1",
    "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'nb2098_part' ORDER BY 1, 2",
    // 分割表の索引が無効 (ON ONLY のまま) で復元されていないことも、状態で突き合わせる。
    "SELECT c.relname, i.indisvalid, i.indisready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid \
      WHERE c.relnamespace = 'nb2098_part'::regnamespace ORDER BY 1",
    "SELECT c.relname, a.attname, pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d \
       JOIN pg_class c ON c.oid = d.adrelid JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
      WHERE c.relnamespace = 'nb2098_part'::regnamespace AND c.relname IN ('gen_p', 'gc1', 'gc2') ORDER BY 1, 2",
    "SELECT conrelid::regclass::text, conname, contype::text, pg_get_constraintdef(oid) \
       FROM pg_constraint WHERE connamespace = 'nb2098_part'::regnamespace ORDER BY 1, 2",
    "SELECT tgrelid::regclass::text, tgname, pg_get_triggerdef(oid) FROM pg_trigger \
      WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'nb2098_part.%' ORDER BY 1, 2",
];

async fn part_setup(conn: &t::Connection) {
    // データは親経由で入れる。元の DB ではサーバの振り分け (既定パーティション・hash を含む) に任せ、
    // ダンプが葉ごとに読んで葉へ直接書く (親からは出さない) ことを、`tableoid` の配置の一致で確かめる。
    for sql in [
        "DROP SCHEMA IF EXISTS nb2098_part CASCADE".to_string(),
        "CREATE SCHEMA nb2098_part".to_string(),
        "CREATE TABLE nb2098_part.ref_t (id int PRIMARY KEY, label text)".into(),
        "INSERT INTO nb2098_part.ref_t VALUES (1, 'a'), (2, 'it''s')".into(),
        // range + 既定パーティション。PK・通常索引・親の外部キー・CHECK を持つ。
        "CREATE TABLE nb2098_part.events (id bigint NOT NULL, created date NOT NULL, region text, \
           payload text, ref_id int REFERENCES nb2098_part.ref_t (id), rid int, CHECK (id > 0), \
           PRIMARY KEY (id, created)) PARTITION BY RANGE (created)".into(),
        "CREATE TABLE nb2098_part.e_2024 PARTITION OF nb2098_part.events FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')".into(),
        "CREATE TABLE nb2098_part.e_2025 PARTITION OF nb2098_part.events FOR VALUES FROM ('2025-01-01') TO ('2026-01-01')".into(),
        "CREATE TABLE nb2098_part.e_default PARTITION OF nb2098_part.events DEFAULT".into(),
        "CREATE INDEX events_region_idx ON nb2098_part.events (region)".into(),
        // 子だけが持つ索引と制約 (親から伝播しないもの)。
        "CREATE INDEX e_2024_payload_local ON nb2098_part.e_2024 (payload)".into(),
        "ALTER TABLE nb2098_part.e_2025 ADD CONSTRAINT e_2025_payload_chk CHECK (payload <> 'forbidden')".into(),
        "INSERT INTO nb2098_part.events VALUES \
           (1, '2024-03-01', 'eu', 'one', 1), (2, '2024-12-31', 'us', 'it''s', NULL), \
           (3, '2025-01-01', 'eu', E'tab\there', 2), (4, '2025-06-15', NULL, NULL, 1), \
           (5, '2030-01-01', 'jp', 'future', NULL), (6, '2020-02-02', 'cn', 'past', 2), \
           (9007199254740993, '2024-05-05', 'eu', 'big', NULL)".into(),
        // list + 既定 + 多段 (list の下に hash)。
        "CREATE TABLE nb2098_part.by_region (id int NOT NULL, region text NOT NULL, v text, \
           PRIMARY KEY (id, region)) PARTITION BY LIST (region)".into(),
        "CREATE TABLE nb2098_part.r_eu PARTITION OF nb2098_part.by_region FOR VALUES IN ('fr', 'de')".into(),
        "CREATE TABLE nb2098_part.r_us PARTITION OF nb2098_part.by_region FOR VALUES IN ('us')".into(),
        "CREATE TABLE nb2098_part.r_asia PARTITION OF nb2098_part.by_region FOR VALUES IN ('jp', 'cn') PARTITION BY HASH (id)".into(),
        "CREATE TABLE nb2098_part.r_asia_0 PARTITION OF nb2098_part.r_asia FOR VALUES WITH (modulus 2, remainder 0)".into(),
        "CREATE TABLE nb2098_part.r_asia_1 PARTITION OF nb2098_part.r_asia FOR VALUES WITH (modulus 2, remainder 1)".into(),
        "CREATE TABLE nb2098_part.r_other PARTITION OF nb2098_part.by_region DEFAULT".into(),
        "INSERT INTO nb2098_part.by_region SELECT g, (ARRAY['fr','de','us','jp','cn','br'])[g % 6 + 1], 'v' || g FROM generate_series(1, 18) g".into(),
        // 子 (分割表) だけが持つ索引。ON ONLY のまま出すと復元先で無効な分割索引になる。
        "CREATE INDEX ON nb2098_part.r_asia (v)".into(),
        // events から by_region (別の分割表) への複合 FK。r_eu / r_us の葉のデータが e_* より先でなければ
        // ならず (名前順だと e_* が先)、複製された FK は二重に出さない。
        "ALTER TABLE nb2098_part.events ADD CONSTRAINT events_rid_region_fkey FOREIGN KEY (rid, region) REFERENCES nb2098_part.by_region (id, region)".into(),
        "INSERT INTO nb2098_part.events (id, created, region, payload, rid) VALUES (10, '2024-02-02', 'de', 'fk1', 1), (11, '2025-02-02', 'us', 'fk2', 2)".into(),
        // 生成列の式が親と違う子 (PARTITION OF の列オプションで式を保つ必要がある)。
        "CREATE TABLE nb2098_part.gen_p (a int NOT NULL, g int GENERATED ALWAYS AS (a * 2) STORED) PARTITION BY LIST (a)".into(),
        "CREATE TABLE nb2098_part.gc1 PARTITION OF nb2098_part.gen_p (g WITH OPTIONS GENERATED ALWAYS AS (a * 3) STORED) FOR VALUES IN (1, 3)".into(),
        "CREATE TABLE nb2098_part.gc2 PARTITION OF nb2098_part.gen_p FOR VALUES IN (2)".into(),
        "INSERT INTO nb2098_part.gen_p (a) VALUES (1), (2), (3)".into(),
        // hash のみ。
        "CREATE TABLE nb2098_part.hp (id int PRIMARY KEY, v text) PARTITION BY HASH (id)".into(),
        "CREATE TABLE nb2098_part.hp_0 PARTITION OF nb2098_part.hp FOR VALUES WITH (modulus 3, remainder 0)".into(),
        "CREATE TABLE nb2098_part.hp_1 PARTITION OF nb2098_part.hp FOR VALUES WITH (modulus 3, remainder 1)".into(),
        "CREATE TABLE nb2098_part.hp_2 PARTITION OF nb2098_part.hp FOR VALUES WITH (modulus 3, remainder 2)".into(),
        "INSERT INTO nb2098_part.hp SELECT g, 'h' || g FROM generate_series(1, 20) g".into(),
        // パーティション表を参照する外部キー (複合キー)。
        "CREATE TABLE nb2098_part.child_ref (id int PRIMARY KEY, event_id bigint, event_created date, \
           FOREIGN KEY (event_id, event_created) REFERENCES nb2098_part.events (id, created))".into(),
        "INSERT INTO nb2098_part.child_ref VALUES (1, 1, '2024-03-01'), (2, 5, '2030-01-01')".into(),
        // 自己参照 FK を持つパーティション表。子の名前 (a_tree_x) が親 (tree) より辞書順で前でも、
        // 親が先に出ること (循環扱いで名前順に落ちて PARTITION OF が先に出ない)。
        "CREATE TABLE nb2098_part.tree (id int NOT NULL, pid int, kind text NOT NULL, \
           PRIMARY KEY (id, kind), FOREIGN KEY (pid, kind) REFERENCES nb2098_part.tree (id, kind)) PARTITION BY LIST (kind)".into(),
        "CREATE TABLE nb2098_part.a_tree_x PARTITION OF nb2098_part.tree FOR VALUES IN ('x')".into(),
        "CREATE TABLE nb2098_part.b_tree_y PARTITION OF nb2098_part.tree FOR VALUES IN ('y')".into(),
        "INSERT INTO nb2098_part.tree VALUES (1, NULL, 'x'), (2, 1, 'x'), (3, 2, 'x'), (1, NULL, 'y'), (2, 1, 'y')".into(),
        // 親のトリガーは子へ複製される (子の分を二重に出すと復元が失敗する)。
        "CREATE FUNCTION nb2098_part.touch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'".into(),
        "CREATE TRIGGER events_touch AFTER UPDATE ON nb2098_part.events FOR EACH ROW EXECUTE FUNCTION nb2098_part.touch()".into(),
    ] {
        conn.execute(&sql, None)
            .await
            .unwrap_or_else(|e| panic!("ddl failed: {e}\n{sql}"));
    }
}

async fn snapshot(conn: &t::Connection, selects: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    for sql in selects {
        out.push(rows_of(conn, sql).await);
    }
    out
}

fn psql_restore(opts: &t::DbConnectOptions, sql: &str, tag: &str) -> bool {
    let mut path = std::env::temp_dir();
    path.push(format!(
        "noobdb_dump_native_pg_{tag}_{}.sql",
        std::process::id()
    ));
    std::fs::write(&path, sql).expect("write dump");
    let ok = psql_cli(opts, &path);
    let _ = std::fs::remove_file(&path);
    ok
}

#[tokio::test]
async fn postgres_native_dump_partitions_roundtrip_when_env_set() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    if !client_available("psql") {
        common::skip_external("psql client not found");
        return;
    }
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    // 親のトリガー複製の判別 (tgparentid) は PG13+。PG12 では複製が内部トリガー扱いで、通常表として出す子に親由来のトリガーが付かない。
    let ver = rows_of(
        &conn,
        "SELECT current_setting('server_version_num')::int >= 130000",
    )
    .await;
    if !ver.contains("true") {
        common::skip_capability("PostgreSQL < 13");
        return;
    }
    part_setup(&conn).await;
    // 拡張が持つ表は独立した DDL にしない (パーティション表と同居しても除外が効く)。
    let ext_ok = conn
        .execute("CREATE EXTENSION pg_buffercache SCHEMA nb2098_part", None)
        .await
        .is_ok();

    let rows_before = snapshot(&conn, PART_ROW_SELECTS).await;
    let defs_before = snapshot(&conn, PART_DEF_SELECTS).await;

    let dump = dump_to_string(&conn, PART_SCHEMA, &options(serde_json::json!({})))
        .await
        .expect("partition dump");
    assert!(dump.contains("PARTITION BY RANGE (created)"), "{dump}");
    assert!(dump.contains("PARTITION BY HASH (id)"), "{dump}");
    assert!(
        dump.contains("\"e_default\" PARTITION OF \"nb2098_part\".\"events\" DEFAULT"),
        "{dump}"
    );
    assert!(
        dump.contains("FOR VALUES WITH (modulus 3, remainder 1)"),
        "{dump}"
    );
    // 行は葉へ直接書き、親へは書かない。
    assert!(
        dump.contains("INSERT INTO \"nb2098_part\".\"e_2024\""),
        "{dump}"
    );
    assert!(
        !dump.contains("INSERT INTO \"nb2098_part\".\"events\""),
        "{dump}"
    );
    assert!(
        !dump.contains("INSERT INTO \"nb2098_part\".\"r_asia\" "),
        "{dump}"
    );
    assert!(!dump.contains("not supported"), "{dump}");
    assert!(!dump.contains("foreign keys form a cycle"), "{dump}");
    assert!(
        dump.find("CREATE TABLE \"nb2098_part\".\"tree\" (")
            < dump.find("CREATE TABLE \"nb2098_part\".\"a_tree_x\" PARTITION OF"),
        "{dump}"
    );
    assert_eq!(
        dump.matches("ADD CONSTRAINT tree_pid_kind_fkey").count(),
        1,
        "{dump}"
    );
    // 親から伝播する FK / トリガーは子に重ねて出さない。
    assert_eq!(
        dump.matches("ADD CONSTRAINT events_ref_id_fkey").count(),
        1,
        "{dump}"
    );
    assert_eq!(
        dump.matches("CREATE TRIGGER events_touch").count(),
        1,
        "{dump}"
    );
    assert_eq!(
        dump.matches("ADD CONSTRAINT events_rid_region_fkey")
            .count(),
        1,
        "{dump}"
    );
    // 分割表の子の索引は ON ONLY ではなく ON で出る。
    assert!(!dump.contains(" ON ONLY "), "{dump}");
    assert!(
        dump.contains("WITH OPTIONS GENERATED ALWAYS AS ((a * 3)) STORED"),
        "{dump}"
    );
    assert_eq!(dump.matches("WITH OPTIONS GENERATED").count(), 1, "{dump}");
    assert!(
        dump.contains("ON nb2098_part.r_asia USING btree (v)"),
        "{dump}"
    );
    if ext_ok {
        assert!(
            !dump.contains("CREATE TABLE \"nb2098_part\".\"pg_buffercache\""),
            "{dump}"
        );
    }

    // 別 DB へ復元する。
    // 復元先 DB はテスト内で作り直す (事前に用意しておく前提にしない。CI の PG ユーザーは superuser)。
    // 接続が残っていても消せるよう FORCE (PG13+) を使う。
    conn.execute("DROP DATABASE IF EXISTS nb2098_restore WITH (FORCE)", None)
        .await
        .expect("drop stale restore db");
    conn.execute("CREATE DATABASE nb2098_restore", None)
        .await
        .expect("create restore db");
    let mut restore_opts = opts.clone();
    restore_opts.database = Some("nb2098_restore".into());
    let restore = t::connect(&restore_opts).await.expect("connect restore db");
    restore
        .execute("DROP SCHEMA IF EXISTS nb2098_part CASCADE", None)
        .await
        .expect("clean restore db");
    if ext_ok {
        // 復元先にも拡張は要る (CREATE EXTENSION IF NOT EXISTS がダンプに入っている)。
        assert!(dump.contains("CREATE EXTENSION IF NOT EXISTS"), "{dump}");
    }
    assert!(
        psql_restore(&restore_opts, &dump, "part"),
        "restore failed\n{dump}"
    );
    assert_eq!(snapshot(&restore, PART_ROW_SELECTS).await, rows_before);
    assert_eq!(snapshot(&restore, PART_DEF_SELECTS).await, defs_before);
    let invalid = rows_of(
        &restore,
        "SELECT count(*) FROM pg_index WHERE NOT indisvalid AND indrelid::regclass::text LIKE 'nb2098_part.%'",
    )
    .await;
    assert!(invalid.contains('0') && !invalid.contains('1'), "{invalid}");

    // 既存の DB へ上書き復元しても通る (DROP TABLE の順序 / CASCADE)。
    assert!(
        psql_restore(&restore_opts, &dump, "part2"),
        "re-restore failed\n{dump}"
    );
    assert_eq!(snapshot(&restore, PART_ROW_SELECTS).await, rows_before);

    // スキーマだけ / データだけ。
    let schema_only = dump_to_string(
        &conn,
        PART_SCHEMA,
        &options(serde_json::json!({"noData": true})),
    )
    .await
    .expect("schema-only dump");
    assert!(!schema_only.contains("INSERT INTO"), "{schema_only}");
    let data_only = dump_to_string(
        &conn,
        PART_SCHEMA,
        &options(serde_json::json!({"noCreateInfo": true})),
    )
    .await
    .expect("data-only dump");
    assert!(!data_only.contains("CREATE TABLE"), "{data_only}");
    // 参照先の葉が先 (FK 違反にならない順)。
    assert!(
        data_only.find("INSERT INTO \"nb2098_part\".\"e_2024\"")
            < data_only.find("INSERT INTO \"nb2098_part\".\"child_ref\""),
        "{data_only}"
    );

    // 参照先 (by_region) の葉が、参照元 (events) の葉より先 (名前順なら e_* が先になる)。
    assert!(
        data_only.find("INSERT INTO \"nb2098_part\".\"r_eu\"")
            < data_only.find("INSERT INTO \"nb2098_part\".\"e_2024\""),
        "{data_only}"
    );

    // 部分ダンプ: 親を選ぶと子孫も入り、無関係の表は入らない。
    restore
        .execute("DROP SCHEMA nb2098_part CASCADE", None)
        .await
        .expect("drop restored");
    let partial = dump_to_string(
        &conn,
        PART_SCHEMA,
        &options(serde_json::json!({"tables": ["by_region"]})),
    )
    .await
    .expect("partial dump");
    for leaf in ["r_eu", "r_us", "r_asia", "r_asia_0", "r_asia_1", "r_other"] {
        assert!(
            partial.contains(&format!(
                "CREATE TABLE \"nb2098_part\".\"{leaf}\" PARTITION OF"
            )),
            "{leaf}\n{partial}"
        );
    }
    assert!(
        !partial.contains("\"events\"") && !partial.contains("\"hp_0\""),
        "{partial}"
    );
    assert!(
        psql_restore(&restore_opts, &partial, "part3"),
        "partial restore failed\n{partial}"
    );
    let by_region = [PART_ROW_SELECTS[2], PART_ROW_SELECTS[3]];
    assert_eq!(
        snapshot(&restore, &by_region).await,
        rows_before[2..4].to_vec()
    );

    // 子だけを選ぶと、親が出力に無いので通常表として書く (警告つき)。
    let child_only = dump_to_string(
        &conn,
        PART_SCHEMA,
        &options(serde_json::json!({"tables": ["e_2024", "ref_t"]})),
    )
    .await
    .expect("child-only dump");
    assert!(!child_only.contains("PARTITION OF"), "{child_only}");
    // 親由来の FK とトリガーは、通常表として出す子では黙って消さない。
    assert!(
        child_only.contains(
            "ALTER TABLE nb2098_part.e_2024 ADD CONSTRAINT events_ref_id_fkey FOREIGN KEY"
        ),
        "{child_only}"
    );
    assert!(
        child_only.contains("CREATE TRIGGER events_touch"),
        "{child_only}"
    );
    assert!(
        child_only.contains("-- WARNING: table e_2024 is a partition;"),
        "{child_only}"
    );

    conn.execute("DROP DATABASE IF EXISTS nb2098_restore WITH (FORCE)", None)
        .await
        .expect("cleanup restore db");
    conn.execute("DROP SCHEMA nb2098_part CASCADE", None)
        .await
        .expect("cleanup source");
}
