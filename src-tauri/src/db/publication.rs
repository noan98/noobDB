//! PostgreSQL 論理レプリケーションのパブリケーション (PUBLICATION) の定義の組み立てと、
//! スキーマ比較・同期の差分計算 (#2181)。DB に触れない純粋層。
//!
//! パブリケーションはデータベース全体のオブジェクトで、表はスキーマをまたぐ。一方スキーマ比較は
//! 1 スキーマ対 1 スキーマなので、比較・同期では「比較するスキーマに属する表」だけを対象にする
//! ([`compare_definition`])。定義は次の形の複数文で、[`STMT_SPLIT`] で区切る:
//!
//! ```text
//! CREATE PUBLICATION "pub" WITH (publish = 'insert, update', publish_via_partition_root = false);
//! -- noobdb:split
//! ALTER PUBLICATION "pub" ADD TABLE "s"."orders" ("id", "note") WHERE (id > 0);
//! ```
//!
//! 作成 (`CREATE` + 各 `ADD TABLE`) は既存の複数文の定義と同じく DO ブロックにまとまり、
//! 定義が違うとき ([`replace_statements`]) は `ALTER PUBLICATION ... SET / ADD TABLE / DROP TABLE`
//! の最小の差分にする (パブリケーションは DROP + CREATE できない: 購読側のスロットや同期状態が
//! 壊れるため)。ツリーの定義表示は 1 つの `CREATE PUBLICATION` ([`display_definition`])。

use super::object_diff::{split_statements, STMT_SPLIT};
use super::sync::quote_ident;
use super::types::{PublicationInfo, PublicationTable};
use super::DriverKind;

/// `TABLES IN SCHEMA` 由来の表の `ADD TABLE` に付ける印 (ブロックコメントなので、付いたまま実行しても無害)。
/// 比較では無視し、同期では `DROP TABLE` を出さない判断に使う。
pub const VIA_SCHEMA: &str = " /* via schema */";

fn q(name: &str) -> String {
    quote_ident(DriverKind::Postgres, name)
}

fn qualified(t: &PublicationTable) -> String {
    format!("{}.{}", q(&t.schema), q(&t.table))
}

/// 表 1 件の指定 (`"s"."t" ("a", "b") WHERE (...)`)。
fn table_spec(t: &PublicationTable) -> String {
    let mut out = qualified(t);
    if let Some(cols) = &t.columns {
        let cols: Vec<String> = cols.iter().map(|c| q(c)).collect();
        out.push_str(&format!(" ({})", cols.join(", ")));
    }
    if let Some(f) = &t.row_filter {
        out.push_str(&format!(" WHERE ({f})"));
    }
    out
}

fn with_options(p: &PublicationInfo) -> String {
    format!(
        "WITH (publish = '{}', publish_via_partition_root = {})",
        p.publish.join(", "),
        p.via_root
    )
}

/// ツリーの定義表示: 全スキーマの表・行フィルタ・列リスト・スキーマ単位の公開を含む 1 つの `CREATE PUBLICATION`。
pub fn display_definition(p: &PublicationInfo) -> String {
    let mut out = format!("CREATE PUBLICATION {}", q(&p.name));
    if p.all_tables {
        out.push_str("\n  FOR ALL TABLES");
    } else {
        let mut items: Vec<String> = Vec::new();
        if !p.tables.is_empty() {
            let specs: Vec<String> = p.tables.iter().map(table_spec).collect();
            items.push(format!("TABLE {}", specs.join(",\n    ")));
        }
        if !p.schemas.is_empty() {
            let schemas: Vec<String> = p.schemas.iter().map(|s| q(s)).collect();
            items.push(format!("TABLES IN SCHEMA {}", schemas.join(", ")));
        }
        if !items.is_empty() {
            out.push_str(&format!("\n  FOR {}", items.join(",\n  ")));
        }
    }
    out.push_str(&format!("\n  {};", with_options(p)));
    // 各表の REPLICA IDENTITY (#2212)。UPDATE / DELETE を配信できるかの手掛かりで、比較・同期には使わない表示専用のコメント。
    for t in &p.tables {
        out.push_str(&format!(
            "\n-- {}: REPLICA IDENTITY {}",
            qualified(t),
            replica_identity_label(&t.replica_identity, t.has_primary_key)
        ));
    }
    out
}

/// `relreplident` の表示名 (#2212)。`d` は主キーの有無を添える (主キーが無いと UPDATE / DELETE を配信できない)。
fn replica_identity_label(ident: &str, has_primary_key: bool) -> String {
    match ident {
        "n" => "NOTHING".to_string(),
        "f" => "FULL".to_string(),
        "i" => "USING INDEX".to_string(),
        _ if has_primary_key => "DEFAULT (primary key)".to_string(),
        _ => "DEFAULT (no primary key)".to_string(),
    }
}

/// スキーマ比較・同期用の定義 (`schema` に属する表だけ)。`schema_tables` は `schema` の表 (明示的に追加した表と、
/// `TABLES IN SCHEMA` で公開される表を展開したもの) で、呼び出し側が表名順に渡す。`FOR ALL TABLES` は表を展開しない。
/// `via_schema` は `schema_tables` のうち `TABLES IN SCHEMA` 由来 (明示メンバーではない) の表名。これらの
/// `ADD TABLE` には [`VIA_SCHEMA`] の印を付ける (target 側のこの表には `DROP TABLE` を出せないため)。
pub fn compare_definition(
    p: &PublicationInfo,
    schema_tables: &[PublicationTable],
    via_schema: &[String],
) -> String {
    let mut parts: Vec<String> = Vec::new();
    let for_all = if p.all_tables { "FOR ALL TABLES " } else { "" };
    parts.push(format!(
        "CREATE PUBLICATION {} {for_all}{};",
        q(&p.name),
        with_options(p)
    ));
    if !p.all_tables {
        for t in schema_tables {
            let mark = if via_schema.contains(&t.table) {
                VIA_SCHEMA
            } else {
                ""
            };
            parts.push(format!(
                "ALTER PUBLICATION {} ADD TABLE {}{mark};",
                q(&p.name),
                table_spec(t)
            ));
        }
    }
    parts.join(&format!("\n{STMT_SPLIT}\n"))
}

/// 比較用の定義 ([`compare_definition`]) を読み戻したもの。
#[derive(Debug, PartialEq, Eq)]
struct ParsedPublication {
    /// 引用符つきの名前 (`"pub"`)。
    name: String,
    all_tables: bool,
    /// `publish = '...'` の中身。
    publish: String,
    /// `publish_via_partition_root` の値 (`true` / `false`)。
    via_root: String,
    /// 表の並び。
    tables: Vec<ParsedTable>,
}

#[derive(Debug, PartialEq, Eq)]
struct ParsedTable {
    /// 修飾名 (`"s"."t"`)。
    key: String,
    /// 指定の残り (列リスト・行フィルタ)。
    rest: String,
    /// `TABLES IN SCHEMA` 由来 (明示メンバーではない)。
    via_schema: bool,
}

/// 引用符つき識別子 (`"a""b"`) を先頭から 1 つ読み、(そのまま (引用符つき), 残り) を返す。
fn take_quoted(s: &str) -> Option<(&str, &str)> {
    let rest = s.strip_prefix('"')?;
    let mut i = 0;
    let bytes = rest.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if bytes.get(i + 1) == Some(&b'"') {
                i += 2;
                continue;
            }
            let end = 1 + i + 1;
            return Some((&s[..end], &s[end..]));
        }
        i += 1;
    }
    None
}

fn parse_compare_definition(def: &str) -> Option<ParsedPublication> {
    let parts = split_statements(def);
    let first = parts.first()?;
    let rest = first.strip_prefix("CREATE PUBLICATION ")?;
    let (name, rest) = take_quoted(rest)?;
    let rest = rest.trim_start();
    let (all_tables, rest) = match rest.strip_prefix("FOR ALL TABLES") {
        Some(r) => (true, r.trim_start()),
        None => (false, rest),
    };
    let opts = rest.strip_prefix("WITH (")?.strip_suffix(')')?;
    let publish = opts
        .strip_prefix("publish = '")?
        .split_once('\'')
        .map(|(p, _)| p.to_string())?;
    let via_root = opts
        .split("publish_via_partition_root = ")
        .nth(1)?
        .trim()
        .to_string();
    let mut tables = Vec::new();
    let add_prefix = format!("ALTER PUBLICATION {name} ADD TABLE ");
    for part in parts.iter().skip(1) {
        let spec = part.strip_prefix(&add_prefix)?;
        let (schema, after) = take_quoted(spec)?;
        let after = after.strip_prefix('.')?;
        let (table, rest) = take_quoted(after)?;
        let (rest, via_schema) = match rest.trim_end().strip_suffix(VIA_SCHEMA.trim_start()) {
            Some(r) => (r.trim_end(), true),
            None => (rest, false),
        };
        tables.push(ParsedTable {
            key: format!("{schema}.{table}"),
            rest: rest.to_string(),
            via_schema,
        });
    }
    Some(ParsedPublication {
        name: name.to_string(),
        all_tables,
        publish,
        via_root,
        tables,
    })
}

/// 差分から出す 1 文。`destructive` は表を外す (購読側への配信が止まる) 操作。
#[derive(Debug, PartialEq, Eq)]
pub struct ReplaceStatement {
    pub sql: String,
    pub destructive: bool,
    /// 行フィルタ・列リストの違いで同じ表を外してから足し直す `ADD TABLE`。前段の `DROP TABLE` を出さない
    /// (破壊的な操作を許可しない) ときは、表がまだメンバーなのでこの文も出さない (出すと PostgreSQL が拒否する)。
    pub after_drop: bool,
}

/// 同期の計画: 出す文と、出せなかった差分の警告 (パブリケーション名は呼び出し側が付ける)。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReplacePlan {
    pub statements: Vec<ReplaceStatement>,
    pub warnings: Vec<String>,
}

const UNDROPPABLE: &str = "は TABLES IN SCHEMA で公開されているため、個別に外せません (スキーマ単位の公開を手動で見直してください)";

/// 定義が違うパブリケーションを target で揃える文 (#2181)。DROP + CREATE はできない (購読側の同期状態が
/// 壊れる) ので、オプションの違いは `SET (...)`、表の差は `ADD TABLE` / `DROP TABLE` にする。行フィルタ・列リストが
/// 違う表は `DROP TABLE` + `ADD TABLE`。target が `TABLES IN SCHEMA` で公開している表は `DROP TABLE` できない
/// (明示メンバーではないと PostgreSQL が拒否する) ので、文を出さず警告にする。`FOR ALL TABLES` の有無の違いと、
/// 読めない定義は `Err` で理由を返す (呼び出し側が警告にして文を出さない)。
pub fn replace_statements(
    source_definition: &str,
    target_definition: &str,
) -> Result<ReplacePlan, String> {
    let (Some(src), Some(tgt)) = (
        parse_compare_definition(source_definition),
        parse_compare_definition(target_definition),
    ) else {
        return Err(
            "定義を解釈できないため同期できません。手動で ALTER PUBLICATION してください"
                .to_string(),
        );
    };
    if src.all_tables != tgt.all_tables {
        return Err("FOR ALL TABLES の有無の違いは自動で同期できません (パブリケーションの作り直しが要り、購読側の同期状態に影響するため)。手動で対応してください".to_string());
    }
    let mut plan = ReplacePlan::default();
    if src.publish != tgt.publish || src.via_root != tgt.via_root {
        plan.statements.push(ReplaceStatement {
            sql: format!(
                "ALTER PUBLICATION {} SET (publish = '{}', publish_via_partition_root = {})",
                src.name, src.publish, src.via_root
            ),
            destructive: false,
            after_drop: false,
        });
    }
    let find = |list: &'_ [ParsedTable], key: &str| -> Option<usize> {
        list.iter().position(|t| t.key == key)
    };
    let add = |t: &ParsedTable, after_drop: bool| ReplaceStatement {
        sql: format!(
            "ALTER PUBLICATION {} ADD TABLE {}{}",
            src.name, t.key, t.rest
        ),
        destructive: false,
        after_drop,
    };
    let drop = |t: &ParsedTable| ReplaceStatement {
        sql: format!("ALTER PUBLICATION {} DROP TABLE {}", src.name, t.key),
        destructive: true,
        after_drop: false,
    };
    // 外す文は先に出す (指定が違う表の DROP → ADD が成り立つように)。外した表を足し直せるかも合わせて決める。
    let mut skip_add: Vec<&str> = Vec::new();
    for t in &tgt.tables {
        let differs = match find(&src.tables, &t.key) {
            None => true,
            Some(i) => src.tables[i].rest != t.rest,
        };
        if !differs {
            continue;
        }
        if t.via_schema {
            plan.warnings.push(format!("{} {UNDROPPABLE}", t.key));
            skip_add.push(&t.key);
        } else {
            plan.statements.push(drop(t));
        }
    }
    for t in &src.tables {
        if skip_add.contains(&t.key.as_str()) {
            continue;
        }
        match find(&tgt.tables, &t.key) {
            None => plan.statements.push(add(t, false)),
            Some(i) if tgt.tables[i].rest != t.rest => plan.statements.push(add(t, true)),
            Some(_) => {}
        }
    }
    Ok(plan)
}

/// source に無く target にだけあるパブリケーションの扱い (#2181)。パブリケーションはデータベース全体に影響する
/// ので `DROP PUBLICATION` は出さず、比較するスキーマの表を明示メンバーから `DROP TABLE` する差分に縮める
/// (`TABLES IN SCHEMA` 由来の表と `FOR ALL TABLES` は触らず警告)。比較するスキーマの表が無ければ何も出さない。
pub fn target_only_statements(target_definition: &str) -> Result<ReplacePlan, String> {
    let Some(tgt) = parse_compare_definition(target_definition) else {
        return Err(
            "定義を解釈できないため同期できません。手動で ALTER PUBLICATION してください"
                .to_string(),
        );
    };
    let mut plan = ReplacePlan::default();
    if tgt.all_tables {
        plan.warnings.push(
            "FOR ALL TABLES のパブリケーションは、データベース全体に影響するため触りません"
                .to_string(),
        );
        return Ok(plan);
    }
    for t in &tgt.tables {
        if t.via_schema {
            plan.warnings.push(format!("{} {UNDROPPABLE}", t.key));
        } else {
            plan.statements.push(ReplaceStatement {
                sql: format!("ALTER PUBLICATION {} DROP TABLE {}", tgt.name, t.key),
                destructive: true,
                after_drop: false,
            });
        }
    }
    Ok(plan)
}

/// source にだけあるパブリケーションを target で作る定義 (印を除いたもの) (#2181)。`FOR ALL TABLES` は
/// データベース全体に影響する (スーパーユーザーが要る) ので作らず、理由を `Err` で返す。
pub fn create_definition(source_definition: &str) -> Result<String, String> {
    match parse_compare_definition(source_definition) {
        Some(p) if p.all_tables => Err(
            "FOR ALL TABLES のパブリケーションは、データベース全体に影響するため作成しません (手動で作成してください)"
                .to_string(),
        ),
        Some(_) => Ok(source_definition.replace(VIA_SCHEMA, "")),
        None => Err(
            "定義を解釈できないため作成できません。手動で CREATE PUBLICATION してください"
                .to_string(),
        ),
    }
}

/// [`subscription_definition`] の入力。
pub struct SubscriptionParts<'a> {
    pub name: &'a str,
    pub enabled: bool,
    pub slot: Option<&'a str>,
    pub synchronize_commit: &'a str,
    pub publications: &'a [String],
    /// パスワードを伏せたあとの接続文字列。権限不足で読めなければ `None`。
    pub conninfo: Option<String>,
    /// `pg_stat_subscription` の最終受信時刻 (購読ワーカーが動いていなければ `None`)。
    pub last_receipt: Option<&'a str>,
}

/// SQL の文字列リテラル (`'` を二重にする)。
fn lit(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// サブスクリプションの定義表示 (#2181): `CREATE SUBSCRIPTION` と、状態のコメント。接続文字列は呼び出し側が
/// 伏せ済みのものを渡す (ここでは平文を扱わない)。伏せた文字列は実行できないので、コメントでその旨を添える。
pub fn subscription_definition(p: &SubscriptionParts) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "-- 状態: {}\n",
        if p.enabled { "有効" } else { "無効" }
    ));
    out.push_str(&format!(
        "-- 最終受信: {}\n",
        p.last_receipt
            .unwrap_or("なし (購読ワーカーが動いていない)")
    ));
    let conn = match &p.conninfo {
        Some(c) => {
            out.push_str("-- 接続文字列のパスワードは伏せています (そのままでは実行できません)\n");
            lit(c)
        }
        None => {
            out.push_str("-- 接続文字列は権限不足のため取得できません\n");
            "'<権限不足のため取得できません>'".to_string()
        }
    };
    let pubs: Vec<String> = p.publications.iter().map(|x| q(x)).collect();
    let mut opts = vec![format!("enabled = {}", p.enabled)];
    if let Some(slot) = p.slot {
        opts.push(format!("slot_name = {}", lit(slot)));
    }
    if !p.synchronize_commit.is_empty() {
        opts.push(format!(
            "synchronous_commit = {}",
            lit(p.synchronize_commit)
        ));
    }
    out.push_str(&format!(
        "CREATE SUBSCRIPTION {}\n  CONNECTION {conn}\n  PUBLICATION {}\n  WITH ({});",
        q(p.name),
        pubs.join(", "),
        opts.join(", ")
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tbl(schema: &str, table: &str) -> PublicationTable {
        PublicationTable {
            schema: schema.into(),
            table: table.into(),
            columns: None,
            row_filter: None,
            replica_identity: "d".into(),
            has_primary_key: true,
        }
    }

    fn info(name: &str) -> PublicationInfo {
        PublicationInfo {
            name: name.into(),
            all_tables: false,
            publish: vec!["insert".into(), "update".into()],
            via_root: false,
            tables: vec![],
            schemas: vec![],
        }
    }

    #[test]
    fn display_covers_all_tables_filters_columns_and_schemas() {
        let mut p = info("pub_a");
        p.all_tables = true;
        assert_eq!(
            display_definition(&p),
            "CREATE PUBLICATION \"pub_a\"\n  FOR ALL TABLES\n  WITH (publish = 'insert, update', publish_via_partition_root = false);"
        );
        let mut p = info("pub_b");
        p.tables = vec![
            tbl("s", "plain"),
            PublicationTable {
                columns: Some(vec!["id".into(), "we\"ird".into()]),
                row_filter: Some("(id > 0)".into()),
                ..tbl("s", "orders")
            },
        ];
        p.schemas = vec!["other".into()];
        let d = display_definition(&p);
        assert!(d.contains("FOR TABLE \"s\".\"plain\",\n    \"s\".\"orders\" (\"id\", \"we\"\"ird\") WHERE ((id > 0)),\n  TABLES IN SCHEMA \"other\""), "{d}");
        // 各表の REPLICA IDENTITY を末尾のコメントに出す (#2212)。
        assert!(
            d.contains("\n-- \"s\".\"plain\": REPLICA IDENTITY DEFAULT (primary key)"),
            "{d}"
        );
        let mut p2 = info("pub_c");
        p2.tables = vec![
            PublicationTable {
                has_primary_key: false,
                ..tbl("s", "nopk")
            },
            PublicationTable {
                replica_identity: "n".into(),
                ..tbl("s", "none")
            },
            PublicationTable {
                replica_identity: "f".into(),
                has_primary_key: false,
                ..tbl("s", "full")
            },
            PublicationTable {
                replica_identity: "i".into(),
                ..tbl("s", "idx")
            },
        ];
        let d2 = display_definition(&p2);
        for expect in [
            "\"s\".\"nopk\": REPLICA IDENTITY DEFAULT (no primary key)",
            "\"s\".\"none\": REPLICA IDENTITY NOTHING",
            "\"s\".\"full\": REPLICA IDENTITY FULL",
            "\"s\".\"idx\": REPLICA IDENTITY USING INDEX",
        ] {
            assert!(d2.contains(expect), "{d2}");
        }
        // 表も スキーマも無い (空の) パブリケーションは FOR 句なし。
        assert!(!display_definition(&info("empty")).contains("FOR"));
    }

    #[test]
    fn compare_definition_round_trips_through_the_parser() {
        let mut p = info("we\"ird");
        p.publish = vec!["insert".into(), "truncate".into()];
        p.via_root = true;
        let tables = vec![
            tbl("s", "a"),
            PublicationTable {
                columns: Some(vec!["id".into(), "n".into()]),
                row_filter: Some("(n <> 'x, y')".into()),
                ..tbl("s", "b\"q")
            },
        ];
        let def = compare_definition(&p, &tables, &[]);
        assert!(def.contains(STMT_SPLIT));
        let parsed = parse_compare_definition(&def).expect("parse");
        assert_eq!(parsed.name, "\"we\"\"ird\"");
        assert!(!parsed.all_tables);
        assert_eq!(parsed.publish, "insert, truncate");
        assert_eq!(parsed.via_root, "true");
        assert_eq!(parsed.tables[0].key, "\"s\".\"a\"");
        assert_eq!(parsed.tables[0].rest, "");
        assert_eq!(parsed.tables[1].key, "\"s\".\"b\"\"q\"");
        assert_eq!(
            parsed.tables[1].rest,
            " (\"id\", \"n\") WHERE ((n <> 'x, y'))"
        );
        assert!(!parsed.tables[0].via_schema);
        // FOR ALL TABLES は表を展開しない。
        p.all_tables = true;
        let def = compare_definition(&p, &tables, &[]);
        assert!(!def.contains("ADD TABLE"), "{def}");
        assert!(parse_compare_definition(&def).is_some_and(|x| x.all_tables));
    }

    fn defs(src: &[&str], tgt: &[&str]) -> (String, String) {
        let mk = |names: &[&str]| {
            compare_definition(
                &info("p"),
                &names.iter().map(|n| tbl("t", n)).collect::<Vec<_>>(),
                &[],
            )
        };
        (mk(src), mk(tgt))
    }

    #[test]
    fn table_differences_become_add_and_drop_table() {
        let (s, t) = defs(&["a", "b"], &["b", "c"]);
        let st = replace_statements(&s, &t).unwrap().statements;
        let sqls: Vec<&str> = st.iter().map(|x| x.sql.as_str()).collect();
        assert_eq!(
            sqls,
            vec![
                "ALTER PUBLICATION \"p\" DROP TABLE \"t\".\"c\"",
                "ALTER PUBLICATION \"p\" ADD TABLE \"t\".\"a\"",
            ]
        );
        // 外す文だけが破壊的 (購読側への配信が止まる)。
        assert!(st[0].destructive && !st[1].destructive);
    }

    #[test]
    fn option_and_row_filter_differences_are_altered_in_place() {
        let mut p = info("p");
        let a = PublicationTable {
            row_filter: Some("(id > 0)".into()),
            ..tbl("t", "a")
        };
        let s = compare_definition(&p, std::slice::from_ref(&a), &[]);
        p.publish = vec!["insert".into()];
        let a2 = PublicationTable {
            row_filter: Some("(id > 10)".into()),
            ..tbl("t", "a")
        };
        let t = compare_definition(&p, std::slice::from_ref(&a2), &[]);
        let sqls: Vec<String> = replace_statements(&s, &t)
            .unwrap()
            .statements
            .into_iter()
            .map(|x| x.sql)
            .collect();
        assert_eq!(
            sqls,
            vec![
                "ALTER PUBLICATION \"p\" SET (publish = 'insert, update', publish_via_partition_root = false)",
                "ALTER PUBLICATION \"p\" DROP TABLE \"t\".\"a\"",
                "ALTER PUBLICATION \"p\" ADD TABLE \"t\".\"a\" WHERE ((id > 0))",
            ]
        );
        // 足し直す ADD は前段の DROP に依存する印が付く (DROP を出さないときは一緒に止める)。
        let flags: Vec<(bool, bool)> = replace_statements(&s, &t)
            .unwrap()
            .statements
            .iter()
            .map(|x| (x.destructive, x.after_drop))
            .collect();
        assert_eq!(flags, vec![(false, false), (true, false), (false, true)]);
        // 同じ定義なら何も出さない。
        assert!(replace_statements(&s, &s).unwrap().statements.is_empty());
    }

    fn with_schema_marks(names: &[&str], via: &[&str]) -> String {
        compare_definition(
            &info("p"),
            &names.iter().map(|n| tbl("t", n)).collect::<Vec<_>>(),
            &via.iter().map(|v| v.to_string()).collect::<Vec<_>>(),
        )
    }

    #[test]
    fn tables_published_via_schema_are_never_dropped() {
        // target が TABLES IN SCHEMA で公開している表 (c) は、source に無くても DROP TABLE を出さず警告にする。
        let s = with_schema_marks(&["a"], &[]);
        let t = with_schema_marks(&["a", "c"], &["c"]);
        let plan = replace_statements(&s, &t).unwrap();
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
        assert_eq!(plan.warnings.len(), 1);
        assert!(
            plan.warnings[0].contains("TABLES IN SCHEMA"),
            "{:?}",
            plan.warnings
        );
        // 行フィルタの違いでも、スキーマ由来の表は DROP + ADD しない。
        let a = PublicationTable {
            row_filter: Some("(id > 0)".into()),
            ..tbl("t", "a")
        };
        let s = compare_definition(&info("p"), std::slice::from_ref(&a), &[]);
        let t = with_schema_marks(&["a"], &["a"]);
        let plan = replace_statements(&s, &t).unwrap();
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
        assert_eq!(plan.warnings.len(), 1);
        // 印の有無だけの違い (source がスキーマ由来、target が明示) は差分として扱わない。
        let s = with_schema_marks(&["a"], &["a"]);
        let t = with_schema_marks(&["a"], &[]);
        let plan = replace_statements(&s, &t).unwrap();
        assert!(plan.statements.is_empty() && plan.warnings.is_empty());
        // source がスキーマ由来でも、足す文には印を付けない。
        let s = with_schema_marks(&["a"], &["a"]);
        let t = with_schema_marks(&[], &[]);
        let plan = replace_statements(&s, &t).unwrap();
        assert_eq!(
            plan.statements[0].sql,
            "ALTER PUBLICATION \"p\" ADD TABLE \"t\".\"a\""
        );
    }

    #[test]
    fn target_only_publication_only_drops_explicit_tables_of_the_schema() {
        let t = with_schema_marks(&["x", "y"], &["y"]);
        let plan = target_only_statements(&t).unwrap();
        assert_eq!(plan.statements.len(), 1);
        assert_eq!(
            plan.statements[0].sql,
            "ALTER PUBLICATION \"p\" DROP TABLE \"t\".\"x\""
        );
        assert!(plan.statements[0].destructive);
        assert_eq!(plan.warnings.len(), 1);
        // 比較するスキーマの表が無ければ何も出さない。
        let plan = target_only_statements(&with_schema_marks(&[], &[])).unwrap();
        assert!(plan.statements.is_empty() && plan.warnings.is_empty());
        // FOR ALL TABLES は触らず警告。
        let mut p = info("p");
        p.all_tables = true;
        let plan = target_only_statements(&compare_definition(&p, &[], &[])).unwrap();
        assert!(plan.statements.is_empty());
        assert_eq!(plan.warnings.len(), 1);
        assert!(target_only_statements("nonsense").is_err());
    }

    #[test]
    fn create_definition_strips_marks_and_refuses_all_tables() {
        let d = create_definition(&with_schema_marks(&["a"], &["a"])).unwrap();
        assert!(!d.contains("via schema"), "{d}");
        assert!(d.contains("ADD TABLE \"t\".\"a\";"), "{d}");
        let mut p = info("p");
        p.all_tables = true;
        assert!(create_definition(&compare_definition(&p, &[], &[])).is_err());
        assert!(create_definition("nonsense").is_err());
    }

    #[test]
    fn all_tables_mismatch_and_garbage_are_refused() {
        let mut p = info("p");
        let plain = compare_definition(&p, &[], &[]);
        p.all_tables = true;
        let all = compare_definition(&p, &[], &[]);
        assert!(replace_statements(&plain, &all).is_err());
        assert!(replace_statements("nonsense", &plain).is_err());
    }

    #[test]
    fn subscription_definition_marks_redaction_and_missing_privilege() {
        let pubs = vec!["pub_a".to_string(), "we\"ird".to_string()];
        let base = SubscriptionParts {
            name: "sub1",
            enabled: true,
            slot: Some("sub1"),
            synchronize_commit: "off",
            publications: &pubs,
            conninfo: Some("host=h password='********'".to_string()),
            last_receipt: Some("2026-11-09 10:00:00+00"),
        };
        let d = subscription_definition(&base);
        assert!(d.contains("-- 状態: 有効"), "{d}");
        assert!(d.contains("-- 最終受信: 2026-11-09 10:00:00+00"), "{d}");
        assert!(
            d.contains("CONNECTION 'host=h password=''********'''"),
            "{d}"
        );
        assert!(d.contains("PUBLICATION \"pub_a\", \"we\"\"ird\""), "{d}");
        assert!(
            d.contains("WITH (enabled = true, slot_name = 'sub1', synchronous_commit = 'off')"),
            "{d}"
        );
        let d = subscription_definition(&SubscriptionParts {
            conninfo: None,
            enabled: false,
            slot: None,
            last_receipt: None,
            ..base
        });
        assert!(d.contains("権限不足のため取得できません"), "{d}");
        assert!(
            d.contains("-- 状態: 無効") && d.contains("WITH (enabled = false,"),
            "{d}"
        );
        assert!(d.contains("-- 最終受信: なし"), "{d}");
    }
}
