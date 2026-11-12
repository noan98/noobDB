//! 列の型変更で依存ビューを作り直す手順 (#2268) の統合テスト。
//!
//! `NOOBDB_TEST_POSTGRES_URL` があるときだけ実行し、専用スキーマ `nb2268_*` に閉じる。
//! ビュー → ビュー → マテリアライズドビューの 3 段に依存される列の型を、計画どおりの
//! DROP → ALTER → CREATE → 復元で 1 トランザクションに流して、定義・オーナー・権限・コメント・
//! マテビューのインデックスが元と一致することを確かめる。

use super::common; // 共有ヘルパは groups/*.rs が 1 度だけ取り込む
use std::sync::Arc;

use noobdb_lib::__test_api as t;

async fn session_for(tag: &str, conn: t::Connection, opts: t::DbConnectOptions) -> Arc<t::Session> {
    let state = t::AppState::default();
    let id = state.insert(t::make_session(tag, conn, opts, false)).await;
    state.get(&id).await.expect("session exists")
}

async fn rows(conn: &t::Connection, sql: &str) -> Vec<Vec<String>> {
    let r = conn.execute(sql, None).await.expect("query");
    r.rows
        .iter()
        .map(|row| row.iter().map(|v| format!("{v:?}")).collect())
        .collect()
}

/// 元と作り直し後を比べるための「ビューの姿」(定義 / オーナー / 権限 / オプション / コメント / インデックス)。
async fn snapshot(conn: &t::Connection, schema: &str) -> Vec<Vec<String>> {
    rows(
        conn,
        &format!(
            "SELECT c.relname::text, c.relkind::text, \
                    regexp_replace(pg_get_viewdef(c.oid, true), '\\s+', ' ', 'g'), \
                    pg_get_userbyid(c.relowner)::text, COALESCE(c.relacl::text, ''), \
                    COALESCE(c.reloptions::text, ''), COALESCE(obj_description(c.oid, 'pg_class'), ''), \
                    COALESCE((SELECT string_agg(attname || '=' || col_description(c.oid, attnum), ',' ORDER BY attnum) \
                               FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 \
                                AND col_description(c.oid, attnum) IS NOT NULL), ''), \
                    COALESCE((SELECT string_agg(regexp_replace(pg_get_indexdef(indexrelid), '^.* ON ', ''), ';' ORDER BY indexrelid) \
                               FROM pg_index WHERE indrelid = c.oid), '') \
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE n.nspname = '{schema}' AND c.relkind IN ('v', 'm') ORDER BY 1"
        ),
    )
    .await
}

const PG_SCHEMA: &str = "nb2268_rebuild";

#[tokio::test]
async fn postgres_rebuilds_three_level_dependents_in_one_transaction() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    for sql in [
        format!("DROP SCHEMA IF EXISTS {PG_SCHEMA} CASCADE"),
        "DROP ROLE IF EXISTS nb2268_reader".to_string(),
        "DROP ROLE IF EXISTS nb2268_owner".to_string(),
        "CREATE ROLE nb2268_reader".to_string(),
        "CREATE ROLE nb2268_owner".to_string(),
        format!("CREATE SCHEMA {PG_SCHEMA}"),
        format!(
            "CREATE TABLE {PG_SCHEMA}.base (id int PRIMARY KEY, price int NOT NULL, note text)"
        ),
        format!(
            "CREATE VIEW {PG_SCHEMA}.v1 WITH (security_barrier=true) AS \
             SELECT id, price FROM {PG_SCHEMA}.base WHERE price > 0 WITH CASCADED CHECK OPTION"
        ),
        format!("CREATE VIEW {PG_SCHEMA}.v2 AS SELECT id, price * 2 AS dbl FROM {PG_SCHEMA}.v1"),
        format!("CREATE MATERIALIZED VIEW {PG_SCHEMA}.mv3 AS SELECT id, dbl FROM {PG_SCHEMA}.v2"),
        format!("CREATE UNIQUE INDEX mv3_id ON {PG_SCHEMA}.mv3 (id)"),
        // 型変更に関係しない列だけを使うビュー (作り直し対象に入らない)。
        format!("CREATE VIEW {PG_SCHEMA}.unrelated AS SELECT id, note FROM {PG_SCHEMA}.base"),
        format!("ALTER VIEW {PG_SCHEMA}.v2 OWNER TO nb2268_owner"),
        format!("GRANT SELECT ON {PG_SCHEMA}.v1 TO nb2268_reader"),
        format!("GRANT SELECT, UPDATE ON {PG_SCHEMA}.v2 TO nb2268_reader WITH GRANT OPTION"),
        format!("GRANT SELECT ON {PG_SCHEMA}.mv3 TO PUBLIC"),
        format!("COMMENT ON VIEW {PG_SCHEMA}.v1 IS 'it''s v1'"),
        format!("COMMENT ON COLUMN {PG_SCHEMA}.v2.dbl IS 'double price'"),
        format!("COMMENT ON MATERIALIZED VIEW {PG_SCHEMA}.mv3 IS 'matview'"),
        format!("INSERT INTO {PG_SCHEMA}.base VALUES (1, 10, 'a'), (2, 20, 'b')"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    let session = session_for("viewrebuild_pg", conn, opts).await;
    let conn = &session.conn;

    // 計画: 3 段の依存だけが対象、作成順は v1 → v2 → mv3。
    let cols = vec!["price".to_string()];
    let plan = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &cols, true)
        .await
        .expect("plan");
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    let names: Vec<&str> = plan.views.iter().map(|v| v.name.as_str()).collect();
    assert_eq!(names, vec!["v1", "v2", "mv3"]);
    // 依存の無い列では空 (従来どおり)。
    let none = t::view_rebuild_plan_core(
        session.clone(),
        PG_SCHEMA,
        "base",
        &["note".to_string()],
        true,
    )
    .await
    .expect("plan");
    assert_eq!(none.views.len(), 1);
    let nothing = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &[], true)
        .await
        .expect("plan");
    assert!(nothing.views.is_empty() && nothing.drop_statements.is_empty());

    let before = snapshot(conn, PG_SCHEMA).await;
    let alter = format!("ALTER TABLE {PG_SCHEMA}.base ALTER COLUMN price TYPE bigint;");

    // 計画なしの ALTER は失敗する (これが Issue の症状)。
    assert!(conn
        .execute_transaction(std::slice::from_ref(&alter), Some(PG_SCHEMA))
        .await
        .is_err());

    // 途中で失敗する (CREATE の後に壊れた文を入れる) と全体が戻り、ビューが消えたままにならない。
    let mut broken: Vec<String> = Vec::new();
    broken.extend(plan.drop_statements.clone());
    broken.push(alter.clone());
    broken.extend(plan.create_statements.clone());
    broken.push("SELECT * FROM nb2268_no_such_table;".to_string());
    assert!(conn
        .execute_transaction(&broken, Some(PG_SCHEMA))
        .await
        .is_err());
    assert_eq!(snapshot(conn, PG_SCHEMA).await, before);

    // 成功する手順: DROP → ALTER → CREATE → 復元。
    let mut all: Vec<String> = Vec::new();
    all.extend(plan.drop_statements.clone());
    all.push(alter);
    all.extend(plan.create_statements.clone());
    all.extend(plan.restore_statements.clone());
    conn.execute_transaction(&all, Some(PG_SCHEMA))
        .await
        .expect("rebuild transaction");
    assert_eq!(snapshot(conn, PG_SCHEMA).await, before);
    let ty = rows(
        conn,
        &format!(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute \
             WHERE attrelid = '{PG_SCHEMA}.base'::regclass AND attname = 'price'"
        ),
    )
    .await;
    assert!(format!("{ty:?}").contains("bigint"), "{ty:?}");
    // マテビューは WITH DATA で再計算済み。
    let n = rows(conn, &format!("SELECT count(*) FROM {PG_SCHEMA}.mv3")).await;
    assert!(format!("{n:?}").contains('2'), "{n:?}");

    // WITH NO DATA を選ぶとマテビューは未投入で作られる。
    let plan_nd = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &cols, false)
        .await
        .expect("plan");
    assert!(plan_nd.create_statements[2].ends_with("WITH NO DATA;"));

    // RLS ポリシーが参照する列は作り直しを止める。
    for sql in [
        format!("ALTER TABLE {PG_SCHEMA}.base ENABLE ROW LEVEL SECURITY"),
        format!("CREATE POLICY nb2268_p ON {PG_SCHEMA}.base USING (price > 0)"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    let blocked = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &cols, true)
        .await
        .expect("plan");
    assert!(
        blocked.blockers.iter().any(|b| b.kind == "policy"),
        "{:?}",
        blocked.blockers
    );

    conn.execute(&format!("DROP SCHEMA {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("cleanup");
    for r in ["nb2268_reader", "nb2268_owner"] {
        conn.execute(&format!("DROP ROLE {r}"), None)
            .await
            .expect("drop role");
    }
}

#[tokio::test]
async fn sqlite_and_empty_inputs_need_no_view_rebuild() {
    let mut path = std::env::temp_dir();
    path.push(format!("noobdb_viewrebuild_{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    std::fs::File::create(&path).expect("create temp sqlite file");
    let opts = t::sqlite_options(path.to_str().expect("utf8 path"));
    let conn = t::connect(&opts).await.expect("connect sqlite");
    for ddl in [
        "CREATE TABLE nb2268_t (id INTEGER PRIMARY KEY, price INTEGER)",
        "CREATE VIEW nb2268_v AS SELECT id, price FROM nb2268_t",
    ] {
        conn.execute(ddl, None).await.expect("ddl");
    }
    let session = session_for("viewrebuild_sqlite", conn, opts).await;
    let plan = t::view_rebuild_plan_core(session, "main", "nb2268_t", &["price".to_string()], true)
        .await
        .expect("plan");
    assert!(plan.views.is_empty() && plan.create_statements.is_empty() && plan.blockers.is_empty());
    let _ = std::fs::remove_file(&path);
}
