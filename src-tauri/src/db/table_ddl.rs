//! 既存テーブルの `CREATE TABLE` DDL をカタログの introspection 結果から
//! 再構成する (#1001「DDL をコピー / 表示」)。
//!
//! MySQL (`SHOW CREATE TABLE`)・SQLite (`sqlite_master.sql`)・DuckDB
//! (`duckdb_tables().sql`) はエンジン自身が保持する DDL をそのまま返すので
//! ここを通らない。PostgreSQL / MSSQL にはネイティブな「テーブルの CREATE 文を
//! 返す」機能が無いため、既存の `describe_table` (列) + `list_indexes` +
//! `foreign_keys` の結果を束ね、Diff/Sync の CREATE 分岐 (`db::sync`) と
//! **同じ列定義レンダラ** (`column_def` / `quote_ident` / `render_create_table`)
//! で接続自身の方言の DDL にする。純関数なので DB 無しでテストできる。
//!
//! あくまでベストエフォート: 生成列の式・CHECK 制約・パーティション・
//! ストレージオプション・部分/式インデックスは introspection が持たないため
//! 出力されない。その旨を DDL 冒頭のコメント ([`SYNTHESIZED_DDL_HEADER`]) で
//! 明示する。

use super::sync::{column_def, quote_ident, render_create_table};
use super::types::{ForeignKey, IndexInfo, TableColumnInfo};
use super::DriverKind;

/// 再構成 DDL の先頭に付ける注意書き。SQL コメントなので貼り付けてもそのまま
/// 実行できる。
pub const SYNTHESIZED_DDL_HEADER: &str = "\
-- Reconstructed by noobDB from catalog metadata (best-effort).
-- Generated columns, CHECK constraints, partitioning, storage options and
-- partial/expression indexes are not included. Review before running.
";

/// `schema` (PostgreSQL のスキーマ / MSSQL の `dbo`) で修飾したテーブル名。
fn qualified_name(driver: DriverKind, schema: Option<&str>, table: &str) -> String {
    match schema {
        Some(s) if !s.is_empty() => {
            format!("{}.{}", quote_ident(driver, s), quote_ident(driver, table))
        }
        _ => quote_ident(driver, table),
    }
}

/// 1 列ぶんの定義。基本は sync と共通の `column_def` で、MSSQL の IDENTITY 列
/// だけ補う (sync 側は既存テーブルへのデータコピーで IDENTITY_INSERT が要らない
/// ように IDENTITY を付けない方針なので、ここで局所的に足す)。
fn render_column(driver: DriverKind, col: &TableColumnInfo) -> String {
    let mut def = column_def(driver, col);
    if driver == DriverKind::Mssql && col.extra.eq_ignore_ascii_case("identity") {
        def.push_str(" IDENTITY");
    }
    def
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
struct FkGroup<'a> {
    name: Option<&'a str>,
    referenced_table: &'a str,
    columns: Vec<&'a str>,
    referenced_columns: Vec<Option<&'a str>>,
}

/// `foreign_keys` の 1 列 1 行を制約単位に畳む。制約名が無い行はそれぞれ独立の
/// 制約として扱う。information_schema の結合が複合キーで直積を返しても同じ列の
/// 組が重複しないよう除去する。出現順を保つ。
fn group_foreign_keys<'a>(table: &str, fks: &'a [ForeignKey]) -> Vec<FkGroup<'a>> {
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

fn render_foreign_key(driver: DriverKind, g: &FkGroup<'_>) -> String {
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
    out
}

/// PK 以外のインデックスの `CREATE INDEX`。列の無いもの (式インデックス等) は
/// 正しく再現できないので出さない。
fn render_index(driver: DriverKind, qualified: &str, idx: &IndexInfo) -> Option<String> {
    if idx.primary || idx.columns.is_empty() {
        return None;
    }
    let cols: Vec<String> = idx.columns.iter().map(|c| quote_ident(driver, c)).collect();
    let unique = if idx.unique { "UNIQUE " } else { "" };
    let method = idx.method.as_deref().unwrap_or("");
    let sql = match driver {
        // MSSQL の `type_desc` は CLUSTERED / NONCLUSTERED をそのまま DDL に書ける。
        // それ以外 (COLUMNSTORE / XML / SPATIAL 等) は列リスト形式にならないので
        // 通常の (NONCLUSTERED) インデックスとして書く。
        DriverKind::Mssql => {
            let kind = match method.to_ascii_uppercase().as_str() {
                "CLUSTERED" => "CLUSTERED ",
                "NONCLUSTERED" => "NONCLUSTERED ",
                _ => "",
            };
            format!(
                "CREATE {unique}{kind}INDEX {} ON {qualified} ({})",
                quote_ident(driver, &idx.name),
                cols.join(", ")
            )
        }
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
        }
    }

    fn fk(table: &str, column: &str, rt: &str, rc: Option<&str>, name: Option<&str>) -> ForeignKey {
        ForeignKey {
            table: table.to_string(),
            column: column.to_string(),
            referenced_table: rt.to_string(),
            referenced_column: rc.map(str::to_string),
            constraint_name: name.map(str::to_string),
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
        let indexes = vec![idx("PK_t", &["a", "b"], true, true, Some("CLUSTERED"))];
        // information_schema の直積で同じ組が重複して届くケースも畳めること
        let fks = vec![
            fk("t", "pa", "parent", Some("x"), Some("fk_parent")),
            fk("t", "pb", "parent", Some("y"), Some("fk_parent")),
            fk("t", "pa", "parent", Some("y"), Some("fk_parent")),
        ];
        let ddl =
            synthesize_create_table(DriverKind::Mssql, Some("dbo"), "t", &cols, &indexes, &fks);
        assert!(ddl.contains("CREATE TABLE [dbo].[t] ("));
        assert!(ddl.contains("PRIMARY KEY ([a], [b])"));
        assert!(ddl.contains(
            "CONSTRAINT [fk_parent] FOREIGN KEY ([pa], [pb]) REFERENCES [parent] ([x], [y])"
        ));
    }

    #[test]
    fn mssql_identity_and_index_kind() {
        let mut id = col("id", "int", false, "PRI");
        id.extra = "identity".into();
        let mut qty = col("qty", "int", false, "");
        qty.default = Some("((0))".into());
        let cols = vec![id, qty, col("name", "nvarchar(50)", true, "")];
        let indexes = vec![
            idx("PK_items", &["id"], true, true, Some("CLUSTERED")),
            idx(
                "UX_items_name",
                &["name"],
                true,
                false,
                Some("NONCLUSTERED"),
            ),
            idx(
                "IX_cs",
                &["qty"],
                false,
                false,
                Some("NONCLUSTERED COLUMNSTORE"),
            ),
        ];
        let ddl = synthesize_create_table(
            DriverKind::Mssql,
            Some("dbo"),
            "items",
            &cols,
            &indexes,
            &[],
        );
        assert!(ddl.contains("[id] int NOT NULL IDENTITY"));
        assert!(ddl.contains("[qty] int NOT NULL DEFAULT ((0))"));
        assert!(ddl.contains(
            "CREATE UNIQUE NONCLUSTERED INDEX [UX_items_name] ON [dbo].[items] ([name])"
        ));
        assert!(ddl.contains("CREATE INDEX [IX_cs] ON [dbo].[items] ([qty])"));
    }

    #[test]
    fn fk_without_resolved_referenced_column_omits_column_list() {
        let cols = vec![col("p", "INTEGER", true, "")];
        let fks = vec![fk("c", "p", "parent", None, None)];
        let ddl = synthesize_create_table(DriverKind::DuckDb, None, "c", &cols, &[], &fks);
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
        assert!(!ddl.contains("expr_idx"));
        assert!(!ddl.contains("PRIMARY KEY"));
    }

    #[test]
    fn join_native_statements_terminates_each_statement() {
        let out =
            join_native_statements(["CREATE TABLE t (a int)", "  CREATE INDEX i ON t(a);  ", ""]);
        assert_eq!(out, "CREATE TABLE t (a int);\n\nCREATE INDEX i ON t(a);\n");
        assert_eq!(join_native_statements(Vec::<String>::new()), "");
    }
}
