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
                    pg_get_userbyid(c.relowner)::text, COALESCE((SELECT string_agg(x::text, ',' ORDER BY x::text) FROM unnest(c.relacl) x), ''), \
                    COALESCE(c.reloptions::text, ''), COALESCE(obj_description(c.oid, 'pg_class'), ''), \
                    COALESCE((SELECT string_agg(attname || '=' || col_description(c.oid, attnum), ',' ORDER BY attnum) \
                               FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 \
                                AND col_description(c.oid, attnum) IS NOT NULL), ''), \
                    COALESCE((SELECT string_agg(attname || ':' || attacl::text, ',' ORDER BY attnum) \
                               FROM pg_attribute WHERE attrelid = c.oid AND attnum > 0 AND attacl IS NOT NULL), ''), \
                    COALESCE((SELECT string_agg(attname || ':' || pg_get_expr(adbin, adrelid), ',' ORDER BY adnum) \
                               FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum \
                              WHERE d.adrelid = c.oid), ''), \
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
        format!("DROP SCHEMA IF EXISTS {PG_SCHEMA}_x CASCADE"),
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
        // v2 のオーナーが v1 を読めないと、オーナー権限の REFRESH (mv3) が元から通らない。
        format!("GRANT SELECT ON {PG_SCHEMA}.v1 TO nb2268_owner"),
        format!("GRANT SELECT, UPDATE ON {PG_SCHEMA}.v2 TO nb2268_reader WITH GRANT OPTION"),
        format!("GRANT SELECT ON {PG_SCHEMA}.mv3 TO PUBLIC"),
        format!("COMMENT ON VIEW {PG_SCHEMA}.v1 IS 'it''s v1'"),
        format!("COMMENT ON COLUMN {PG_SCHEMA}.v2.dbl IS 'double price'"),
        format!("COMMENT ON MATERIALIZED VIEW {PG_SCHEMA}.mv3 IS 'matview'"),
        format!("GRANT SELECT (id) ON {PG_SCHEMA}.v1 TO nb2268_reader"),
        format!("ALTER VIEW {PG_SCHEMA}.v1 ALTER COLUMN id SET DEFAULT 7"),
        // スキーマをまたぐビュー: 同名の表が自スキーマにもあり、search_path 次第で修飾が省かれる形。
        format!("CREATE SCHEMA {PG_SCHEMA}_x"),
        format!("CREATE TABLE {PG_SCHEMA}_x.base (id int, price int)"),
        format!("CREATE VIEW {PG_SCHEMA}_x.xv AS SELECT b.id, b.price FROM {PG_SCHEMA}.base b JOIN {PG_SCHEMA}_x.base x ON x.id = b.id"),
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
    assert_eq!(names.len(), 4);
    let pos = |n: &str| names.iter().position(|x| *x == n);
    assert!(pos("v1") < pos("v2") && pos("v2") < pos("mv3"));
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
    assert!(none.referenced_columns.contains(&"note".to_string()));
    let nothing = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &[], true)
        .await
        .expect("plan");
    assert!(nothing.views.is_empty() && nothing.drop_statements.is_empty());

    // スキーマをまたぐビューも対象で、定義は常に完全修飾で取れている。
    let xv = plan
        .views
        .iter()
        .find(|v| v.name == "xv")
        .map(|v| v.schema.clone());
    assert_eq!(xv.as_deref(), Some("nb2268_rebuild_x"));
    assert!(
        plan.create_statements
            .iter()
            .any(|c| c.contains("nb2268_rebuild.base") && c.contains("nb2268_rebuild_x.base")),
        "{:?}",
        plan.create_statements
    );
    let before = snapshot(conn, PG_SCHEMA).await;
    let before_x = snapshot(conn, "nb2268_rebuild_x").await;
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
    assert_eq!(snapshot(conn, "nb2268_rebuild_x").await, before_x);
    let ty = rows(
        conn,
        &format!(
            "SELECT format_type(atttypid, atttypmod) FROM pg_attribute \
             WHERE attrelid = '{PG_SCHEMA}.base'::regclass AND attname = 'price'"
        ),
    )
    .await;
    assert!(format!("{ty:?}").contains("bigint"), "{ty:?}");
    // マテビューは作成後に REFRESH で再計算済み。
    let n = rows(conn, &format!("SELECT count(*) FROM {PG_SCHEMA}.mv3")).await;
    assert!(format!("{n:?}").contains('2'), "{n:?}");

    // 再計算を選ばないと REFRESH は出ず、マテビューは未投入のまま作られる。
    let plan_nd = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "base", &cols, false)
        .await
        .expect("plan");
    assert!(plan_nd
        .create_statements
        .iter()
        .any(|c| c.ends_with("WITH NO DATA;")));
    assert!(!plan_nd
        .restore_statements
        .iter()
        .any(|x| x.starts_with("REFRESH")));
    assert!(plan
        .restore_statements
        .iter()
        .any(|x| x.starts_with("REFRESH MATERIALIZED VIEW")));

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

    // FK で参照され CHECK も付いた列でも、依存ビューが無ければ止める依存を返さない (ALTER が自分で作り直す)。
    for sql in [
        format!("DROP SCHEMA {PG_SCHEMA} CASCADE"),
        format!("CREATE SCHEMA {PG_SCHEMA}"),
        format!("CREATE TABLE {PG_SCHEMA}.p (id int PRIMARY KEY, v int CHECK (v > 0))"),
        format!("CREATE TABLE {PG_SCHEMA}.c (id int, pid int REFERENCES {PG_SCHEMA}.p(id))"),
        format!("CREATE INDEX p_v ON {PG_SCHEMA}.p (v)"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    for col in ["id", "v"] {
        let p =
            t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "p", &[col.to_string()], true)
                .await
                .expect("plan");
        assert!(
            p.views.is_empty() && p.blockers.is_empty(),
            "{col}: {:?}",
            p.blockers
        );
    }
    // 依存ビューがあっても、FK / CHECK / インデックスは blocker にならない。
    conn.execute(
        &format!("CREATE VIEW {PG_SCHEMA}.pv AS SELECT id, v FROM {PG_SCHEMA}.p"),
        None,
    )
    .await
    .expect("ddl");
    let p = t::view_rebuild_plan_core(session.clone(), PG_SCHEMA, "p", &["id".to_string()], true)
        .await
        .expect("plan");
    assert_eq!(p.views.len(), 1);
    assert!(p.blockers.is_empty(), "{:?}", p.blockers);
    assert_eq!(
        p.referenced_columns,
        vec!["id".to_string(), "v".to_string()]
    );

    conn.execute(&format!("DROP SCHEMA {PG_SCHEMA} CASCADE"), None)
        .await
        .expect("cleanup");
    conn.execute(&format!("DROP SCHEMA {PG_SCHEMA}_x CASCADE"), None)
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

/// 管理者が別ロール所有のマテビューを作り直しても、中身は管理者の権限で計算されない (REFRESH はオーナーの権限)。
/// RLS で元のオーナーには見えない行が、管理者の権限で作られたマテビューに永続化されないことを確かめる。
#[tokio::test]
async fn postgres_rebuild_does_not_materialize_rows_hidden_from_owner() {
    let Some(url) = common::require_env("NOOBDB_TEST_POSTGRES_URL") else {
        return;
    };
    let opts = t::parse_postgres_url(&url).expect("valid url");
    let conn = t::connect(&opts).await.expect("connect");
    let schema = "nb2268_rls";
    for sql in [
        format!("DROP SCHEMA IF EXISTS {schema} CASCADE"),
        "DROP ROLE IF EXISTS nb2268_adm".to_string(),
        "DROP ROLE IF EXISTS nb2268_own".to_string(),
        "CREATE ROLE nb2268_own".to_string(),
        "CREATE ROLE nb2268_adm".to_string(),
        "GRANT nb2268_own TO nb2268_adm".to_string(),
        format!("CREATE SCHEMA {schema}"),
        format!("GRANT ALL ON SCHEMA {schema} TO nb2268_own, nb2268_adm"),
        format!("CREATE TABLE {schema}.t (id int, v int)"),
        format!("INSERT INTO {schema}.t VALUES (1, 10), (2, 20)"),
        format!("GRANT ALL ON {schema}.t TO nb2268_adm"),
        format!("ALTER TABLE {schema}.t OWNER TO nb2268_own"),
        format!("ALTER TABLE {schema}.t ENABLE ROW LEVEL SECURITY"),
        format!("ALTER TABLE {schema}.t FORCE ROW LEVEL SECURITY"),
        // 元のオーナーには 1 行も見えず、管理者にだけ見える。
        format!("CREATE POLICY p ON {schema}.t USING (current_user <> 'nb2268_own')"),
        format!("CREATE MATERIALIZED VIEW {schema}.mv AS SELECT id, v FROM {schema}.t"),
        format!("ALTER MATERIALIZED VIEW {schema}.mv OWNER TO nb2268_own"),
    ] {
        conn.execute(&sql, None).await.expect("ddl");
    }
    let session = session_for("viewrebuild_rls", conn, opts).await;
    let conn = &session.conn;
    let plan = t::view_rebuild_plan_core(session.clone(), schema, "t", &["v".to_string()], true)
        .await
        .expect("plan");
    assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
    assert_eq!(plan.views.len(), 1);
    // 管理者 (スーパーユーザーではない) として流す。
    let mut all = vec!["SET LOCAL ROLE nb2268_adm;".to_string()];
    all.extend(plan.drop_statements.clone());
    all.push(format!(
        "ALTER TABLE {schema}.t ALTER COLUMN v TYPE bigint;"
    ));
    all.extend(plan.create_statements.clone());
    all.extend(plan.restore_statements.clone());
    conn.execute_transaction(&all, Some(schema))
        .await
        .expect("rebuild transaction");
    let n = rows(conn, &format!("SELECT count(*) FROM {schema}.mv")).await;
    assert!(
        format!("{n:?}").contains('0'),
        "owner に見えない行が入った: {n:?}"
    );
    let owner = rows(
        conn,
        &format!("SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE oid = '{schema}.mv'::regclass"),
    )
    .await;
    assert!(format!("{owner:?}").contains("nb2268_own"), "{owner:?}");

    conn.execute(&format!("DROP SCHEMA {schema} CASCADE"), None)
        .await
        .expect("cleanup");
    for r in ["nb2268_adm", "nb2268_own"] {
        conn.execute(&format!("DROP ROLE {r}"), None)
            .await
            .expect("drop role");
    }
}
