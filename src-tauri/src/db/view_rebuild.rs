//! PostgreSQL: 列の型変更で依存ビューを作り直す手順の生成 (#2268, 親 Epic #2261)。
//!
//! `ALTER COLUMN ... TYPE` は、ビュー / マテリアライズドビューが参照する列に対しては
//! `cannot alter type of a column used by a view or rule` で失敗する。回避には「依存ビューを
//! 依存の逆順に DROP → ALTER → 依存の順に CREATE → GRANT / COMMENT / OWNER / インデックス /
//! トリガーを復元」の手順が要る。ここはその SQL 組み立てだけを担う純ロジック (DB には触れない)。
//! 依存ビューの列挙と属性の取得は `postgres.rs::dependent_views`、トランザクション内での実行は
//! フロントが ALTER 文と一緒に既存の `run_query_transaction` へ流す (途中失敗で全体が戻る)。

use std::collections::BTreeMap;

use serde::Serialize;

/// 対象ビューの種別。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ViewKind {
    View,
    MaterializedView,
}

impl ViewKind {
    fn keyword(self) -> &'static str {
        match self {
            ViewKind::View => "VIEW",
            ViewKind::MaterializedView => "MATERIALIZED VIEW",
        }
    }
}

/// `relacl` の 1 権限分 (`aclexplode` の 1 行)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AclEntry {
    /// 付与先のロール名。`PUBLIC` は空文字。
    pub grantee: String,
    /// `SELECT` / `INSERT` / `UPDATE` / `DELETE` / `TRUNCATE` / `REFERENCES` / `TRIGGER` / `MAINTAIN`。
    pub privilege: String,
    pub grantable: bool,
}

/// 作り直す対象ビュー 1 件分の、復元に要る属性。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ViewInfo {
    /// `pg_class.oid` (依存関係の突き合わせ用の識別子)。
    pub oid: i64,
    pub schema: String,
    pub name: String,
    pub kind: ViewKind,
    /// `pg_get_viewdef(oid, true)` (末尾の `;` は付いていてもよい)。
    pub definition: String,
    /// `reloptions` (`security_barrier=true` / `check_option=cascaded` など)。
    pub options: Vec<String>,
    pub owner: String,
    /// `relacl` を展開したもの (オーナー自身の権限は含めない)。
    pub acl: Vec<AclEntry>,
    /// `relacl` が NULL でないか。NULL (既定の権限) なら GRANT を出さない。
    pub has_acl: bool,
    pub comment: Option<String>,
    /// 列コメント (列名, コメント)。
    pub column_comments: Vec<(String, String)>,
    /// 列単位の権限 (`pg_attribute.attacl`)。(列名, 権限)。オーナー自身は含めない。
    pub column_acl: Vec<(String, AclEntry)>,
    /// ビューの列の DEFAULT (`pg_attrdef`)。(列名, `pg_get_expr` の式)。
    pub column_defaults: Vec<(String, String)>,
    /// `pg_get_indexdef` (マテリアライズドビューのインデックス)。
    pub indexes: Vec<String>,
    /// `pg_get_triggerdef` (INSTEAD OF トリガーなど。内部トリガーは含めない)。
    pub triggers: Vec<String>,
    /// このビューが直接参照している、作り直す対象内の別ビューの oid。
    pub depends_on: Vec<i64>,
    /// マテリアライズドビューがデータを持っているか。
    pub populated: bool,
    /// 概算サイズ (バイト) / 行数。マテリアライズドビューの再計算警告に使う。
    pub size_bytes: Option<i64>,
    pub est_rows: Option<i64>,
}

/// 依存ビューの作り直しを止める依存 (RLS ポリシー・ビュー以外のルール・関数など)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RebuildBlocker {
    /// `"policy"` / `"rule"` / `"other"`。
    pub kind: String,
    /// `pg_describe_object` の説明 (例: `policy p on table t`)。
    pub description: String,
}

/// 依存の調査結果。`blockers` が空でなければ作り直さず理由を出して止める。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DependentViews {
    pub views: Vec<ViewInfo>,
    pub blockers: Vec<RebuildBlocker>,
    /// 作り直すビューが直接参照している、元テーブルの列名。同じ ALTER でのリネーム / 削除との衝突判定用。
    pub referenced_columns: Vec<String>,
}

/// 組み立てた手順。`drop` → (ALTER) → `create` → `restore` の順に流す。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RebuildSql {
    pub drop: Vec<String>,
    pub create: Vec<String>,
    pub restore: Vec<String>,
}

fn q(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn qs(s: &str) -> String {
    // PostgreSQL の標準文字列リテラルではバックスラッシュは普通の文字。引用符だけ二重化する。
    format!("'{}'", s.replace('\'', "''"))
}

/// `"schema"."name"`。
pub fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", q(schema), q(name))
}

/// 依存ビューを「依存される側が先」の順 (作成順) に並べた添字を返す。
/// 同じ段のものは (schema, name) の昇順で安定させる。循環 (PostgreSQL では起きない) は `Err`。
pub fn creation_order(views: &[ViewInfo]) -> Result<Vec<usize>, String> {
    let by_oid: BTreeMap<i64, usize> = views.iter().enumerate().map(|(i, v)| (v.oid, i)).collect();
    // 入次数 = 集合内の依存先の数 (自分自身・集合外・重複は数えない)。
    let deps: Vec<Vec<usize>> = views
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let mut d: Vec<usize> = v
                .depends_on
                .iter()
                .filter_map(|o| by_oid.get(o).copied())
                .filter(|&j| j != i)
                .collect();
            d.sort_unstable();
            d.dedup();
            d
        })
        .collect();
    let mut remaining: Vec<usize> = (0..views.len()).collect();
    let mut done = vec![false; views.len()];
    let mut order = Vec::with_capacity(views.len());
    while !remaining.is_empty() {
        let mut ready: Vec<usize> = remaining
            .iter()
            .copied()
            .filter(|&i| deps[i].iter().all(|&j| done[j]))
            .collect();
        if ready.is_empty() {
            return Err("ビューの依存関係に循環があり、作り直す順序を決められません".to_string());
        }
        ready.sort_by(|&a, &b| {
            (&views[a].schema, &views[a].name).cmp(&(&views[b].schema, &views[b].name))
        });
        // 1 段ずつ確定する (同じ段の中は名前順)。
        for &i in &ready {
            done[i] = true;
            order.push(i);
        }
        remaining.retain(|i| !done[*i]);
    }
    Ok(order)
}

fn create_statement(v: &ViewInfo) -> String {
    let body = v
        .definition
        .trim()
        .trim_end_matches(';')
        .trim_end()
        .to_string();
    let target = qualified(&v.schema, &v.name);
    let options = if v.options.is_empty() {
        String::new()
    } else {
        format!(" WITH ({})", v.options.join(", "))
    };
    match v.kind {
        ViewKind::View => format!("CREATE VIEW {target}{options} AS\n{body};"),
        ViewKind::MaterializedView => {
            // 常に `WITH NO DATA` で作る。`WITH DATA` だと CREATE を流した接続ユーザーの権限で中身が
            // 計算され (RLS で元のオーナーに見えない行も入る)、後から OWNER を戻しても行は直らない。
            // 再計算が要るものは、OWNER / 権限を復元した後に `REFRESH` する (`build_rebuild_sql`)。
            let data = "WITH NO DATA";
            format!("CREATE MATERIALIZED VIEW {target}{options} AS\n{body}\n{data};")
        }
    }
}

fn restore_statements(v: &ViewInfo) -> Vec<String> {
    let target = qualified(&v.schema, &v.name);
    let kw = v.kind.keyword();
    let mut out = Vec::new();
    if !v.owner.is_empty() {
        out.push(format!("ALTER {kw} {target} OWNER TO {};", q(&v.owner)));
    }
    if v.has_acl {
        // 既定の権限 (ALTER DEFAULT PRIVILEGES) が付いていても元と同じ集合に戻すため、
        // 一度 PUBLIC を外してから元の GRANT を並べる。
        out.push(format!("REVOKE ALL ON {target} FROM PUBLIC;"));
        // 同じ付与先の権限は 1 文にまとめる (WITH GRANT OPTION の有無で別文)。
        let mut groups: BTreeMap<(String, bool), Vec<&str>> = BTreeMap::new();
        for a in &v.acl {
            groups
                .entry((a.grantee.clone(), a.grantable))
                .or_default()
                .push(a.privilege.as_str());
        }
        for ((grantee, grantable), mut privs) in groups {
            privs.sort_unstable();
            privs.dedup();
            let who = if grantee.is_empty() {
                "PUBLIC".to_string()
            } else {
                q(&grantee)
            };
            let opt = if grantable { " WITH GRANT OPTION" } else { "" };
            out.push(format!(
                "GRANT {} ON {target} TO {who}{opt};",
                privs.join(", ")
            ));
        }
    }
    // 列単位の権限 (同じ (列, 付与先, GRANT OPTION) は 1 文にまとめる)。
    let mut col_groups: BTreeMap<(String, String, bool), Vec<&str>> = BTreeMap::new();
    for (col, a) in &v.column_acl {
        col_groups
            .entry((col.clone(), a.grantee.clone(), a.grantable))
            .or_default()
            .push(a.privilege.as_str());
    }
    for ((col, grantee, grantable), mut privs) in col_groups {
        privs.sort_unstable();
        privs.dedup();
        let who = if grantee.is_empty() {
            "PUBLIC".to_string()
        } else {
            q(&grantee)
        };
        let opt = if grantable { " WITH GRANT OPTION" } else { "" };
        let list = privs
            .iter()
            .map(|p| format!("{p} ({})", q(&col)))
            .collect::<Vec<_>>()
            .join(", ");
        out.push(format!("GRANT {list} ON {target} TO {who}{opt};"));
    }
    if let Some(c) = &v.comment {
        out.push(format!("COMMENT ON {kw} {target} IS {};", qs(c)));
    }
    for (col, c) in &v.column_comments {
        out.push(format!(
            "COMMENT ON COLUMN {target}.{} IS {};",
            q(col),
            qs(c)
        ));
    }
    if v.kind == ViewKind::View {
        for (col, expr) in &v.column_defaults {
            out.push(format!(
                "ALTER VIEW {target} ALTER COLUMN {} SET DEFAULT {expr};",
                q(col)
            ));
        }
    }
    for idx in &v.indexes {
        out.push(format!("{};", idx.trim().trim_end_matches(';')));
    }
    for trg in &v.triggers {
        out.push(format!("{};", trg.trim().trim_end_matches(';')));
    }
    out
}

/// 依存ビューを作り直す SQL を組み立てる。
///
/// - `drop`: 依存の逆順 (依存する側が先) に `DROP`。CASCADE は使わない (想定外の巻き添えを出さない)。
/// - `create`: 依存の順に `CREATE`。マテリアライズドビューは常に `WITH NO DATA`
///   (作成者の権限で中身を計算しない)。
/// - `restore`: 作成順に オーナー / 権限 / コメント / インデックス / トリガーを復元し、最後に
///   `with_data` かつ元が投入済みのマテビューだけを依存順に `REFRESH MATERIALIZED VIEW`。
///
/// 依存が無い (`views` が空) ときはすべて空。
pub fn build_rebuild_sql(views: &[ViewInfo], with_data: bool) -> Result<RebuildSql, String> {
    let order = creation_order(views)?;
    let mut out = RebuildSql::default();
    for &i in order.iter().rev() {
        let v = &views[i];
        out.drop.push(format!(
            "DROP {} {};",
            v.kind.keyword(),
            qualified(&v.schema, &v.name)
        ));
    }
    for &i in &order {
        let v = &views[i];
        out.create.push(create_statement(v));
        out.restore.extend(restore_statements(v));
    }
    // 全ビューのオーナー・権限を戻した後に、元が投入済みで再計算を選んだマテビューだけを依存順に REFRESH する
    // (REFRESH はマテビューのオーナーの権限で実行される)。
    if with_data {
        for &i in &order {
            let v = &views[i];
            if v.kind == ViewKind::MaterializedView && v.populated {
                out.restore.push(format!(
                    "REFRESH MATERIALIZED VIEW {};",
                    qualified(&v.schema, &v.name)
                ));
            }
        }
    }
    Ok(out)
}

/// 計画に載せる 1 ビューの要約 (作成順)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RebuildViewSummary {
    pub schema: String,
    pub name: String,
    pub kind: ViewKind,
    pub size_bytes: Option<i64>,
    pub est_rows: Option<i64>,
}

/// `view_rebuild_plan` の結果 (IPC)。`blockers` が空でなければ作り直さず、理由を見せて止める。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
pub struct ViewRebuildPlan {
    /// 作り直す対象 (作成順 = 依存される側が先)。
    pub views: Vec<RebuildViewSummary>,
    /// ALTER の前に流す DROP (依存の逆順)。
    pub drop_statements: Vec<String>,
    /// ALTER の後に流す CREATE (依存の順)。
    pub create_statements: Vec<String>,
    /// CREATE の後に流す オーナー / 権限 / コメント / インデックス / トリガーの復元。
    pub restore_statements: Vec<String>,
    pub blockers: Vec<RebuildBlocker>,
    /// 作り直すビューが直接参照している元テーブルの列名。
    pub referenced_columns: Vec<String>,
}

/// 調査結果から IPC 用の計画を作る。
pub fn build_plan(found: &DependentViews, with_data: bool) -> Result<ViewRebuildPlan, String> {
    let order = creation_order(&found.views)?;
    let sql = build_rebuild_sql(&found.views, with_data)?;
    Ok(ViewRebuildPlan {
        views: order
            .iter()
            .map(|&i| {
                let v = &found.views[i];
                RebuildViewSummary {
                    schema: v.schema.clone(),
                    name: v.name.clone(),
                    kind: v.kind,
                    size_bytes: v.size_bytes,
                    est_rows: v.est_rows,
                }
            })
            .collect(),
        drop_statements: sql.drop,
        create_statements: sql.create,
        restore_statements: sql.restore,
        blockers: found.blockers.clone(),
        referenced_columns: found.referenced_columns.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(oid: i64, schema: &str, name: &str, kind: ViewKind, deps: &[i64]) -> ViewInfo {
        ViewInfo {
            oid,
            schema: schema.into(),
            name: name.into(),
            kind,
            definition: " SELECT id FROM t;".into(),
            options: vec![],
            owner: "app".into(),
            acl: vec![],
            has_acl: false,
            comment: None,
            column_comments: vec![],
            column_acl: vec![],
            column_defaults: vec![],
            indexes: vec![],
            triggers: vec![],
            depends_on: deps.to_vec(),
            populated: true,
            size_bytes: None,
            est_rows: None,
        }
    }

    fn names(views: &[ViewInfo], order: &[usize]) -> Vec<String> {
        order.iter().map(|&i| views[i].name.clone()).collect()
    }

    #[test]
    fn build_plan_lists_views_in_creation_order_and_carries_blockers() {
        let found = DependentViews {
            views: vec![
                view(2, "s", "top", ViewKind::MaterializedView, &[1]),
                view(1, "s", "base", ViewKind::View, &[]),
            ],
            blockers: vec![RebuildBlocker {
                kind: "policy".into(),
                description: "policy p on table t".into(),
            }],
            referenced_columns: vec!["price".into()],
        };
        let plan = build_plan(&found, false).unwrap();
        let order: Vec<&str> = plan.views.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(order, vec!["base", "top"]);
        assert_eq!(plan.drop_statements.len(), 2);
        assert!(plan.create_statements[1].ends_with("WITH NO DATA;"));
        assert!(!plan
            .restore_statements
            .iter()
            .any(|x| x.starts_with("REFRESH")));
        assert_eq!(plan.blockers.len(), 1);
        assert_eq!(plan.referenced_columns, vec!["price".to_string()]);
        assert_eq!(
            build_plan(&DependentViews::default(), true).unwrap(),
            ViewRebuildPlan::default()
        );
    }

    #[test]
    fn empty_input_yields_empty_plan() {
        let s = build_rebuild_sql(&[], true).unwrap();
        assert_eq!(s, RebuildSql::default());
        assert_eq!(creation_order(&[]).unwrap(), Vec::<usize>::new());
    }

    #[test]
    fn three_level_chain_is_ordered_regardless_of_input_order() {
        // v1 (view) <- v2 (view) <- mv3 (matview)。入力順を逆にしても作成順は v1, v2, mv3。
        let v1 = view(1, "public", "v1", ViewKind::View, &[]);
        let v2 = view(2, "public", "v2", ViewKind::View, &[1]);
        let mv3 = view(3, "public", "mv3", ViewKind::MaterializedView, &[2]);
        let views = vec![mv3, v1, v2];
        let order = creation_order(&views).unwrap();
        assert_eq!(names(&views, &order), vec!["v1", "v2", "mv3"]);
        let s = build_rebuild_sql(&views, true).unwrap();
        assert_eq!(
            s.drop,
            vec![
                "DROP MATERIALIZED VIEW \"public\".\"mv3\";",
                "DROP VIEW \"public\".\"v2\";",
                "DROP VIEW \"public\".\"v1\";",
            ]
        );
        assert!(s.create[0].starts_with("CREATE VIEW \"public\".\"v1\" AS"));
        assert!(s.create[2].starts_with("CREATE MATERIALIZED VIEW \"public\".\"mv3\" AS"));
    }

    #[test]
    fn diamond_dependencies_put_shared_base_first() {
        let a = view(1, "s", "a", ViewKind::View, &[]);
        let b = view(2, "s", "b", ViewKind::View, &[1]);
        let c = view(3, "s", "c", ViewKind::View, &[1]);
        let d = view(4, "s", "d", ViewKind::View, &[2, 3]);
        let views = vec![d, c, b, a];
        let order = creation_order(&views).unwrap();
        assert_eq!(names(&views, &order), vec!["a", "b", "c", "d"]);
    }

    #[test]
    fn siblings_are_ordered_by_name_and_foreign_dependencies_are_ignored() {
        // 99 は集合外 (作り直さない) なので無視。自己参照も無視。
        let z = view(1, "s", "z", ViewKind::View, &[99, 1]);
        let a = view(2, "s", "a", ViewKind::View, &[]);
        let views = vec![z, a];
        let order = creation_order(&views).unwrap();
        assert_eq!(names(&views, &order), vec!["a", "z"]);
    }

    #[test]
    fn cycle_is_an_error() {
        let a = view(1, "s", "a", ViewKind::View, &[2]);
        let b = view(2, "s", "b", ViewKind::View, &[1]);
        assert!(creation_order(&[a, b]).is_err());
    }

    #[test]
    fn identifiers_are_quoted_and_embedded_quotes_doubled() {
        let mut v = view(1, "My Schema", "we\"ird", ViewKind::View, &[]);
        v.owner = "o\"wner".into();
        v.comment = Some("it's".into());
        v.column_comments = vec![("c\"ol".into(), "x'y".into())];
        let s = build_rebuild_sql(&[v], true).unwrap();
        assert_eq!(s.drop, vec!["DROP VIEW \"My Schema\".\"we\"\"ird\";"]);
        assert_eq!(
            s.restore,
            vec![
                "ALTER VIEW \"My Schema\".\"we\"\"ird\" OWNER TO \"o\"\"wner\";",
                "COMMENT ON VIEW \"My Schema\".\"we\"\"ird\" IS 'it''s';",
                "COMMENT ON COLUMN \"My Schema\".\"we\"\"ird\".\"c\"\"ol\" IS 'x''y';",
            ]
        );
    }

    #[test]
    fn definition_semicolon_is_normalized() {
        let mut v = view(1, "s", "v", ViewKind::View, &[]);
        v.definition = "  SELECT 1 ;\n".into();
        let s = build_rebuild_sql(&[v], true).unwrap();
        assert_eq!(s.create, vec!["CREATE VIEW \"s\".\"v\" AS\nSELECT 1;"]);
    }

    #[test]
    fn view_options_are_restored_with_the_view() {
        let mut v = view(1, "s", "v", ViewKind::View, &[]);
        v.options = vec![
            "security_barrier=true".into(),
            "check_option=cascaded".into(),
        ];
        let s = build_rebuild_sql(&[v], true).unwrap();
        assert_eq!(
            s.create,
            vec!["CREATE VIEW \"s\".\"v\" WITH (security_barrier=true, check_option=cascaded) AS\nSELECT id FROM t;"]
        );
    }

    #[test]
    fn materialized_view_data_option_and_indexes() {
        let mut v = view(1, "s", "mv", ViewKind::MaterializedView, &[]);
        v.indexes = vec!["CREATE UNIQUE INDEX mv_id ON s.mv USING btree (id)".into()];
        let with = build_rebuild_sql(std::slice::from_ref(&v), true).unwrap();
        assert!(with.create[0].ends_with("WITH NO DATA;"));
        assert_eq!(
            with.restore.last().map(String::as_str),
            Some("REFRESH MATERIALIZED VIEW \"s\".\"mv\";")
        );
        let without = build_rebuild_sql(&[v], false).unwrap();
        assert!(without.create[0].ends_with("WITH NO DATA;"));
        assert_eq!(
            without.restore.last().map(String::as_str),
            Some("CREATE UNIQUE INDEX mv_id ON s.mv USING btree (id);")
        );
    }

    #[test]
    fn grants_are_grouped_and_use_materialized_view_target() {
        let mut v = view(1, "s", "v", ViewKind::MaterializedView, &[]);
        v.has_acl = true;
        v.acl = vec![
            AclEntry {
                grantee: "reader".into(),
                privilege: "SELECT".into(),
                grantable: false,
            },
            AclEntry {
                grantee: String::new(),
                privilege: "SELECT".into(),
                grantable: false,
            },
            AclEntry {
                grantee: "admin".into(),
                privilege: "SELECT".into(),
                grantable: true,
            },
            AclEntry {
                grantee: "admin".into(),
                privilege: "UPDATE".into(),
                grantable: true,
            },
            AclEntry {
                grantee: "reader".into(),
                privilege: "TRIGGER".into(),
                grantable: false,
            },
        ];
        let s = build_rebuild_sql(&[v], true).unwrap();
        assert_eq!(
            s.restore,
            vec![
                "ALTER MATERIALIZED VIEW \"s\".\"v\" OWNER TO \"app\";",
                "REVOKE ALL ON \"s\".\"v\" FROM PUBLIC;",
                "GRANT SELECT ON \"s\".\"v\" TO PUBLIC;",
                "GRANT SELECT, UPDATE ON \"s\".\"v\" TO \"admin\" WITH GRANT OPTION;",
                "GRANT SELECT, TRIGGER ON \"s\".\"v\" TO \"reader\";",
                "REFRESH MATERIALIZED VIEW \"s\".\"v\";",
            ]
        );
    }

    #[test]
    fn unpopulated_materialized_view_stays_without_data() {
        let mut v = view(1, "s", "mv", ViewKind::MaterializedView, &[]);
        v.populated = false;
        let s = build_rebuild_sql(&[v], true).unwrap();
        assert!(s.create[0].ends_with("WITH NO DATA;"));
        assert!(!s.restore.iter().any(|x| x.starts_with("REFRESH")));
    }

    #[test]
    fn refresh_comes_after_owner_and_grants_of_all_views_in_dependency_order() {
        let mut mv1 = view(1, "s", "mv1", ViewKind::MaterializedView, &[]);
        mv1.has_acl = true;
        mv1.acl = vec![AclEntry {
            grantee: "r".into(),
            privilege: "SELECT".into(),
            grantable: false,
        }];
        let mv2 = view(2, "s", "mv2", ViewKind::MaterializedView, &[1]);
        let v3 = view(3, "s", "v3", ViewKind::View, &[2]);
        let s = build_rebuild_sql(&[v3, mv2, mv1], true).unwrap();
        assert!(s
            .create
            .iter()
            .filter(|c| c.starts_with("CREATE MATERIALIZED"))
            .all(|c| c.ends_with("WITH NO DATA;")));
        let pos = |needle: &str| s.restore.iter().position(|x| x.contains(needle));
        let last_owner = s
            .restore
            .iter()
            .rposition(|x| x.contains("OWNER TO"))
            .unwrap();
        let grant = pos("GRANT SELECT").unwrap();
        let r1 = pos("REFRESH MATERIALIZED VIEW \"s\".\"mv1\"").unwrap();
        let r2 = pos("REFRESH MATERIALIZED VIEW \"s\".\"mv2\"").unwrap();
        assert!(last_owner < r1 && grant < r1 && r1 < r2);
        assert_eq!(r2, s.restore.len() - 1);
    }

    #[test]
    fn column_acl_and_defaults_are_restored() {
        let mut v = view(1, "s", "v", ViewKind::View, &[]);
        v.column_acl = vec![
            (
                "id".into(),
                AclEntry {
                    grantee: "r".into(),
                    privilege: "SELECT".into(),
                    grantable: false,
                },
            ),
            (
                "id".into(),
                AclEntry {
                    grantee: "r".into(),
                    privilege: "UPDATE".into(),
                    grantable: false,
                },
            ),
            (
                "a\"b".into(),
                AclEntry {
                    grantee: String::new(),
                    privilege: "SELECT".into(),
                    grantable: true,
                },
            ),
        ];
        v.column_defaults = vec![("id".into(), "0".into())];
        let r = build_rebuild_sql(&[v], true).unwrap().restore;
        assert_eq!(
            r,
            vec![
                "ALTER VIEW \"s\".\"v\" OWNER TO \"app\";",
                "GRANT SELECT (\"a\"\"b\") ON \"s\".\"v\" TO PUBLIC WITH GRANT OPTION;",
                "GRANT SELECT (\"id\"), UPDATE (\"id\") ON \"s\".\"v\" TO \"r\";",
                "ALTER VIEW \"s\".\"v\" ALTER COLUMN \"id\" SET DEFAULT 0;",
            ]
        );
    }

    #[test]
    fn no_acl_means_no_grant_statements() {
        let s = build_rebuild_sql(&[view(1, "s", "v", ViewKind::View, &[])], true).unwrap();
        assert!(s
            .restore
            .iter()
            .all(|x| !x.contains("GRANT") && !x.contains("REVOKE")));
    }

    #[test]
    fn restore_order_is_owner_acl_comment_columns_indexes_triggers() {
        let mut v = view(1, "s", "v", ViewKind::View, &[]);
        v.has_acl = true;
        v.acl = vec![AclEntry {
            grantee: "r".into(),
            privilege: "SELECT".into(),
            grantable: false,
        }];
        v.comment = Some("c".into());
        v.column_comments = vec![("id".into(), "k".into())];
        v.triggers = vec![
            "CREATE TRIGGER t INSTEAD OF INSERT ON s.v FOR EACH ROW EXECUTE FUNCTION f()".into(),
        ];
        let r = build_rebuild_sql(&[v], true).unwrap().restore;
        let kinds: Vec<&str> = r
            .iter()
            .map(|s| s.split_whitespace().next().unwrap_or(""))
            .collect();
        assert_eq!(
            kinds,
            vec!["ALTER", "REVOKE", "GRANT", "COMMENT", "COMMENT", "CREATE"]
        );
    }

    #[test]
    fn restore_of_each_view_follows_creation_order() {
        let a = view(1, "s", "a", ViewKind::View, &[]);
        let b = view(2, "s", "b", ViewKind::View, &[1]);
        let s = build_rebuild_sql(&[b, a], true).unwrap();
        assert!(s.restore[0].contains("\"a\""));
        assert!(s.restore[1].contains("\"b\""));
    }
}
