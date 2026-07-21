//! スキーマ健全性アドバイザ (#741)。
//!
//! **入力 (スキーマメタデータ) → 指摘リスト**の純関数として実装する、決定的な
//! ルールベースのスキーマ診断。AI 非依存で誤検出しにくい機械的な検査のみを扱い、
//! コンテキスト依存の「提案」はしない (#693 と方針が異なる)。
//!
//! 命令の層 (`commands::advisor`) がライブセッションからテーブル/カラム/
//! インデックス/外部キーのメタデータと (縮退しうる) 統計を集めてここへ渡す。
//! 計算を純粋に保つことで DB 無しに単体テストできる。
//!
//! ## 出力の i18n 方針
//!
//! バックエンドは**散文を一切出さない**。各指摘は安定した [`RuleId`] と、
//! ローカライズされた説明文を組み立てるための構造化フィールド (`table` /
//! `columns` / `context`) を持つ。フロントが `RuleId` をタイトル・説明テンプレートへ
//! マップする (`QueryStatsSupport` の理由コードと同じ発想)。修正 DDL のみ、安全で
//! 一意に定まるルールについて生成する (実行はしない。エディタ挿入まで)。

use serde::{Deserialize, Serialize};

use super::sync::quote_ident;
use super::types::{ForeignKey, IndexInfo, TableColumnInfo};
use super::DriverKind;

/// 指摘の重要度。フロントで semantic トークン (#664) に色分けされる。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    High,
    Medium,
    Low,
}

/// 安定したルール識別子。フロントがこれをローカライズ済みのタイトル・説明
/// テンプレートへマップするので、バックエンドは散文を出さない。`context` の
/// 各要素の意味はルールごとに異なるため、下の各バリアントに明記する。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleId {
    /// FK 列にインデックスが無い。`columns` = FK の構成列、
    /// `context = [参照先テーブル]`。修正 DDL = `CREATE INDEX`。
    FkMissingIndex,
    /// 完全一致の重複インデックス。`columns` = インデックス構成列、
    /// `context = [インデックス名, 重複相手のインデックス名]`。修正 DDL = `DROP INDEX`。
    DuplicateIndex,
    /// プレフィックス冗長インデックス ((a) は (a,b) に包含される)。
    /// `columns` = インデックス構成列、`context = [インデックス名, 包含側インデックス名]`。
    /// 修正 DDL = `DROP INDEX`。
    RedundantIndex,
    /// PK の無いテーブル。`columns` = 空、`context` = 空。修正 DDL 無し
    /// (PK 列の選定は設計判断のため生成しない)。
    MissingPrimaryKey,
    /// 未使用インデックス (統計依存)。`columns` = インデックス構成列、
    /// `context = [インデックス名]`。修正 DDL = `DROP INDEX`。`statistical = true`。
    UnusedIndex,
    /// FK 両端の型不一致 (暗黙変換でインデックスが効かない)。`columns` = FK 列、
    /// `context = [参照元の型, 参照先テーブル.列, 参照先の型]`。修正 DDL 無し
    /// (型変更はデータ移行を伴うため生成しない)。
    FkTypeMismatch,
    /// (SQLite) 単一列 PK の宣言型が整数親和だが `INTEGER` ではない。rowid
    /// エイリアスにならず別インデックス + rowid が二重に作られる定番の落とし穴。
    /// `columns = [PK 列]`、`context = [宣言型]`。修正 DDL 無し (テーブル再構築が必要)。
    SqliteIntegerPkHint,
}

/// 1 件の指摘。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthFinding {
    pub rule: RuleId,
    pub severity: Severity,
    pub table: String,
    /// 指摘の中心となる列 (FK 列・インデックス構成列・PK 列)。空のこともある。
    pub columns: Vec<String>,
    /// ローカライズ済み説明のための追加コンテキスト文字列。意味はルールごとに
    /// 異なり [`RuleId`] の各バリアントに明記する。
    pub context: Vec<String>,
    /// エディタへ挿入する修正 DDL。安全で一意に定まるルールのときのみ `Some`。
    /// 設計判断を要するルール (PK 欠落・型不一致・SQLite ヒント) は `None`。
    pub fix_ddl: Option<String>,
    /// エンジンの実行時統計 (未使用インデックス) に由来する指摘のとき `true`。
    /// フロントは「観測期間に依存する」旨の注記を表示する。
    pub statistical: bool,
}

/// 前提を満たさずスキップしたルールと、その機械可読な理由コード。黙って
/// 0 件にせず理由を表示して縮退するため (#587 の教訓)。フロントは理由コードを
/// i18n の (有効化手順つき) ヘルプ文言へマップする。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedRule {
    pub rule: RuleId,
    pub reason: String,
}

/// スキーマ健全性診断のレポート全体。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchemaHealthReport {
    pub driver: DriverKind,
    /// 解析した (ビューを除く) ベーステーブル数。進捗/サマリ表示用。
    pub tables_analyzed: usize,
    pub findings: Vec<HealthFinding>,
    pub skipped: Vec<SkippedRule>,
}

/// 1 テーブルのメタデータ (カラム + インデックス)。命令の層が
/// `Connection::columns` / `list_indexes` から組み立てる。
#[derive(Debug, Clone)]
pub struct TableMeta {
    pub name: String,
    pub columns: Vec<TableColumnInfo>,
    pub indexes: Vec<IndexInfo>,
}

/// 未使用インデックス統計。前提 (PostgreSQL の統計コレクタ・MySQL の
/// `sys.schema_unused_indexes` = performance_schema) を満たさなければ `supported`
/// を false にし `reason` に理由コードを入れて縮退する。
///
/// 理由コード (フロント `advisor.ts` と対で維持する):
/// - `unsupported_driver` — SQLite などサーバ統計を持たないドライバ
/// - `performance_schema_off` — MySQL で `performance_schema = OFF`
/// - `stats_unreadable` — ソースは存在するが読めない (権限不足・非対応バージョン)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnusedIndexStats {
    pub supported: bool,
    pub reason: Option<String>,
    pub entries: Vec<UnusedIndexEntry>,
}

/// エンジンが「統計リセット以降に一度も使われていない」と報告する 1 インデックス。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnusedIndexEntry {
    pub table: String,
    pub index: String,
}

/// 純ルール判定への入力一式。
#[derive(Debug, Clone)]
pub struct AdvisorInput {
    pub driver: DriverKind,
    pub tables: Vec<TableMeta>,
    pub foreign_keys: Vec<ForeignKey>,
    pub unused: UnusedIndexStats,
}

/// スキーマメタデータを走査して健全性の指摘リストを組み立てる純関数。副作用なし・
/// DB 非依存で、境界ケースは本モジュールの単体テストが固定する。
pub fn analyze(input: &AdvisorInput) -> SchemaHealthReport {
    let mut findings = Vec::new();
    let mut skipped = Vec::new();

    for table in &input.tables {
        rule_missing_primary_key(table, &mut findings);
        rule_duplicate_and_redundant_indexes(input.driver, table, &mut findings);
        if input.driver == DriverKind::Sqlite {
            rule_sqlite_integer_pk_hint(table, &mut findings);
        }
    }

    rule_fk_missing_index(input, &mut findings);
    rule_fk_type_mismatch(input, &mut findings);
    rule_unused_indexes(input, &mut findings, &mut skipped);

    // 決定的な出力順: テーブル名 → 重要度 (高い順) → ルール。
    findings.sort_by(|a, b| {
        a.table
            .cmp(&b.table)
            .then_with(|| severity_rank(a.severity).cmp(&severity_rank(b.severity)))
            .then_with(|| rule_rank(a.rule).cmp(&rule_rank(b.rule)))
            .then_with(|| a.columns.cmp(&b.columns))
    });

    SchemaHealthReport {
        driver: input.driver,
        tables_analyzed: input.tables.len(),
        findings,
        skipped,
    }
}

fn severity_rank(s: Severity) -> u8 {
    match s {
        Severity::High => 0,
        Severity::Medium => 1,
        Severity::Low => 2,
    }
}

fn rule_rank(r: RuleId) -> u8 {
    match r {
        RuleId::FkMissingIndex => 0,
        RuleId::FkTypeMismatch => 1,
        RuleId::MissingPrimaryKey => 2,
        RuleId::DuplicateIndex => 3,
        RuleId::RedundantIndex => 4,
        RuleId::UnusedIndex => 5,
        RuleId::SqliteIntegerPkHint => 6,
    }
}

/// テーブルに PK があるか。全ドライバで `columns` の `key = "PRI"` が PK 列に
/// 立つ (MySQL `COLUMN_KEY` / PostgreSQL `table_constraints` / SQLite `PRAGMA
/// table_info.pk`)。SQLite の `INTEGER PRIMARY KEY` (rowid エイリアス) は
/// `PRAGMA index_list` に現れないため、インデックスの `primary` フラグだけに
/// 頼らずカラムの `key` も見る。
fn has_primary_key(table: &TableMeta) -> bool {
    table
        .columns
        .iter()
        .any(|c| c.key.eq_ignore_ascii_case("PRI"))
        || table.indexes.iter().any(|i| i.primary)
}

fn rule_missing_primary_key(table: &TableMeta, out: &mut Vec<HealthFinding>) {
    // 列が 1 つも取れないもの (取得失敗・実体のないもの) は判定対象外。
    if table.columns.is_empty() || has_primary_key(table) {
        return;
    }
    out.push(HealthFinding {
        rule: RuleId::MissingPrimaryKey,
        severity: Severity::Medium,
        table: table.name.clone(),
        columns: Vec::new(),
        context: Vec::new(),
        fix_ddl: None,
        statistical: false,
    });
}

/// インデックスの構成列を小文字化して返す (比較用)。式インデックス等で列が
/// 空のものは呼び出し側が弾く。
fn lower_cols(idx: &IndexInfo) -> Vec<String> {
    idx.columns.iter().map(|c| c.to_lowercase()).collect()
}

fn rule_duplicate_and_redundant_indexes(
    driver: DriverKind,
    table: &TableMeta,
    out: &mut Vec<HealthFinding>,
) {
    let indexes = &table.indexes;
    for x in indexes {
        // PRIMARY / UNIQUE は制約を担うため DROP 候補にしない。列が空の
        // (式) インデックスも対象外。
        if x.primary || x.unique || x.columns.is_empty() {
            continue;
        }
        let xcols = lower_cols(x);

        // 完全一致の重複。相手が PRIMARY/UNIQUE か、名前が自分より前のときのみ
        // フラグする → 同一構成の非 UNIQUE インデックス 2 本のうち 1 本だけを
        // 指摘する (両方消える誤誘導を避ける)。
        if let Some(dup) = indexes.iter().find(|y| {
            y.name != x.name && lower_cols(y) == xcols && (y.primary || y.unique || y.name < x.name)
        }) {
            out.push(HealthFinding {
                rule: RuleId::DuplicateIndex,
                severity: Severity::Medium,
                table: table.name.clone(),
                columns: x.columns.clone(),
                context: vec![x.name.clone(), dup.name.clone()],
                fix_ddl: Some(drop_index_ddl(driver, &table.name, &x.name)),
                statistical: false,
            });
            continue;
        }

        // プレフィックス冗長: x の列列が別インデックス y の真のプレフィックス。
        // y は PRIMARY/UNIQUE を含む任意のインデックスでよい (より長いインデックスは
        // その先頭列でのルックアップを賄う)。
        if let Some(cov) = indexes.iter().find(|y| {
            y.name != x.name
                && y.columns.len() > x.columns.len()
                && lower_cols(y).starts_with(&xcols)
        }) {
            out.push(HealthFinding {
                rule: RuleId::RedundantIndex,
                severity: Severity::Low,
                table: table.name.clone(),
                columns: x.columns.clone(),
                context: vec![x.name.clone(), cov.name.clone()],
                fix_ddl: Some(drop_index_ddl(driver, &table.name, &x.name)),
                statistical: false,
            });
        }
    }
}

/// 構成列を順序どおり取り出す。ForeignKey は参照元列ごとに 1 エントリで、複合キーは
/// `constraint_name` を共有する。制約名が無い (SQLite の暗黙 FK 等) 場合は列ごとに
/// 独立した単一列 FK として扱う。
struct FkGroup {
    table: String,
    columns: Vec<String>,
    referenced_table: String,
}

fn group_foreign_keys(fks: &[ForeignKey]) -> Vec<FkGroup> {
    let mut groups: Vec<FkGroup> = Vec::new();
    // (table, constraint_name) をキーに畳む。constraint_name が None のものは
    // 一意な合成キーを与えて列ごとに分割する。
    let mut index_of: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();
    for (i, fk) in fks.iter().enumerate() {
        let key = match &fk.constraint_name {
            Some(name) => (fk.table.clone(), name.clone()),
            // 制約名なし: エントリごとに一意化 (畳まない)。
            None => (fk.table.clone(), format!("\u{0}unnamed:{i}")),
        };
        if let Some(&gi) = index_of.get(&key) {
            groups[gi].columns.push(fk.column.clone());
        } else {
            index_of.insert(key, groups.len());
            groups.push(FkGroup {
                table: fk.table.clone(),
                columns: vec![fk.column.clone()],
                referenced_table: fk.referenced_table.clone(),
            });
        }
    }
    groups
}

fn rule_fk_missing_index(input: &AdvisorInput, out: &mut Vec<HealthFinding>) {
    let by_name: std::collections::HashMap<&str, &TableMeta> =
        input.tables.iter().map(|t| (t.name.as_str(), t)).collect();

    for group in group_foreign_keys(&input.foreign_keys) {
        let Some(table) = by_name.get(group.table.as_str()) else {
            continue;
        };
        let fk_cols: Vec<String> = group.columns.iter().map(|c| c.to_lowercase()).collect();
        // FK が「賄われている」= あるインデックスの先頭が FK 列列に一致する。
        let covered = table
            .indexes
            .iter()
            .any(|idx| idx.columns.len() >= fk_cols.len() && lower_cols(idx).starts_with(&fk_cols));
        if covered {
            continue;
        }
        out.push(HealthFinding {
            rule: RuleId::FkMissingIndex,
            severity: Severity::High,
            table: group.table.clone(),
            columns: group.columns.clone(),
            context: vec![group.referenced_table.clone()],
            fix_ddl: Some(create_index_ddl(input.driver, &group.table, &group.columns)),
            statistical: false,
        });
    }
}

fn rule_fk_type_mismatch(input: &AdvisorInput, out: &mut Vec<HealthFinding>) {
    let by_name: std::collections::HashMap<&str, &TableMeta> =
        input.tables.iter().map(|t| (t.name.as_str(), t)).collect();

    // 各 FK エントリ (列単位) で参照元/参照先の型を突き合わせる。参照先列が
    // 解決できない (複合 PK への暗黙 FK 等) ものは比較不能なのでスキップ。
    for fk in &input.foreign_keys {
        let Some(ref_col) = &fk.referenced_column else {
            continue;
        };
        let (Some(src_table), Some(ref_table)) = (
            by_name.get(fk.table.as_str()),
            by_name.get(fk.referenced_table.as_str()),
        ) else {
            continue;
        };
        let Some(src_type) = column_type(src_table, &fk.column) else {
            continue;
        };
        let Some(ref_type) = column_type(ref_table, ref_col) else {
            continue;
        };
        if types_compatible(input.driver, src_type, ref_type) {
            continue;
        }
        out.push(HealthFinding {
            rule: RuleId::FkTypeMismatch,
            severity: Severity::Medium,
            table: fk.table.clone(),
            columns: vec![fk.column.clone()],
            context: vec![
                src_type.to_string(),
                format!("{}.{}", fk.referenced_table, ref_col),
                ref_type.to_string(),
            ],
            fix_ddl: None,
            statistical: false,
        });
    }
}

fn column_type<'a>(table: &'a TableMeta, column: &str) -> Option<&'a str> {
    table
        .columns
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case(column))
        .map(|c| c.data_type.as_str())
}

/// FK 両端の型が JOIN/カスケードでインデックスを効かせられる程度に整合するか。
/// 誤検出を避けるため保守的に判定する: 基底型トークン (先頭語) が一致し、
/// MySQL では符号 (`unsigned`) も一致していれば互換とみなす。長さ/精度の違い
/// (`varchar(50)` vs `varchar(255)`) は JOIN 自体は効くので不一致にしない。
fn types_compatible(driver: DriverKind, a: &str, b: &str) -> bool {
    if base_type_token(a) != base_type_token(b) {
        return false;
    }
    if driver == DriverKind::Mysql {
        let a_unsigned = a.to_lowercase().contains("unsigned");
        let b_unsigned = b.to_lowercase().contains("unsigned");
        if a_unsigned != b_unsigned {
            return false;
        }
    }
    true
}

/// 型文字列の基底トークン (先頭の英字語) を小文字で返す。`character varying(50)`
/// のような 2 語型は先頭語 (`character`) を返すが、両端とも同じ導出なので比較には
/// 十分。`int(11)` → `int`、`BIGINT UNSIGNED` → `bigint`。
fn base_type_token(t: &str) -> String {
    t.trim()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_lowercase()
}

fn rule_unused_indexes(
    input: &AdvisorInput,
    out: &mut Vec<HealthFinding>,
    skipped: &mut Vec<SkippedRule>,
) {
    if !input.unused.supported {
        skipped.push(SkippedRule {
            rule: RuleId::UnusedIndex,
            reason: input
                .unused
                .reason
                .clone()
                .unwrap_or_else(|| "stats_unreadable".into()),
        });
        return;
    }

    // (table, index) → IndexInfo を引けるようにして PRIMARY/UNIQUE を除外する
    // (制約を担うため統計上未使用でも DROP を勧めない)。
    let mut idx_by_key: std::collections::HashMap<(String, String), &IndexInfo> =
        std::collections::HashMap::new();
    for t in &input.tables {
        for idx in &t.indexes {
            idx_by_key.insert((t.name.to_lowercase(), idx.name.to_lowercase()), idx);
        }
    }

    for entry in &input.unused.entries {
        let key = (entry.table.to_lowercase(), entry.index.to_lowercase());
        // メタデータ側で PRIMARY/UNIQUE と判定できるものは除外。統計ビューに
        // 現れない/照合できないものは、統計ソースを信じてそのまま指摘する。
        if let Some(idx) = idx_by_key.get(&key) {
            if idx.primary || idx.unique {
                continue;
            }
        }
        out.push(HealthFinding {
            rule: RuleId::UnusedIndex,
            severity: Severity::Low,
            table: entry.table.clone(),
            columns: idx_by_key
                .get(&key)
                .map(|i| i.columns.clone())
                .unwrap_or_default(),
            context: vec![entry.index.clone()],
            fix_ddl: Some(drop_index_ddl(input.driver, &entry.table, &entry.index)),
            statistical: true,
        });
    }
}

fn rule_sqlite_integer_pk_hint(table: &TableMeta, out: &mut Vec<HealthFinding>) {
    // 単一列 PK に限定。宣言型が整数親和 (INT を含む) だが厳密に "INTEGER" では
    // ない場合、rowid エイリアスにならない SQLite 固有の落とし穴。
    let pk_cols: Vec<&TableColumnInfo> = table
        .columns
        .iter()
        .filter(|c| c.key.eq_ignore_ascii_case("PRI"))
        .collect();
    if pk_cols.len() != 1 {
        return;
    }
    let col = pk_cols[0];
    let ty = col.data_type.trim();
    let ty_upper = ty.to_uppercase();
    // 整数親和 (SQLite の型親和規則: 型名に "INT" を含むと INTEGER 親和) だが、
    // 厳密な "INTEGER" ではないもの (INT / BIGINT / TINYINT / INT UNSIGNED ...)。
    let integer_affinity = ty_upper.contains("INT");
    if integer_affinity && ty_upper != "INTEGER" {
        out.push(HealthFinding {
            rule: RuleId::SqliteIntegerPkHint,
            severity: Severity::Low,
            table: table.name.clone(),
            columns: vec![col.name.clone()],
            context: vec![ty.to_string()],
            fix_ddl: None,
            statistical: false,
        });
    }
}

/// FK 列に張る `CREATE INDEX` を生成する。インデックス名は `idx_<table>_<cols>`。
/// 識別子は方言でクオートする。ユーザはエディタで確認してから実行する。
fn create_index_ddl(driver: DriverKind, table: &str, columns: &[String]) -> String {
    let idx_name = sanitize_index_name(&format!("idx_{}_{}", table, columns.join("_")));
    let cols = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CREATE INDEX {} ON {} ({});",
        quote_ident(driver, &idx_name),
        quote_ident(driver, table),
        cols
    )
}

/// 方言別の `DROP INDEX`。MySQL は `DROP INDEX <name> ON <table>`、
/// PostgreSQL / SQLite は `DROP INDEX <name>` (テーブル指定不可)。
fn drop_index_ddl(driver: DriverKind, table: &str, index: &str) -> String {
    match driver {
        DriverKind::Mysql => format!(
            "DROP INDEX {} ON {};",
            quote_ident(driver, index),
            quote_ident(driver, table)
        ),
        DriverKind::Postgres | DriverKind::Sqlite => {
            format!("DROP INDEX {};", quote_ident(driver, index))
        }
    }
}

/// インデックス名候補から、識別子として扱いづらい文字を `_` に畳む。クオートは
/// 呼び出し側が行うので、ここでは可読性のための正規化のみ。
fn sanitize_index_name(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, data_type: &str, pk: bool) -> TableColumnInfo {
        TableColumnInfo {
            name: name.to_string(),
            data_type: data_type.to_string(),
            nullable: !pk,
            key: if pk { "PRI".into() } else { String::new() },
            default: None,
            extra: String::new(),
            referenced_table: None,
            referenced_column: None,
        }
    }

    fn idx(name: &str, columns: &[&str], unique: bool, primary: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique,
            primary,
            method: None,
        }
    }

    fn table(name: &str, columns: Vec<TableColumnInfo>, indexes: Vec<IndexInfo>) -> TableMeta {
        TableMeta {
            name: name.to_string(),
            columns,
            indexes,
        }
    }

    fn fk(table: &str, column: &str, ref_table: &str, ref_col: Option<&str>) -> ForeignKey {
        ForeignKey {
            table: table.to_string(),
            column: column.to_string(),
            referenced_table: ref_table.to_string(),
            referenced_column: ref_col.map(|s| s.to_string()),
            constraint_name: None,
        }
    }

    fn unused_supported(entries: Vec<UnusedIndexEntry>) -> UnusedIndexStats {
        UnusedIndexStats {
            supported: true,
            reason: None,
            entries,
        }
    }

    fn unused_off(reason: &str) -> UnusedIndexStats {
        UnusedIndexStats {
            supported: false,
            reason: Some(reason.to_string()),
            entries: Vec::new(),
        }
    }

    fn input(driver: DriverKind, tables: Vec<TableMeta>, fks: Vec<ForeignKey>) -> AdvisorInput {
        AdvisorInput {
            driver,
            tables,
            foreign_keys: fks,
            unused: unused_off("unsupported_driver"),
        }
    }

    fn findings_for(report: &SchemaHealthReport, rule: RuleId) -> Vec<&HealthFinding> {
        report.findings.iter().filter(|f| f.rule == rule).collect()
    }

    // --- ルール 3: PK 欠落 ---

    #[test]
    fn missing_primary_key_detected() {
        let t = table("logs", vec![col("msg", "text", false)], vec![]);
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        let f = findings_for(&report, RuleId::MissingPrimaryKey);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].table, "logs");
        assert!(f[0].fix_ddl.is_none());
    }

    #[test]
    fn primary_key_via_column_key_not_flagged() {
        let t = table("users", vec![col("id", "int", true)], vec![]);
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::MissingPrimaryKey).is_empty());
    }

    #[test]
    fn primary_key_via_index_flag_not_flagged() {
        // key 列が立っていなくても primary インデックスがあれば PK ありとみなす。
        let t = table(
            "t",
            vec![col("id", "int", false)],
            vec![idx("PRIMARY", &["id"], true, true)],
        );
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::MissingPrimaryKey).is_empty());
    }

    #[test]
    fn empty_column_table_not_flagged_for_pk() {
        // 列が取れないもの (取得失敗) は判定対象外。
        let t = table("mystery", vec![], vec![]);
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::MissingPrimaryKey).is_empty());
    }

    // --- ルール 1: FK 列にインデックスが無い ---

    #[test]
    fn fk_without_index_detected_with_create_ddl() {
        let child = table(
            "orders",
            vec![col("id", "int", true), col("user_id", "int", false)],
            vec![idx("PRIMARY", &["id"], true, true)],
        );
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        let f = findings_for(&report, RuleId::FkMissingIndex);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].columns, vec!["user_id"]);
        assert_eq!(f[0].context, vec!["users"]);
        let ddl = f[0].fix_ddl.as_deref().unwrap();
        assert!(ddl.contains("CREATE INDEX"));
        assert!(ddl.contains("`orders`"));
        assert!(ddl.contains("`user_id`"));
    }

    #[test]
    fn fk_with_leading_index_not_flagged() {
        let child = table(
            "orders",
            vec![col("id", "int", true), col("user_id", "int", false)],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("idx_user", &["user_id"], false, false),
            ],
        );
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert!(findings_for(&report, RuleId::FkMissingIndex).is_empty());
    }

    #[test]
    fn fk_covered_by_composite_index_prefix_not_flagged() {
        // (user_id, created) 複合インデックスは FK(user_id) を賄う。
        let child = table(
            "orders",
            vec![
                col("id", "int", true),
                col("user_id", "int", false),
                col("created", "datetime", false),
            ],
            vec![idx("idx_uc", &["user_id", "created"], false, false)],
        );
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert!(findings_for(&report, RuleId::FkMissingIndex).is_empty());
    }

    #[test]
    fn fk_not_covered_when_column_is_not_index_prefix() {
        // (created, user_id) は user_id が先頭でないので FK(user_id) を賄わない。
        let child = table(
            "orders",
            vec![
                col("user_id", "int", false),
                col("created", "datetime", false),
            ],
            vec![idx("idx_cu", &["created", "user_id"], false, false)],
        );
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert_eq!(findings_for(&report, RuleId::FkMissingIndex).len(), 1);
    }

    // --- ルール 2: 重複・冗長インデックス ---

    #[test]
    fn exact_duplicate_index_flags_one_only() {
        let t = table(
            "t",
            vec![col("id", "int", true), col("a", "int", false)],
            vec![
                idx("idx_a1", &["a"], false, false),
                idx("idx_a2", &["a"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        let f = findings_for(&report, RuleId::DuplicateIndex);
        assert_eq!(f.len(), 1, "同一構成の 2 本のうち 1 本だけを指摘する");
        // 名前が後ろの idx_a2 が指摘される。
        assert_eq!(f[0].context[0], "idx_a2");
        assert_eq!(f[0].context[1], "idx_a1");
        assert!(f[0].fix_ddl.as_deref().unwrap().contains("DROP INDEX"));
    }

    #[test]
    fn duplicate_of_unique_flags_the_non_unique_one() {
        let t = table(
            "t",
            vec![col("a", "int", false)],
            vec![
                idx("uq_a", &["a"], true, false),
                idx("idx_a", &["a"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        let f = findings_for(&report, RuleId::DuplicateIndex);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].context[0], "idx_a", "非 UNIQUE 側を指摘する");
    }

    #[test]
    fn prefix_redundant_index_detected() {
        let t = table(
            "t",
            vec![col("a", "int", false), col("b", "int", false)],
            vec![
                idx("idx_a", &["a"], false, false),
                idx("idx_ab", &["a", "b"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        let f = findings_for(&report, RuleId::RedundantIndex);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].context[0], "idx_a");
        assert_eq!(f[0].context[1], "idx_ab");
        // DROP INDEX (PostgreSQL はテーブル指定なし)。
        let ddl = f[0].fix_ddl.as_deref().unwrap();
        assert!(ddl.starts_with("DROP INDEX \"idx_a\""));
    }

    #[test]
    fn prefix_of_unique_index_is_redundant() {
        // (a) は UNIQUE(a,b) のプレフィックスとして冗長。
        let t = table(
            "t",
            vec![col("a", "int", false), col("b", "int", false)],
            vec![
                idx("idx_a", &["a"], false, false),
                idx("uq_ab", &["a", "b"], true, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert_eq!(findings_for(&report, RuleId::RedundantIndex).len(), 1);
    }

    #[test]
    fn unique_index_not_flagged_as_redundant() {
        // UNIQUE(a) は制約を担うので (a,b) があっても DROP 候補にしない。
        let t = table(
            "t",
            vec![col("a", "int", false), col("b", "int", false)],
            vec![
                idx("uq_a", &["a"], true, false),
                idx("idx_ab", &["a", "b"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::RedundantIndex).is_empty());
        assert!(findings_for(&report, RuleId::DuplicateIndex).is_empty());
    }

    #[test]
    fn distinct_indexes_not_flagged() {
        let t = table(
            "t",
            vec![col("a", "int", false), col("b", "int", false)],
            vec![
                idx("idx_a", &["a"], false, false),
                idx("idx_b", &["b"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::DuplicateIndex).is_empty());
        assert!(findings_for(&report, RuleId::RedundantIndex).is_empty());
    }

    // --- ルール 4: 未使用インデックス (統計依存) ---

    #[test]
    fn unused_index_detected_when_supported() {
        let t = table(
            "t",
            vec![col("a", "int", false)],
            vec![idx("idx_a", &["a"], false, false)],
        );
        let mut inp = input(DriverKind::Postgres, vec![t], vec![]);
        inp.unused = unused_supported(vec![UnusedIndexEntry {
            table: "t".into(),
            index: "idx_a".into(),
        }]);
        let report = analyze(&inp);
        let f = findings_for(&report, RuleId::UnusedIndex);
        assert_eq!(f.len(), 1);
        assert!(f[0].statistical, "統計依存フラグが立つ");
        assert_eq!(f[0].columns, vec!["a"]);
        assert!(report.skipped.is_empty());
    }

    #[test]
    fn unused_unique_index_not_flagged() {
        // 統計上未使用でも UNIQUE は制約を担うので DROP を勧めない。
        let t = table(
            "t",
            vec![col("a", "int", false)],
            vec![idx("uq_a", &["a"], true, false)],
        );
        let mut inp = input(DriverKind::Postgres, vec![t], vec![]);
        inp.unused = unused_supported(vec![UnusedIndexEntry {
            table: "t".into(),
            index: "uq_a".into(),
        }]);
        let report = analyze(&inp);
        assert!(findings_for(&report, RuleId::UnusedIndex).is_empty());
    }

    #[test]
    fn unused_rule_skipped_with_reason_when_unsupported() {
        let t = table("t", vec![col("a", "int", true)], vec![]);
        let mut inp = input(DriverKind::Mysql, vec![t], vec![]);
        inp.unused = unused_off("performance_schema_off");
        let report = analyze(&inp);
        assert!(findings_for(&report, RuleId::UnusedIndex).is_empty());
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].rule, RuleId::UnusedIndex);
        assert_eq!(report.skipped[0].reason, "performance_schema_off");
    }

    // --- ルール 5: FK 両端の型不一致 ---

    #[test]
    fn fk_type_mismatch_detected() {
        let child = table(
            "orders",
            vec![col("user_id", "bigint", false)],
            vec![idx("idx_u", &["user_id"], false, false)],
        );
        let parent = table("users", vec![col("id", "int", true)], vec![]);
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child, parent],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        let f = findings_for(&report, RuleId::FkTypeMismatch);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].columns, vec!["user_id"]);
        assert_eq!(f[0].context[0], "bigint");
        assert_eq!(f[0].context[1], "users.id");
        assert_eq!(f[0].context[2], "int");
    }

    #[test]
    fn fk_matching_types_not_flagged() {
        let child = table(
            "orders",
            vec![col("user_id", "int", false)],
            vec![idx("idx_u", &["user_id"], false, false)],
        );
        let parent = table("users", vec![col("id", "int", true)], vec![]);
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child, parent],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert!(findings_for(&report, RuleId::FkTypeMismatch).is_empty());
    }

    #[test]
    fn fk_length_difference_is_not_a_mismatch() {
        // varchar(50) vs varchar(255) は基底型が同じなので JOIN は効く → 不一致にしない。
        let child = table(
            "orders",
            vec![col("code", "varchar(50)", false)],
            vec![idx("idx_c", &["code"], false, false)],
        );
        let parent = table("catalog", vec![col("code", "varchar(255)", true)], vec![]);
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child, parent],
            vec![fk("orders", "code", "catalog", Some("code"))],
        ));
        assert!(findings_for(&report, RuleId::FkTypeMismatch).is_empty());
    }

    #[test]
    fn fk_unsigned_mismatch_detected_on_mysql() {
        let child = table(
            "orders",
            vec![col("user_id", "int unsigned", false)],
            vec![idx("idx_u", &["user_id"], false, false)],
        );
        let parent = table("users", vec![col("id", "int", true)], vec![]);
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![child, parent],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert_eq!(findings_for(&report, RuleId::FkTypeMismatch).len(), 1);
    }

    #[test]
    fn fk_type_mismatch_skipped_when_referenced_column_unresolved() {
        let child = table("orders", vec![col("user_id", "bigint", false)], vec![]);
        let parent = table("users", vec![col("id", "int", true)], vec![]);
        let report = analyze(&input(
            DriverKind::Sqlite,
            vec![child, parent],
            vec![fk("orders", "user_id", "users", None)],
        ));
        assert!(findings_for(&report, RuleId::FkTypeMismatch).is_empty());
    }

    // --- ルール 6: SQLite 整数 PK ヒント ---

    #[test]
    fn sqlite_int_pk_hint_detected() {
        let t = table("t", vec![col("id", "INT", true)], vec![]);
        let report = analyze(&input(DriverKind::Sqlite, vec![t], vec![]));
        let f = findings_for(&report, RuleId::SqliteIntegerPkHint);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].columns, vec!["id"]);
        assert_eq!(f[0].context, vec!["INT"]);
    }

    #[test]
    fn sqlite_integer_pk_not_flagged() {
        let t = table("t", vec![col("id", "INTEGER", true)], vec![]);
        let report = analyze(&input(DriverKind::Sqlite, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::SqliteIntegerPkHint).is_empty());
    }

    #[test]
    fn sqlite_hint_only_for_sqlite_driver() {
        // 同じ INT PK でも MySQL では SQLite 固有ヒントを出さない。
        let t = table("t", vec![col("id", "INT", true)], vec![]);
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::SqliteIntegerPkHint).is_empty());
    }

    #[test]
    fn sqlite_text_pk_not_flagged_as_integer_hint() {
        let t = table("t", vec![col("uuid", "TEXT", true)], vec![]);
        let report = analyze(&input(DriverKind::Sqlite, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::SqliteIntegerPkHint).is_empty());
    }

    // --- 出力の決定性・メタ ---

    #[test]
    fn tables_analyzed_counts_input_tables() {
        let tables = vec![
            table("a", vec![col("id", "int", true)], vec![]),
            table("b", vec![col("id", "int", true)], vec![]),
        ];
        let report = analyze(&input(DriverKind::Mysql, tables, vec![]));
        assert_eq!(report.tables_analyzed, 2);
        assert_eq!(report.driver, DriverKind::Mysql);
    }

    #[test]
    fn findings_sorted_by_table_then_severity() {
        // z テーブルの PK 欠落 (Medium) と a テーブルの FK 欠落 (High) が
        // テーブル名順に並ぶ。
        let a = table(
            "a",
            vec![col("id", "int", true), col("x_id", "int", false)],
            vec![idx("PRIMARY", &["id"], true, true)],
        );
        let z = table("z", vec![col("v", "text", false)], vec![]);
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![z, a],
            vec![fk("a", "x_id", "x", Some("id"))],
        ));
        assert_eq!(report.findings[0].table, "a");
        assert_eq!(report.findings[0].rule, RuleId::FkMissingIndex);
        assert_eq!(report.findings.last().unwrap().table, "z");
    }
}
