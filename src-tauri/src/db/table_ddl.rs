//! 既存テーブルの `CREATE TABLE` DDL をカタログの introspection 結果から
//! 再構成する (#1001「DDL をコピー / 表示」)。
//!
//! MySQL (`SHOW CREATE TABLE`)・SQLite (`sqlite_master.sql`) はエンジン自身が
//! 保持する DDL をそのまま返すのでここを通らない。PostgreSQL にはネイティブな
//! 「テーブルの CREATE 文を返す」機能が無いため、既存の `describe_table` (列)
//! + `list_indexes` + `foreign_keys` の結果を束ね、Diff/Sync の CREATE 分岐
//! (`db::sync`) と
//! **同じ列定義レンダラ** (`column_def` / `quote_ident` / `render_create_table`)
//! で接続自身の方言の DDL にする。純関数なので DB 無しでテストできる。
//!
//! あくまでベストエフォート: 生成列の式・CHECK 制約・パーティション・
//! ストレージオプション・式インデックスは introspection が持たないため出力されない (式インデックスは誤った形で出さず、
//! 末尾のコメントで名前だけ知らせる)。部分インデックスは述語 (`WHERE`) 付きで出力する。
//! その旨を DDL 冒頭のコメント ([`SYNTHESIZED_DDL_HEADER`]) で明示する。

use super::sync::{column_def, quote_ident, render_create_table};
use super::types::{ForeignKey, IndexInfo, TableColumnInfo};
use super::DriverKind;

/// 再構成 DDL の先頭に付ける注意書き。SQL コメントなので貼り付けてもそのまま
/// 実行できる。
pub const SYNTHESIZED_DDL_HEADER: &str = "\
-- Reconstructed by noobDB from catalog metadata (best-effort).
-- Generated columns, CHECK constraints, partitioning, storage options,
-- and expression indexes are not included. Review before running.
";

/// `schema` (PostgreSQL のスキーマ) で修飾したテーブル名。
fn qualified_name(driver: DriverKind, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", quote_ident(driver, s), quote_ident(driver, table))
        }
        _ => quote_ident(driver, table),
    }
}

/// 1 列ぶんの定義。sync と共通の `column_def` をそのまま使う。
fn render_column(driver: DriverKind, col: &TableColumnInfo) -> String {
    column_def(driver, col)
}

/// 主キー列を宣言順で返す。PK インデックスがあればその列順 (複合 PK の順序を
/// 保つ)、無ければ `key == "PRI"` の列を列順で拾う。
fn primary_key_columns<'a>(
    columns: &'a [TableColumnInfo],
    indexes: &'a [IndexInfo],
) -> Vec<&'a str> {
    if let Some(pk) = indexes.iter().find(|i| i.primary && !i.columns.is_empty()) {
        return pk.columns.iter().map(String::as_str).collect();
    }
    columns
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .map(|c| c.name.as_str())
        .collect()
}

/// 外部キー 1 制約ぶん (複合キーの列を束ねたもの)。
pub(crate) struct FkGroup<'a> {
    pub(crate) name: Option<&'a str>,
    pub(crate) referenced_table: &'a str,
    pub(crate) columns: Vec<&'a str>,
    pub(crate) referenced_columns: Vec<Option<&'a str>>,
    pub(crate) on_delete: Option<&'a str>,
    pub(crate) on_update: Option<&'a str>,
}

/// `foreign_keys` の 1 列 1 行を制約単位に畳む。制約名が無い行はそれぞれ独立の
/// 制約として扱う。information_schema の結合が複合キーで直積を返しても同じ列の
/// 組が重複しないよう除去する。出現順を保つ。
pub(crate) fn group_foreign_keys<'a>(table: &str, fks: &'a [ForeignKey]) -> Vec<FkGroup<'a>> {
    let mut groups: Vec<FkGroup<'a>> = Vec::new();
    for fk in fks.iter().filter(|f| f.table == table) {
        let existing = fk.constraint_name.as_deref().and_then(|name| {
            groups
                .iter()
                .position(|g| g.name == Some(name) && g.referenced_table == fk.referenced_table)
        });
        let pos = match existing {
            Some(i) => i,
            None => {
                groups.push(FkGroup {
                    name: fk.constraint_name.as_deref(),
                    referenced_table: &fk.referenced_table,
                    columns: Vec::new(),
                    referenced_columns: Vec::new(),
                    on_delete: fk.on_delete.as_deref(),
                    on_update: fk.on_update.as_deref(),
                });
                groups.len() - 1
            }
        };
        let Some(group) = groups.get_mut(pos) else {
            continue;
        };
        let ref_col = fk.referenced_column.as_deref();
        let duplicate = group
            .columns
            .iter()
            .zip(group.referenced_columns.iter())
            .any(|(c, r)| *c == fk.column.as_str() || (ref_col.is_some() && *r == ref_col));
        if !duplicate {
            group.columns.push(&fk.column);
            group.referenced_columns.push(ref_col);
        }
    }
    groups
}

pub(crate) fn render_foreign_key(driver: DriverKind, g: &FkGroup<'_>) -> String {
    let cols: Vec<String> = g.columns.iter().map(|c| quote_ident(driver, c)).collect();
    let mut out = String::new();
    if let Some(name) = g.name {
        out.push_str(&format!("CONSTRAINT {} ", quote_ident(driver, name)));
    }
    out.push_str(&format!(
        "FOREIGN KEY ({}) REFERENCES {}",
        cols.join(", "),
        quote_ident(driver, g.referenced_table)
    ));
    // 参照先列が 1 つでも解決できないときは列リストを省く (参照先の主キーを
    // 暗黙に指す形になり、SQL としては有効)。
    if g.referenced_columns.iter().all(Option::is_some) {
        let refs: Vec<String> = g
            .referenced_columns
            .iter()
            .flatten()
            .map(|c| quote_ident(driver, c))
            .collect();
        out.push_str(&format!(" ({})", refs.join(", ")));
    }
    if let Some(action) = g.on_delete {
        out.push_str(&format!(" ON DELETE {action}"));
    }
    if let Some(action) = g.on_update {
        out.push_str(&format!(" ON UPDATE {action}"));
    }
    out
}

/// PK 以外のインデックスの `CREATE INDEX`。列の無いもの・式を含むものは正しく再現できない
/// (列だけで作ると制約が変わる) ので出さない。部分インデックスは `WHERE` 述語を付ける。
pub(crate) fn render_index(driver: DriverKind, qualified: &str, idx: &IndexInfo) -> Option<String> {
    if idx.primary || idx.columns.is_empty() || idx.first_expression_at.is_some() {
        return None;
    }
    // PostgreSQL の INCLUDE 列はキー列ではない。キー列として出すと UNIQUE の対象が
    // 広がり制約の意味が変わるので、`INCLUDE (...)` に分けて出す。並び順 (DESC /
    // NULLS FIRST) もキー列ごとに残す。
    let key_len = idx
        .key_column_count
        .unwrap_or(idx.columns.len())
        .min(idx.columns.len());
    let cols: Vec<String> = idx.columns[..key_len]
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                "{}{}",
                quote_ident(driver, c),
                idx.column_options.get(i).map(String::as_str).unwrap_or("")
            )
        })
        .collect();
    let include = &idx.columns[key_len..];
    let unique = if idx.unique { "UNIQUE " } else { "" };
    let method = idx.method.as_deref().unwrap_or("");
    let mut sql = match driver {
        // PostgreSQL は btree 以外のアクセスメソッドを `USING` で残す。
        DriverKind::Postgres if !method.is_empty() && !method.eq_ignore_ascii_case("btree") => {
            format!(
                "CREATE {unique}INDEX {} ON {qualified} USING {method} ({})",
                quote_ident(driver, &idx.name),
                cols.join(", ")
            )
        }
        _ => format!(
            "CREATE {unique}INDEX {} ON {qualified} ({})",
            quote_ident(driver, &idx.name),
            cols.join(", ")
        ),
    };
    if !include.is_empty() {
        let inc: Vec<String> = include.iter().map(|c| quote_ident(driver, c)).collect();
        sql.push_str(&format!(" INCLUDE ({})", inc.join(", ")));
    }
    if idx.nulls_not_distinct && idx.unique {
        sql.push_str(" NULLS NOT DISTINCT");
    }
    if let Some(pred) = idx.predicate.as_deref().filter(|p| !p.trim().is_empty()) {
        sql.push_str(&format!(" WHERE {pred}"));
    }
    Some(sql)
}

/// introspection 結果から `CREATE TABLE` (+ 後続の `CREATE INDEX`) を再構成する。
///
/// - 列: sync の CREATE 分岐と同じ `column_def` (型・NOT NULL・DEFAULT)
/// - 主キー: `PRIMARY KEY (...)` 句
/// - 外部キー: 制約単位に束ねた `CONSTRAINT ... FOREIGN KEY ... REFERENCES ...` 句
/// - インデックス: PK 以外を `CREATE [UNIQUE] INDEX` として後置
///
/// 各文は `;` で終端し、先頭に [`SYNTHESIZED_DDL_HEADER`] を付ける。
pub fn synthesize_create_table(
    driver: DriverKind,
    schema: Option<&str>,
    table: &str,
    columns: &[TableColumnInfo],
    indexes: &[IndexInfo],
    foreign_keys: &[ForeignKey],
) -> String {
    let qualified = qualified_name(driver, schema, table);
    let mut lines: Vec<String> = columns.iter().map(|c| render_column(driver, c)).collect();

    let pk = primary_key_columns(columns, indexes);
    if !pk.is_empty() {
        let cols: Vec<String> = pk.iter().map(|c| quote_ident(driver, c)).collect();
        lines.push(format!("PRIMARY KEY ({})", cols.join(", ")));
    }
    for g in group_foreign_keys(table, foreign_keys) {
        lines.push(render_foreign_key(driver, &g));
    }

    let mut statements = vec![render_create_table(&qualified, &lines)];
    statements.extend(
        indexes
            .iter()
            .filter_map(|idx| render_index(driver, &qualified, idx)),
    );

    let mut out = String::from(SYNTHESIZED_DDL_HEADER);
    out.push_str(&statements.join(";\n\n"));
    out.push(';');
    out.push('\n');
    // 再現できなかった式インデックスは名前だけコメントで知らせる (無言で落とさない)。
    for idx in indexes
        .iter()
        .filter(|i| !i.primary && i.first_expression_at.is_some())
    {
        out.push_str(&format!(
            "-- Skipped expression index: {}\n",
            idx.name.replace(['\n', '\r'], " ")
        ));
    }
    out
}

/// ネイティブ DDL (1 文以上) を「`;` 終端・文間空行」の形にそろえる。
/// MySQL `SHOW CREATE TABLE` や SQLite `sqlite_master.sql` は終端の `;` を
/// 持たないため、コピーした DDL をそのまま複数文として貼れるようにする。
pub fn join_native_statements<I, S>(statements: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let parts: Vec<String> = statements
        .into_iter()
        .map(|s| {
            s.as_ref()
                .trim()
                .trim_end_matches(';')
                .trim_end()
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return String::new();
    }
    let mut out = parts.join(";\n\n");
    out.push_str(";\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str, nullable: bool, key: &str) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable,
            key: key.to_string(),
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        }
    }

    fn idx(
        name: &str,
        cols: &[&str],
        unique: bool,
        primary: bool,
        method: Option<&str>,
    ) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            unique,
            primary,
            method: method.map(str::to_string),
            predicate: None,
            first_expression_at: None,
            ..Default::default()
        }
    }

    fn fk(table: &str, column: &str, rt: &str, rc: Option<&str>, name: Option<&str>) -> ForeignKey {
        ForeignKey {
            table: table.to_string(),
            column: column.to_string(),
            referenced_table: rt.to_string(),
            referenced_column: rc.map(str::to_string),
            constraint_name: name.map(str::to_string),
            on_delete: None,
            on_update: None,
        }
    }

    #[test]
    fn postgres_includes_columns_pk_fk_and_indexes() {
        let mut id = col("id", "integer", false, "PRI");
        id.default = Some("nextval('orders_id_seq'::regclass)".into());
        let mut status = col("status", "character varying(20)", false, "");
        status.default = Some("'new'::character varying".into());
        let cols = vec![id, col("user_id", "integer", true, ""), status];
        let indexes = vec![
            idx("orders_pkey", &["id"], true, true, Some("btree")),
            idx("orders_user_idx", &["user_id"], false, false, Some("btree")),
            idx("orders_tags_gin", &["status"], false, false, Some("gin")),
        ];
        let fks = vec![
            fk(
                "orders",
                "user_id",
                "users",
                Some("id"),
                Some("orders_user_fk"),
            ),
            fk("other", "x", "users", Some("id"), Some("other_fk")),
        ];
        let ddl = synthesize_create_table(
            DriverKind::Postgres,
            Some("public"),
            "orders",
            &cols,
            &indexes,
            &fks,
        );
        assert!(ddl.starts_with(SYNTHESIZED_DDL_HEADER));
        assert!(ddl.contains("CREATE TABLE \"public\".\"orders\" (\n"));
        assert!(ddl.contains("\"id\" integer NOT NULL DEFAULT nextval('orders_id_seq'::regclass)"));
        assert!(ddl.contains("\"user_id\" integer,"));
        assert!(ddl.contains(
            "\"status\" character varying(20) NOT NULL DEFAULT 'new'::character varying"
        ));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
        assert!(ddl.contains(
            "CONSTRAINT \"orders_user_fk\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\")"
        ));
        // 他テーブルの FK は混ざらない
        assert!(!ddl.contains("other_fk"));
        assert!(ddl
            .contains("CREATE INDEX \"orders_user_idx\" ON \"public\".\"orders\" (\"user_id\");"));
        assert!(ddl.contains(
            "CREATE INDEX \"orders_tags_gin\" ON \"public\".\"orders\" USING gin (\"status\");"
        ));
        // PK インデックスは CREATE INDEX にしない
        assert!(!ddl.contains("\"orders_pkey\""));
        assert!(ddl.ends_with(";\n"));
    }

    #[test]
    fn composite_pk_follows_index_order_and_composite_fk_is_grouped() {
        let cols = vec![
            col("b", "int", false, "PRI"),
            col("a", "int", false, "PRI"),
            col("pa", "int", true, ""),
            col("pb", "int", true, ""),
        ];
        let indexes = vec![idx("PK_t", &["a", "b"], true, true, None)];
        // information_schema の直積で同じ組が重複して届くケースも畳めること
        let fks = vec![
            fk("t", "pa", "parent", Some("x"), Some("fk_parent")),
            fk("t", "pb", "parent", Some("y"), Some("fk_parent")),
            fk("t", "pa", "parent", Some("y"), Some("fk_parent")),
        ];
        let ddl = synthesize_create_table(DriverKind::Mysql, None, "t", &cols, &indexes, &fks);
        assert!(ddl.contains("CREATE TABLE `t` ("));
        assert!(ddl.contains("PRIMARY KEY (`a`, `b`)"));
        assert!(ddl.contains(
            "CONSTRAINT `fk_parent` FOREIGN KEY (`pa`, `pb`) REFERENCES `parent` (`x`, `y`)"
        ));
    }

    #[test]
    fn fk_without_resolved_referenced_column_omits_column_list() {
        let cols = vec![col("p", "INTEGER", true, "")];
        let fks = vec![fk("c", "p", "parent", None, None)];
        let ddl = synthesize_create_table(DriverKind::Postgres, None, "c", &cols, &[], &fks);
        assert!(ddl.contains("CREATE TABLE \"c\" ("));
        assert!(ddl.contains("FOREIGN KEY (\"p\") REFERENCES \"parent\"\n"));
        assert!(!ddl.contains("CONSTRAINT"));
    }

    #[test]
    fn expression_index_without_columns_is_skipped_and_quotes_are_escaped() {
        let cols = vec![col("we\"ird", "text", true, "")];
        let indexes = vec![idx("expr_idx", &[], false, false, Some("btree"))];
        let ddl = synthesize_create_table(
            DriverKind::Postgres,
            Some("s\"x"),
            "t\"1",
            &cols,
            &indexes,
            &[],
        );
        assert!(ddl.contains("CREATE TABLE \"s\"\"x\".\"t\"\"1\""));
        assert!(ddl.contains("\"we\"\"ird\" text"));
        assert!(!ddl.contains("CREATE INDEX"));
        assert!(!ddl.contains("PRIMARY KEY"));
    }

    #[test]
    fn foreign_key_referential_actions_are_emitted() {
        let cols = vec![col("user_id", "integer", true, "")];
        let mut f = fk("orders", "user_id", "users", Some("id"), Some("fk_u"));
        f.on_delete = Some("CASCADE".into());
        f.on_update = Some("SET NULL".into());
        let ddl = synthesize_create_table(DriverKind::Postgres, None, "orders", &cols, &[], &[f]);
        assert!(ddl.contains(
            "FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\") ON DELETE CASCADE ON UPDATE SET NULL"
        ));
    }

    #[test]
    fn include_columns_sort_order_and_nulls_not_distinct_are_kept() {
        let mut i = idx("u", &["a", "b", "c"], true, false, Some("btree"));
        i.key_column_count = Some(1);
        i.column_options = vec![" DESC NULLS LAST".into(), String::new(), String::new()];
        i.nulls_not_distinct = true;
        assert_eq!(
            render_index(DriverKind::Postgres, "\"public\".\"t\"", &i).as_deref(),
            Some(
                "CREATE UNIQUE INDEX \"u\" ON \"public\".\"t\" (\"a\" DESC NULLS LAST) INCLUDE (\"b\", \"c\") NULLS NOT DISTINCT"
            )
        );
    }

    #[test]
    fn partial_index_keeps_its_predicate_and_expression_index_is_reported() {
        let cols = vec![
            col("email", "text", true, ""),
            col("deleted_at", "timestamp", true, ""),
        ];
        let mut partial = idx("u_email", &["email"], true, false, Some("btree"));
        partial.predicate = Some("(deleted_at IS NULL)".into());
        let mut expr = idx("u_lower", &["tenant_id"], true, false, Some("btree"));
        expr.first_expression_at = Some(0);
        let ddl = synthesize_create_table(
            DriverKind::Postgres,
            Some("public"),
            "t",
            &cols,
            &[partial, expr],
            &[],
        );
        assert!(ddl.contains(
            "CREATE UNIQUE INDEX \"u_email\" ON \"public\".\"t\" (\"email\") WHERE (deleted_at IS NULL);"
        ));
        assert!(!ddl.contains("CREATE UNIQUE INDEX \"u_lower\""));
        assert!(ddl.contains("-- Skipped expression index: u_lower"));
    }

    #[test]
    fn join_native_statements_terminates_each_statement() {
        let out =
            join_native_statements(["CREATE TABLE t (a int)", "  CREATE INDEX i ON t(a);  ", ""]);
        assert_eq!(out, "CREATE TABLE t (a int);\n\nCREATE INDEX i ON t(a);\n");
        assert_eq!(join_native_statements(Vec::<String>::new()), "");
    }
}
