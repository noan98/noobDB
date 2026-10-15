//! 書き込みキャプチャ (#1536) の実 DB 統合テスト。`NOOBDB_TEST_MYSQL_URL` /
//! `NOOBDB_TEST_POSTGRES_URL` が無ければスキップ。レビューで見つかった 4 つの退行の再現
//! (INSERT の取り違え・無関係な行のロック待ち・タイムアウト / キャンセルが効かない) を固定する。
//! テーブル名は一意にして後片付けする (テスト DB は共有)。

use noobdb_lib::__test_api as t;
use std::time::Duration;

fn n(v: &t::Value) -> i64 {
    match v {
        t::Value::Int(i) => *i,
        t::Value::UInt(u) => *u as i64,
        t::Value::String(s) => s.parse().expect("integer string"),
        other => panic!("not an integer: {other:?}"),
    }
}

async fn pg_opts() -> Option<t::DbConnectOptions> {
    let url = std::env::var("NOOBDB_TEST_POSTGRES_URL").ok()?;
    Some(t::parse_postgres_url(&url).expect("pg url"))
}
async fn my_opts() -> Option<t::DbConnectOptions> {
    let url = std::env::var("NOOBDB_TEST_MYSQL_URL").ok()?;
    Some(t::parse_mysql_url(&url).expect("mysql url"))
}
async fn connect(o: &t::DbConnectOptions) -> t::Connection {
    t::connect(o).await.expect("connect")
}

async fn count(c: &t::Connection, sql: &str) -> i64 {
    n(&c.execute(sql, None).await.expect("count").rows[0][0])
}

fn ids(cap: &t::WriteCapture) -> Vec<i64> {
    let idx = cap.columns.iter().position(|x| x == "id").unwrap_or(0);
    cap.after_rows.iter().map(|r| n(&r[idx])).collect()
}

// ---------------------------------------------------------------- PostgreSQL

#[tokio::test]
async fn pg_capture_runs_triggers_once_and_attributes_serial_insert() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_a";
    c.execute(
        &format!("DROP TABLE IF EXISTS {tb}, {tb}_audit, {tb}_ins"),
        None,
    )
    .await
    .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("CREATE TABLE {tb}_audit (n INT)"), None)
        .await
        .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b')"), None)
        .await
        .unwrap();
    c.execute(&format!("CREATE OR REPLACE FUNCTION {tb}_f() RETURNS trigger AS $$ BEGIN INSERT INTO {tb}_audit VALUES (1); RETURN NEW; END $$ LANGUAGE plpgsql"), None).await.unwrap();
    c.execute(
        &format!(
            "CREATE TRIGGER {tb}_t AFTER UPDATE ON {tb} FOR EACH ROW EXECUTE FUNCTION {tb}_f()"
        ),
        None,
    )
    .await
    .unwrap();
    let (r, cap) = c
        .capture_write(
            &format!("UPDATE {tb} SET name = 'z' WHERE id = 1"),
            None,
            100,
        )
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(
        count(&c, &format!("SELECT COUNT(*) FROM {tb}_audit")).await,
        1,
        "トリガは 1 回だけ"
    );

    let tb2 = format!("{tb}_ins");
    c.execute(
        &format!("CREATE TABLE {tb2} (id SERIAL PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    for i in 0..10 {
        c.execute(&format!("INSERT INTO {tb2} (name) VALUES ('s{i}')"), None)
            .await
            .unwrap();
    }
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb2} (name) VALUES ('new')"), None, 3)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(ids(&cap), vec![11]);

    // 失敗する文は何も残さず、行ロックも残さない。
    assert!(c
        .capture_write(&format!("UPDATE {tb} SET id = 2 WHERE id = 1"), None, 100)
        .await
        .is_err());
    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction("SET LOCAL lock_timeout = '2s'")
        .await
        .unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id IN (1,2) FOR UPDATE"))
        .await
        .expect("rows must not stay locked");
    c2.finish_transaction(false).await.unwrap();
    c.execute(
        &format!("DROP TABLE IF EXISTS {tb}, {tb}_audit, {tb2}"),
        None,
    )
    .await
    .unwrap();
}

/// 新規行が窓の外で、同じ文の中のトリガが窓の行を消す: 既存の別行を挿入行と取り違えない。
#[tokio::test]
async fn pg_insert_outside_window_is_not_misattributed() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_win";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    for i in 10..=20 {
        c.execute(&format!("INSERT INTO {tb} VALUES ({i}, 'r{i}')"), None)
            .await
            .unwrap();
    }
    c.execute(&format!("CREATE OR REPLACE FUNCTION {tb}_f() RETURNS trigger AS $$ BEGIN DELETE FROM {tb} WHERE id = 20; RETURN NEW; END $$ LANGUAGE plpgsql"), None).await.unwrap();
    c.execute(
        &format!(
            "CREATE TRIGGER {tb}_t AFTER INSERT ON {tb} FOR EACH ROW EXECUTE FUNCTION {tb}_f()"
        ),
        None,
    )
    .await
    .unwrap();
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb} VALUES (1, 'new')"), None, 3)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1, "書き込みは 1 回実行される");
    let recorded = ids(&cap);
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    assert!(
        !cap.capturable || recorded == vec![1],
        "取り違え: {recorded:?} を挿入行として記録した"
    );
}

/// 同じ文のトリガが窓の行を消し、さらに別の既存行を UPDATE する (その行の xmin も自トランザクション
/// になる)。xmin の確認だけでは既存行を挿入行と取り違えるので、窓の端の候補は辞退する。
#[tokio::test]
async fn pg_trigger_update_of_existing_row_is_not_misattributed() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_trgupd";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    for i in 10..=20 {
        c.execute(&format!("INSERT INTO {tb} VALUES ({i}, 'r{i}')"), None)
            .await
            .unwrap();
    }
    c.execute(&format!("CREATE OR REPLACE FUNCTION {tb}_f() RETURNS trigger AS $$ BEGIN DELETE FROM {tb} WHERE id = 20; UPDATE {tb} SET name = 'u' WHERE id = 17; RETURN NEW; END $$ LANGUAGE plpgsql"), None).await.unwrap();
    c.execute(
        &format!(
            "CREATE TRIGGER {tb}_t AFTER INSERT ON {tb} FOR EACH ROW EXECUTE FUNCTION {tb}_f()"
        ),
        None,
    )
    .await
    .unwrap();
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb} VALUES (1, 'new')"), None, 3)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    let recorded = ids(&cap);
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    assert!(
        !cap.capturable || recorded == vec![1],
        "取り違え: {recorded:?}"
    );
}

#[tokio::test]
async fn pg_upsert_is_not_recorded_as_a_new_row() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_ups";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a')"), None)
        .await
        .unwrap();
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb} VALUES (1,'b') ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name"), None, 100)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(!cap.capturable, "UPSERT は記録を辞退する");
    assert_eq!(
        count(&c, &format!("SELECT COUNT(*) FROM {tb} WHERE name = 'b'")).await,
        1
    );
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

/// 主キーをリテラルで指定した UPSERT (#1626): 新規行は Insert、更新された既存行は companion の Update。
#[tokio::test]
async fn pg_upsert_with_literal_keys_splits_new_and_updated_rows() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1626_pg_ups";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a')"), None)
        .await
        .unwrap();
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb} (id, name) VALUES (1,'b'), (2,'new') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name"), None, 100)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 2);
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(cap.kind, t::WriteKind::Insert);
    assert_eq!(ids(&cap), vec![2]);
    let companion = cap.companion.as_deref().expect("update companion");
    assert_eq!(companion.kind, t::WriteKind::Update);
    assert!(matches!(&companion.before_rows[0][1], t::Value::String(s) if s == "a"));
    assert!(matches!(&companion.after_rows[0][1], t::Value::String(s) if s == "b"));
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

/// WHERE を引き継げない UPDATE (PK を書き換える) が、無関係な行のロックを待たない。
#[tokio::test]
async fn pg_pk_changing_update_does_not_wait_on_unrelated_row_lock() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_lock";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    c.execute(
        &format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b'),(3,'c')"),
        None,
    )
    .await
    .unwrap();
    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id = 3 FOR UPDATE"))
        .await
        .unwrap();
    let captured = tokio::time::timeout(
        Duration::from_secs(5),
        c.capture_write(&format!("UPDATE {tb} SET id = 102 WHERE id = 2"), None, 100),
    )
    .await;
    c2.finish_transaction(false).await.unwrap();
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .ok();
    let (r, _) = captured.expect("無関係な行のロックで待たされた").unwrap();
    assert_eq!(r.rows_affected, 1);
}

/// タイムアウトで打ち切ると書き込みはロールバックされ、行ロックも残らない。
#[tokio::test]
async fn pg_capture_timeout_rolls_back_and_releases_locks() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_pg_to";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name TEXT)"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b')"), None)
        .await
        .unwrap();
    let state = t::AppState::default();
    let sid = state
        .insert(t::make_session("cap_pg", c, o.clone(), false))
        .await;

    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id = 1 FOR UPDATE"))
        .await
        .unwrap();
    let err = t::run_captured_write_with_timeout(
        &state,
        &sid,
        &format!("UPDATE {tb} SET name = 'x' WHERE id = 1"),
        100,
        1,
    )
    .await
    .expect_err("ロック待ちはタイムアウトする");
    assert!(matches!(err, t::AppError::Timeout(_)), "{err:?}");
    c2.finish_transaction(false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let check = connect(&o).await;
    assert_eq!(
        count(
            &check,
            &format!("SELECT COUNT(*) FROM {tb} WHERE name = 'x'")
        )
        .await,
        0,
        "書き込みは残らない"
    );
    check.begin_transaction(None).await.unwrap();
    check
        .execute_in_transaction("SET LOCAL lock_timeout = '2s'")
        .await
        .unwrap();
    check
        .execute_in_transaction(&format!("SELECT * FROM {tb} FOR UPDATE"))
        .await
        .expect("行ロックが残っていない");
    check.finish_transaction(false).await.unwrap();
    check
        .execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

// -------------------------------------------------------------------- MySQL

#[tokio::test]
async fn my_capture_runs_once_and_attributes_autoinc_insert() {
    let Some(o) = my_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_my_a";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}, {tb}_ins"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b')"), None)
        .await
        .unwrap();
    let (r, cap) = c
        .capture_write(
            &format!("UPDATE {tb} SET name = 'z' WHERE id = 1"),
            None,
            100,
        )
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(cap.capturable, "{:?}", cap.reason);

    let tb2 = format!("{tb}_ins");
    c.execute(&format!("CREATE TABLE {tb2} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"), None).await.unwrap();
    for i in 0..10 {
        c.execute(&format!("INSERT INTO {tb2} (name) VALUES ('s{i}')"), None)
            .await
            .unwrap();
    }
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb2} (name) VALUES ('new')"), None, 3)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(ids(&cap), vec![11], "LAST_INSERT_ID の行を直接引く");
    // 明示 PK の INSERT (採番なし): 窓の先頭に付く行は記録できる。
    let (_, cap) = c
        .capture_write(
            &format!("INSERT INTO {tb2} (id, name) VALUES (100, 'x')"),
            None,
            3,
        )
        .await
        .unwrap();
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(ids(&cap), vec![100]);
    // 窓の外 (小さい PK) の明示 INSERT は、既存行と区別できないので記録を辞退する (書き込みは実行される)。
    let (r, cap) = c
        .capture_write(
            &format!("INSERT INTO {tb2} (id, name) VALUES (-5, 'low')"),
            None,
            3,
        )
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(!cap.capturable || ids(&cap) == vec![-5], "{:?}", ids(&cap));

    // 失敗する文は何も残さず、行ロックも残さない。
    assert!(c
        .capture_write(&format!("UPDATE {tb} SET id = 2 WHERE id = 1"), None, 100)
        .await
        .is_err());
    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction("SET SESSION innodb_lock_wait_timeout = 2")
        .await
        .unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id IN (1,2) FOR UPDATE"))
        .await
        .expect("rows must not stay locked");
    c2.finish_transaction(false).await.unwrap();
    c.execute(&format!("DROP TABLE IF EXISTS {tb}, {tb2}"), None)
        .await
        .unwrap();
}

/// 主キーをリテラルで指定した UPSERT (#1626): MySQL は更新行を 2 と数えるが、記録は新規行と更新行に分かれる。
#[tokio::test]
async fn my_upsert_with_literal_keys_splits_new_and_updated_rows() {
    let Some(o) = my_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1626_my_ups";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name VARCHAR(20), UNIQUE KEY uq_name (name)) ENGINE=InnoDB"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a')"), None)
        .await
        .unwrap();
    let (r, cap) = c
        .capture_write(&format!("INSERT INTO {tb} (id, name) VALUES (1,'b'), (2,'new') ON DUPLICATE KEY UPDATE name = VALUES(name)"), None, 100)
        .await
        .unwrap();
    assert_eq!(r.rows_affected, 3, "新規 1 + 更新 2");
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(cap.kind, t::WriteKind::Insert);
    assert_eq!(ids(&cap), vec![2]);
    let companion = cap.companion.as_deref().expect("update companion");
    assert!(matches!(&companion.before_rows[0][1], t::Value::String(s) if s == "a"));
    assert!(matches!(&companion.after_rows[0][1], t::Value::String(s) if s == "b"));
    // 主キー以外の一意キー (name) で衝突して別の行が更新される形は記録を辞退する。
    let (r, cap) = c
        .capture_write(
            &format!(
                "INSERT INTO {tb} (id, name) VALUES (9,'b') ON DUPLICATE KEY UPDATE name = 'b2'"
            ),
            None,
            100,
        )
        .await
        .unwrap();
    assert!(r.rows_affected >= 1, "write must still apply");
    assert!(!cap.capturable);
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn my_pk_changing_update_does_not_wait_on_unrelated_row_lock() {
    let Some(o) = my_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_my_lock";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"),
        None,
    )
    .await
    .unwrap();
    c.execute(
        &format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b'),(3,'c')"),
        None,
    )
    .await
    .unwrap();
    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id = 3 FOR UPDATE"))
        .await
        .unwrap();
    let captured = tokio::time::timeout(
        Duration::from_secs(5),
        c.capture_write(&format!("UPDATE {tb} SET id = 102 WHERE id = 2"), None, 100),
    )
    .await;
    c2.finish_transaction(false).await.unwrap();
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .ok();
    let (r, _) = captured.expect("無関係な行のロックで待たされた").unwrap();
    assert_eq!(r.rows_affected, 1);
}

/// 他接続のロックを待ってから取得できた場合でも、記録つき書き込みは 1 回だけ実行される。
#[tokio::test]
async fn my_lock_wait_then_acquire_writes_once() {
    let Some(o) = my_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_my_conf";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}, {tb}_audit"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b')"), None)
        .await
        .unwrap();
    // 接続プールのどの接続でもロック待ちを 1 秒で切る。
    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id = 1 FOR SHARE"))
        .await
        .unwrap();
    // c2 が S ロックを持つ間、FOR UPDATE は待つ。待ち時間は短縮できないので、c2 を少し後に解放して
    // 「待って取れた」経路でも壊れないことを確認する (デッドロック / ロック待ちタイムアウトは
    // エラーとして返す。判定は is_deadlock / is_lock_wait_timeout の単体テスト)。
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(800)).await;
        c2.finish_transaction(false).await.unwrap();
    });
    let (r, cap) = c
        .capture_write(
            &format!("UPDATE {tb} SET name = 'z' WHERE id = 1"),
            None,
            100,
        )
        .await
        .unwrap();
    release.await.unwrap();
    assert_eq!(r.rows_affected, 1);
    assert!(cap.capturable, "{:?}", cap.reason);
    assert_eq!(
        count(&c, &format!("SELECT COUNT(*) FROM {tb} WHERE name = 'z'")).await,
        1
    );
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

#[tokio::test]
async fn my_capture_timeout_rolls_back_and_releases_locks() {
    let Some(o) = my_opts().await else { return };
    let c = connect(&o).await;
    let tb = "cap1536_my_to";
    c.execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
    c.execute(
        &format!("CREATE TABLE {tb} (id INT PRIMARY KEY, name VARCHAR(20)) ENGINE=InnoDB"),
        None,
    )
    .await
    .unwrap();
    c.execute(&format!("INSERT INTO {tb} VALUES (1,'a'),(2,'b')"), None)
        .await
        .unwrap();
    let state = t::AppState::default();
    let sid = state
        .insert(t::make_session("cap_my", c, o.clone(), false))
        .await;

    let c2 = connect(&o).await;
    c2.begin_transaction(None).await.unwrap();
    c2.execute_in_transaction(&format!("SELECT * FROM {tb} WHERE id = 1 FOR UPDATE"))
        .await
        .unwrap();
    let err = t::run_captured_write_with_timeout(
        &state,
        &sid,
        &format!("UPDATE {tb} SET name = 'x' WHERE id = 1"),
        100,
        1,
    )
    .await
    .expect_err("ロック待ちはタイムアウトする");
    assert!(matches!(err, t::AppError::Timeout(_)), "{err:?}");
    c2.finish_transaction(false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let check = connect(&o).await;
    assert_eq!(
        count(
            &check,
            &format!("SELECT COUNT(*) FROM {tb} WHERE name = 'x'")
        )
        .await,
        0,
        "書き込みは残らない"
    );
    check.begin_transaction(None).await.unwrap();
    check
        .execute_in_transaction("SET SESSION innodb_lock_wait_timeout = 2")
        .await
        .unwrap();
    check
        .execute_in_transaction(&format!("SELECT * FROM {tb} FOR UPDATE"))
        .await
        .expect("行ロックが残っていない");
    check.finish_transaction(false).await.unwrap();
    check
        .execute(&format!("DROP TABLE IF EXISTS {tb}"), None)
        .await
        .unwrap();
}

/// プール接続に残った search_path が、database 未指定の文へ漏れない (#1602)。
#[tokio::test]
async fn pg_search_path_does_not_leak_to_schema_less_statements() {
    let Some(o) = pg_opts().await else { return };
    let c = connect(&o).await;
    c.execute("DROP SCHEMA IF EXISTS sp1602 CASCADE", None)
        .await
        .unwrap();
    c.execute("CREATE SCHEMA sp1602", None).await.unwrap();
    for _ in 0..8 {
        c.execute("SELECT 1", Some("sp1602")).await.unwrap();
        let r = c
            .execute("SELECT current_schemas(false)::text", None)
            .await
            .unwrap();
        let shown = format!("{:?}", r.rows[0][0]);
        assert!(!shown.contains("sp1602"), "search_path leaked: {shown}");
    }
    c.execute("DROP SCHEMA IF EXISTS sp1602 CASCADE", None)
        .await
        .unwrap();
}
