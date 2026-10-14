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
    /// `fix_ddl` の**オンライン版** (#1534)。大きな本番テーブルでは通常の `CREATE INDEX` /
    /// `DROP INDEX` が書き込みを止めるロックを長く取りうるため、書き込みを止めにくい形を並べて
    /// 提示し、利用者が選べるようにする (エディタへ挿入するだけで、自動実行はしない)。
    /// - PostgreSQL: `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`。**トランザクション
    ///   ブロックの中では実行できない** (他の文と一緒に流さない・明示トランザクションを開いたまま
    ///   実行しない)。失敗すると無効 (`INVALID`) なインデックスが残りうる。
    /// - MySQL: `ALTER TABLE … ADD/DROP INDEX …, ALGORITHM=INPLACE, LOCK=NONE`。サーバが
    ///   その方式で実行できないときは変更せずにエラーで止まる。
    /// - SQLite: テーブル全体のロックが前提でオンライン版は無いため `None`。
    ///
    /// `fix_ddl` が `None` のルール、および SQLite では `None`。
    pub fix_ddl_online: Option<String>,
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
    /// テーブルごとの**まとめ DDL** (#1540)。同じテーブルに 2 件以上の「機械的に直せる」指摘
    /// (FK インデックス欠落・重複 / 冗長インデックス) があるときだけ、1 つの修正計画に束ねて返す。
    /// 統計依存の指摘 (未使用インデックス) は観測期間に左右されるため含めない。
    #[serde(default)]
    pub table_plans: Vec<TableFixPlan>,
}

/// 1 テーブルぶんの修正 DDL のまとめ (#1540)。各指摘の `fix_ddl` を連結しただけでなく、
/// 方言が許す範囲で 1 文に束ねる (MySQL は 1 本の `ALTER TABLE`、PostgreSQL は複数インデックスの
/// 1 本の `DROP INDEX`)。実行はせず、エディタへ挿入するための文字列。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableFixPlan {
    pub table: String,
    /// まとめに含まれる変更 (インデックスの追加・削除) の件数。重複を除いた数。
    pub change_count: usize,
    /// 標準版 (各指摘の `fix_ddl` 相当をまとめたもの)。
    pub ddl: String,
    /// オンライン版 (`fix_ddl_online` 相当、#1534)。SQLite では `None`。
    pub ddl_online: Option<String>,
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

    let table_plans = build_table_plans(input.driver, &findings);

    SchemaHealthReport {
        driver: input.driver,
        tables_analyzed: input.tables.len(),
        findings,
        skipped,
        table_plans,
    }
}

/// まとめ DDL に入れる 1 件の変更 (#1540)。
#[derive(Debug, Clone, PartialEq, Eq)]
enum FixAction {
    /// FK 列にインデックスを張る。
    CreateIndex { columns: Vec<String> },
    /// インデックスを落とす。
    DropIndex { name: String },
}

/// 指摘から、まとめ DDL に入れられる変更を取り出す。統計依存の指摘・設計判断を要する指摘は `None`。
fn fix_action_of(f: &HealthFinding) -> Option<FixAction> {
    if f.statistical || f.fix_ddl.is_none() {
        return None;
    }
    match f.rule {
        RuleId::FkMissingIndex if !f.columns.is_empty() => Some(FixAction::CreateIndex {
            columns: f.columns.clone(),
        }),
        RuleId::DuplicateIndex | RuleId::RedundantIndex => f
            .context
            .first()
            .map(|name| FixAction::DropIndex { name: name.clone() }),
        _ => None,
    }
}

/// 指摘の集合から、2 件以上の変更があるテーブルごとにまとめ DDL を組み立てる。`findings` は
/// テーブル順に並んでいる前提 (`analyze` が整列済み)。出力順はテーブル名順。
fn build_table_plans(driver: DriverKind, findings: &[HealthFinding]) -> Vec<TableFixPlan> {
    let mut plans = Vec::new();
    let mut i = 0;
    while i < findings.len() {
        let table = &findings[i].table;
        let mut j = i;
        while j < findings.len() && findings[j].table == *table {
            j += 1;
        }
        let actions: Vec<FixAction> = findings[i..j].iter().filter_map(fix_action_of).collect();
        if let Some(plan) = combine_fixes(driver, table, &actions) {
            plans.push(plan);
        }
        i = j;
    }
    plans
}

/// 1 テーブルの変更列を方言ごとの DDL に束ねる純関数。重複する変更 (同じインデックスの
/// 二重 DROP・同じ列の二重 CREATE) は 1 件に畳み、畳んだ後の変更が 2 件未満なら `None`
/// (単独なら各指摘の `fix_ddl` で足りる)。DROP を先、CREATE を後に並べる。
fn combine_fixes(driver: DriverKind, table: &str, actions: &[FixAction]) -> Option<TableFixPlan> {
    let mut drops: Vec<&str> = Vec::new();
    let mut creates: Vec<&[String]> = Vec::new();
    for a in actions {
        match a {
            FixAction::DropIndex { name } => {
                if !drops.iter().any(|d| d.eq_ignore_ascii_case(name)) {
                    drops.push(name);
                }
            }
            FixAction::CreateIndex { columns } => {
                let lower = |cols: &[String]| -> Vec<String> {
                    cols.iter().map(|c| c.to_lowercase()).collect()
                };
                if !creates.iter().any(|c| lower(c) == lower(columns)) {
                    creates.push(columns);
                }
            }
        }
    }
    let change_count = drops.len() + creates.len();
    if change_count < 2 {
        return None;
    }

    let qt = quote_ident(driver, table);
    let (ddl, ddl_online) = match driver {
        DriverKind::Mysql => {
            // 1 本の ALTER TABLE に束ねる。追加と削除が同じ文なので、FK が頼る唯一のインデックスを
            // 冗長として落としつつ新しく張る、といった入れ替えも途中で FK が裸にならない。
            let mut parts: Vec<String> = drops
                .iter()
                .map(|d| format!("DROP INDEX {}", quote_ident(driver, d)))
                .collect();
            for cols in &creates {
                let (name, list) = quoted_index_parts(driver, table, cols);
                parts.push(format!("ADD INDEX {name} ({list})"));
            }
            let body = parts.join(",\n  ");
            (
                format!("ALTER TABLE {qt}\n  {body};"),
                Some(format!(
                    "ALTER TABLE {qt}\n  {body},\n  ALGORITHM=INPLACE, LOCK=NONE;"
                )),
            )
        }
        DriverKind::Postgres => {
            let mut std_lines: Vec<String> = Vec::new();
            let mut online_lines: Vec<String> = Vec::new();
            if !drops.is_empty() {
                // 標準版は複数インデックスを 1 本の DROP INDEX にできる。CONCURRENTLY は
                // 1 本ずつしか指定できないので、オンライン版は分ける。
                let names = drops
                    .iter()
                    .map(|d| quote_ident(driver, d))
                    .collect::<Vec<_>>()
                    .join(", ");
                std_lines.push(format!("DROP INDEX {names};"));
                for d in &drops {
                    online_lines.push(format!(
                        "DROP INDEX CONCURRENTLY {};",
                        quote_ident(driver, d)
                    ));
                }
            }
            for cols in &creates {
                std_lines.push(create_index_ddl(driver, table, cols));
                if let Some(o) = create_index_online_ddl(driver, table, cols) {
                    online_lines.push(o);
                }
            }
            (std_lines.join("\n"), Some(online_lines.join("\n")))
        }
        DriverKind::Sqlite => {
            // SQLite の DROP INDEX は 1 本ずつ。オンライン版は無い。
            let mut lines: Vec<String> = drops
                .iter()
                .map(|d| drop_index_ddl(driver, table, d))
                .collect();
            lines.extend(creates.iter().map(|c| create_index_ddl(driver, table, c)));
            (lines.join("\n"), None)
        }
    };
    Some(TableFixPlan {
        table: table.to_string(),
        change_count,
        ddl,
        ddl_online,
    })
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
        fix_ddl_online: None,
        statistical: false,
    });
}

/// インデックスの構成列を小文字化して返す (比較用)。式インデックス等で列が
/// 空のものは呼び出し側が弾く。
fn lower_cols(idx: &IndexInfo) -> Vec<String> {
    idx.columns.iter().map(|c| c.to_lowercase()).collect()
}

/// インデックスのアクセスメソッドを比較用に正規化する。`method` が無い (SQLite 等) か
/// `btree` なら `btree`。hash / gin / gist / fulltext / spatial などは btree と別物で、
/// 先頭列だけの範囲検索・ORDER BY・前方一致を賄えないため、btree と同一視しない。
fn index_method(idx: &IndexInfo) -> String {
    idx.method
        .as_deref()
        .map(|m| m.trim().to_lowercase())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "btree".to_string())
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
        // 式インデックスは `columns` に式の列が積まれず、列だけの比較は別物を同一視する。
        if x.primary || x.unique || x.columns.is_empty() || x.first_expression_at.is_some() {
            continue;
        }
        let xcols = lower_cols(x);

        // 完全一致の重複。相手が PRIMARY/UNIQUE か、名前が自分より前のときのみ
        // フラグする → 同一構成の非 UNIQUE インデックス 2 本のうち 1 本だけを
        // 指摘する (両方消える誤誘導を避ける)。
        // 部分インデックスは述語が同じものどうしだけを重複とみなす (述語が違えば別の行集合を担う)。
        if let Some(dup) = indexes.iter().find(|y| {
            y.name != x.name
                && y.first_expression_at.is_none()
                && y.predicate == x.predicate
                && index_method(y) == index_method(x)
                && lower_cols(y) == xcols
                && (y.primary || y.unique || y.name < x.name)
        }) {
            out.push(HealthFinding {
                rule: RuleId::DuplicateIndex,
                severity: Severity::Medium,
                table: table.name.clone(),
                columns: x.columns.clone(),
                context: vec![x.name.clone(), dup.name.clone()],
                fix_ddl: Some(drop_index_ddl(driver, &table.name, &x.name)),
                fix_ddl_online: drop_index_online_ddl(driver, &table.name, &x.name),
                statistical: false,
            });
            continue;
        }

        // プレフィックス冗長: x の列列が別インデックス y の真のプレフィックス。
        // y は PRIMARY/UNIQUE を含む任意のインデックスでよい (より長いインデックスは
        // その先頭列でのルックアップを賄う)。
        // y が部分インデックスなら、x と同じ述語のときだけ x の行を全て含む (非部分 y は常に包含)。
        if let Some(cov) = indexes.iter().find(|y| {
            y.name != x.name
                && y.first_expression_at.is_none()
                && (y.predicate.is_none() || y.predicate == x.predicate)
                && y.columns.len() > x.columns.len()
                // 先頭列の包含は btree 同士のときだけ成り立つ (複合 hash / GIN は先頭列だけでは引けない)。
                && index_method(x) == "btree"
                && index_method(y) == "btree"
                && lower_cols(y).starts_with(&xcols)
        }) {
            out.push(HealthFinding {
                rule: RuleId::RedundantIndex,
                severity: Severity::Low,
                table: table.name.clone(),
                columns: x.columns.clone(),
                context: vec![x.name.clone(), cov.name.clone()],
                fix_ddl: Some(drop_index_ddl(driver, &table.name, &x.name)),
                fix_ddl_online: drop_index_online_ddl(driver, &table.name, &x.name),
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
        // 部分インデックスは一部の行しか持たないので数えない。式インデックスは、先頭から最初の
        // 式キーの手前までの実列だけで前方一致を判定する (`(user_id, lower(name))` は
        // `user_id` の FK を賄う)。
        let covered = table.indexes.iter().any(|idx| {
            let real = idx
                .first_expression_at
                .map_or(idx.columns.len(), |n| n.min(idx.columns.len()));
            idx.predicate.is_none()
                && real >= fk_cols.len()
                && lower_cols(idx)
                    .get(..real)
                    .is_some_and(|c| c.starts_with(&fk_cols))
        });
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
            fix_ddl_online: create_index_online_ddl(input.driver, &group.table, &group.columns),
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
            fix_ddl_online: None,
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
    // SQLite の型は宣言名ではなく型親和性で決まる (`INT` / `BIGINT` / `INTEGER` はどれも
    // INTEGER 親和性で、暗黙変換もインデックスの効きも変わらない)。
    if driver == DriverKind::Sqlite {
        return sqlite_affinity(a) == sqlite_affinity(b);
    }
    if driver == DriverKind::Postgres {
        return pg_type_family(a) == pg_type_family(b);
    }
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

/// SQLite の型親和性 (公式の判定規則を上から順に適用する)。
fn sqlite_affinity(t: &str) -> &'static str {
    let u = t.to_uppercase();
    if u.contains("INT") {
        "INTEGER"
    } else if u.contains("CHAR") || u.contains("CLOB") || u.contains("TEXT") {
        "TEXT"
    } else if u.contains("BLOB") || u.trim().is_empty() {
        "BLOB"
    } else if u.contains("REAL") || u.contains("FLOA") || u.contains("DOUB") {
        "REAL"
    } else {
        "NUMERIC"
    }
}

/// PostgreSQL の型名を、暗黙変換とインデックスの効きが同じ「型ファミリ」に正規化する。
/// `information_schema` の型名は `character varying` / `timestamp with time zone` のような
/// 複数語なので、先頭語だけでは `text` と `varchar(n)` を取り違え、`timestamp` と
/// `timestamptz` を同一視してしまう。長さ・精度 (`(n)` / `(p,s)`) は無視する。
fn pg_type_family(t: &str) -> String {
    let mut stripped = String::new();
    let mut depth = 0usize;
    for c in t.to_lowercase().chars() {
        match c {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ if depth == 0 => stripped.push(c),
            _ => {}
        }
    }
    let norm = stripped.split_whitespace().collect::<Vec<_>>().join(" ");
    match norm.as_str() {
        // text / varchar は同じ演算子族 (text_ops) で相互に索引が効く。
        "text" | "character varying" | "varchar" => "text".to_string(),
        // char(n) (bpchar) は別の演算子族 (bpchar_ops) で、text と比べると索引が効かない。
        "character" | "char" | "bpchar" => "bpchar".to_string(),
        "timestamp with time zone" | "timestamptz" => "timestamptz".to_string(),
        "timestamp without time zone" | "timestamp" => "timestamp".to_string(),
        "time with time zone" | "timetz" => "timetz".to_string(),
        "time without time zone" | "time" => "time".to_string(),
        "integer" | "int" | "int4" => "integer".to_string(),
        "bigint" | "int8" => "bigint".to_string(),
        "smallint" | "int2" => "smallint".to_string(),
        "double precision" | "float8" => "double precision".to_string(),
        "real" | "float4" => "real".to_string(),
        "numeric" | "decimal" => "numeric".to_string(),
        "boolean" | "bool" => "boolean".to_string(),
        _ => norm,
    }
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
            fix_ddl_online: drop_index_online_ddl(input.driver, &entry.table, &entry.index),
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
            fix_ddl_online: None,
            statistical: false,
        });
    }
}

/// FK 列に張るインデックスの (クオート済み名, クオート済み列リスト)。
fn quoted_index_parts(driver: DriverKind, table: &str, columns: &[String]) -> (String, String) {
    let idx_name = fit_index_name(
        driver,
        sanitize_index_name(&format!("idx_{}_{}", table, columns.join("_"))),
    );
    let cols = columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    (quote_ident(driver, &idx_name), cols)
}

/// FK 列に張る `CREATE INDEX` を生成する。インデックス名は `idx_<table>_<cols>`。
/// 識別子は方言でクオートする。ユーザはエディタで確認してから実行する。
fn create_index_ddl(driver: DriverKind, table: &str, columns: &[String]) -> String {
    let (name, cols) = quoted_index_parts(driver, table, columns);
    format!(
        "CREATE INDEX {} ON {} ({});",
        name,
        quote_ident(driver, table),
        cols
    )
}

/// [`create_index_ddl`] のオンライン版 (#1534)。PostgreSQL は `CREATE INDEX CONCURRENTLY`
/// (トランザクション外で実行する必要がある)、MySQL は `ALGORITHM=INPLACE, LOCK=NONE`。
/// SQLite は `None`。
fn create_index_online_ddl(driver: DriverKind, table: &str, columns: &[String]) -> Option<String> {
    let (name, cols) = quoted_index_parts(driver, table, columns);
    match driver {
        DriverKind::Postgres => Some(format!(
            "CREATE INDEX CONCURRENTLY {} ON {} ({});",
            name,
            quote_ident(driver, table),
            cols
        )),
        DriverKind::Mysql => Some(format!(
            "ALTER TABLE {} ADD INDEX {} ({}), ALGORITHM=INPLACE, LOCK=NONE;",
            quote_ident(driver, table),
            name,
            cols
        )),
        DriverKind::Sqlite => None,
    }
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

/// [`drop_index_ddl`] のオンライン版 (#1534)。PostgreSQL は `DROP INDEX CONCURRENTLY`
/// (トランザクション外で実行する必要がある)、MySQL は `ALGORITHM=INPLACE, LOCK=NONE`。
/// SQLite は `None`。
fn drop_index_online_ddl(driver: DriverKind, table: &str, index: &str) -> Option<String> {
    match driver {
        DriverKind::Postgres => Some(format!(
            "DROP INDEX CONCURRENTLY {};",
            quote_ident(driver, index)
        )),
        DriverKind::Mysql => Some(format!(
            "ALTER TABLE {} DROP INDEX {}, ALGORITHM=INPLACE, LOCK=NONE;",
            quote_ident(driver, table),
            quote_ident(driver, index)
        )),
        DriverKind::Sqlite => None,
    }
}

/// 生成したインデックス名が方言の識別子長の上限 (MySQL 64 文字 / PostgreSQL 63 バイト) を
/// 超えるとき、先頭を切り詰めて末尾に元の名前のハッシュ (8 桁 hex) を付けて収める。
/// 名前は `sanitize_index_name` 済みの ASCII。SQLite に上限は無い。
fn fit_index_name(driver: DriverKind, name: String) -> String {
    const LIMIT: usize = 63;
    if driver == DriverKind::Sqlite || name.len() <= LIMIT {
        return name;
    }
    // FNV-1a (32bit)。同じ入力から常に同じ名前になる。
    let hash = name.bytes().fold(0x811c_9dc5_u32, |h, b| {
        (h ^ u32::from(b)).wrapping_mul(0x0100_0193)
    });
    let keep = LIMIT - 9;
    format!("{}_{hash:08x}", &name[..keep])
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
            comment: None,
        }
    }

    fn idx(name: &str, columns: &[&str], unique: bool, primary: bool) -> IndexInfo {
        IndexInfo {
            name: name.to_string(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            unique,
            primary,
            method: None,
            predicate: None,
            first_expression_at: None,
            ..Default::default()
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
            on_delete: None,
            on_update: None,
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

    fn partial(mut i: IndexInfo, pred: &str) -> IndexInfo {
        i.predicate = Some(pred.to_string());
        i
    }

    fn with_method(mut i: IndexInfo, method: &str) -> IndexInfo {
        i.method = Some(method.to_string());
        i
    }

    #[test]
    fn different_index_methods_are_not_duplicates() {
        let t = table(
            "t",
            vec![col("a", "int", false)],
            vec![
                with_method(idx("idx_z", &["a"], false, false), "btree"),
                with_method(idx("idx_a", &["a"], false, false), "hash"),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::DuplicateIndex).is_empty());
    }

    #[test]
    fn same_index_method_is_still_duplicate_and_none_means_btree() {
        let t = table(
            "t",
            vec![col("a", "int", false)],
            vec![
                with_method(idx("idx_a", &["a"], false, false), "BTREE"),
                idx("idx_b", &["a"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Mysql, vec![t], vec![]));
        assert_eq!(findings_for(&report, RuleId::DuplicateIndex).len(), 1);
    }

    #[test]
    fn composite_hash_index_does_not_make_a_btree_prefix_redundant() {
        let t = table(
            "t",
            vec![col("a", "int", false), col("b", "int", false)],
            vec![
                idx("idx_a", &["a"], false, false),
                with_method(idx("idx_ab", &["a", "b"], false, false), "gin"),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::RedundantIndex).is_empty());
    }

    #[test]
    fn postgres_text_and_varchar_are_compatible_but_timestamp_and_timestamptz_are_not() {
        assert!(types_compatible(
            DriverKind::Postgres,
            "text",
            "character varying"
        ));
        assert!(types_compatible(
            DriverKind::Postgres,
            "character varying(20)",
            "text"
        ));
        assert!(!types_compatible(
            DriverKind::Postgres,
            "timestamp without time zone",
            "timestamp with time zone"
        ));
        assert!(types_compatible(
            DriverKind::Postgres,
            "timestamp with time zone",
            "timestamptz"
        ));
        assert!(types_compatible(
            DriverKind::Postgres,
            "text",
            "character varying(20)"
        ));
        assert!(!types_compatible(
            DriverKind::Postgres,
            "text",
            "character(5)"
        ));
        assert!(!types_compatible(DriverKind::Postgres, "integer", "bigint"));
        assert!(types_compatible(
            DriverKind::Postgres,
            "numeric(10,2)",
            "numeric(12,4)"
        ));
    }

    #[test]
    fn partial_indexes_with_different_predicates_are_not_duplicates() {
        let t = table(
            "orders",
            vec![col("id", "int", true), col("status", "text", false)],
            vec![
                idx("PRIMARY", &["id"], true, true),
                partial(idx("i1", &["status"], false, false), "deleted_at IS NULL"),
                partial(idx("i2", &["status"], false, false), "archived"),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::DuplicateIndex).is_empty());
    }

    #[test]
    fn partial_indexes_with_same_predicate_are_duplicates() {
        let t = table(
            "orders",
            vec![col("id", "int", true), col("status", "text", false)],
            vec![
                idx("PRIMARY", &["id"], true, true),
                partial(idx("i1", &["status"], false, false), "archived"),
                partial(idx("i2", &["status"], false, false), "archived"),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert_eq!(findings_for(&report, RuleId::DuplicateIndex).len(), 1);
    }

    #[test]
    fn partial_index_does_not_cover_a_prefix_index() {
        // 部分インデックス (a, b) は非部分インデックス (a) の行を全ては持たない。
        let t = table(
            "t",
            vec![
                col("id", "int", true),
                col("a", "int", false),
                col("b", "int", false),
            ],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("i_a", &["a"], false, false),
                partial(idx("i_ab", &["a", "b"], false, false), "b > 0"),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::RedundantIndex).is_empty());
    }

    #[test]
    fn expression_index_is_not_treated_as_its_plain_columns() {
        let mut expr = idx("i_expr", &["b"], false, false);
        expr.first_expression_at = Some(0); // (lower(a), b)
        let t = table(
            "t",
            vec![col("id", "int", true), col("b", "int", false)],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("i_b", &["b"], false, false),
                expr,
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        assert!(findings_for(&report, RuleId::DuplicateIndex).is_empty());
    }

    #[test]
    fn expression_index_covers_fk_by_its_leading_real_columns() {
        // (user_id, lower(name)): 先頭の実列 user_id だけで FK を賄う。
        let mut covering = idx("i_u_expr", &["user_id"], false, false);
        covering.first_expression_at = Some(1);
        // (lower(name), user_id): 式が先頭なので user_id の FK は賄えない。
        let mut not_covering = idx("i_expr_u", &["user_id"], false, false);
        not_covering.first_expression_at = Some(0);
        let mk = |index: IndexInfo| {
            table(
                "orders",
                vec![col("id", "int", true), col("user_id", "int", false)],
                vec![idx("PRIMARY", &["id"], true, true), index],
            )
        };
        let f = vec![fk("orders", "user_id", "users", Some("id"))];
        let ok = analyze(&input(DriverKind::Postgres, vec![mk(covering)], f.clone()));
        assert!(findings_for(&ok, RuleId::FkMissingIndex).is_empty());
        let ng = analyze(&input(DriverKind::Postgres, vec![mk(not_covering)], f));
        assert_eq!(findings_for(&ng, RuleId::FkMissingIndex).len(), 1);
    }

    #[test]
    fn sqlite_fk_types_compare_by_affinity() {
        let parent = table(
            "users",
            vec![col("id", "INTEGER", true)],
            vec![idx("pk", &["id"], true, true)],
        );
        let child = table(
            "orders",
            vec![col("id", "INTEGER", true), col("user_id", "BIGINT", false)],
            vec![
                idx("pk", &["id"], true, true),
                idx("i_u", &["user_id"], false, false),
            ],
        );
        let report = analyze(&input(
            DriverKind::Sqlite,
            vec![parent, child],
            vec![fk("orders", "user_id", "users", Some("id"))],
        ));
        assert!(findings_for(&report, RuleId::FkTypeMismatch).is_empty());
        assert_eq!(sqlite_affinity("VARCHAR(50)"), "TEXT");
        assert_eq!(sqlite_affinity("DOUBLE"), "REAL");
        assert_ne!(sqlite_affinity("TEXT"), sqlite_affinity("INTEGER"));
    }

    #[test]
    fn online_ddl_is_offered_per_driver_alongside_the_plain_ddl() {
        let cols = vec!["user_id".to_string()];
        assert_eq!(
            create_index_online_ddl(DriverKind::Postgres, "orders", &cols).as_deref(),
            Some("CREATE INDEX CONCURRENTLY \"idx_orders_user_id\" ON \"orders\" (\"user_id\");")
        );
        assert_eq!(
            create_index_online_ddl(DriverKind::Mysql, "orders", &cols).as_deref(),
            Some("ALTER TABLE `orders` ADD INDEX `idx_orders_user_id` (`user_id`), ALGORITHM=INPLACE, LOCK=NONE;")
        );
        assert!(create_index_online_ddl(DriverKind::Sqlite, "orders", &cols).is_none());
        assert_eq!(
            drop_index_online_ddl(DriverKind::Postgres, "orders", "idx_a").as_deref(),
            Some("DROP INDEX CONCURRENTLY \"idx_a\";")
        );
        assert_eq!(
            drop_index_online_ddl(DriverKind::Mysql, "orders", "idx_a").as_deref(),
            Some("ALTER TABLE `orders` DROP INDEX `idx_a`, ALGORITHM=INPLACE, LOCK=NONE;")
        );
        assert!(drop_index_online_ddl(DriverKind::Sqlite, "orders", "idx_a").is_none());
    }

    #[test]
    fn fk_finding_carries_the_online_variant_for_server_drivers_only() {
        let orders = table(
            "orders",
            vec![col("id", "int", true), col("user_id", "int", false)],
            vec![idx("PRIMARY", &["id"], true, true)],
        );
        let f = vec![fk("orders", "user_id", "users", Some("id"))];
        for (driver, online) in [
            (DriverKind::Mysql, true),
            (DriverKind::Postgres, true),
            (DriverKind::Sqlite, false),
        ] {
            let report = analyze(&input(driver, vec![orders.clone()], f.clone()));
            let found = findings_for(&report, RuleId::FkMissingIndex);
            assert_eq!(found.len(), 1);
            assert!(found[0].fix_ddl.is_some());
            assert_eq!(found[0].fix_ddl_online.is_some(), online, "{driver:?}");
        }
    }

    #[test]
    fn long_index_names_are_shortened_for_mysql_and_postgres() {
        let ddl = create_index_ddl(
            DriverKind::Mysql,
            "customer_subscription_invoice_line_items",
            &["subscription_invoice_id".to_string()],
        );
        let name = ddl.split('`').nth(1).unwrap();
        assert!(name.len() <= 63, "{name}");
        // 同じ入力なら同じ名前、短い名前はそのまま、SQLite は切り詰めない。
        assert_eq!(
            ddl,
            create_index_ddl(
                DriverKind::Mysql,
                "customer_subscription_invoice_line_items",
                &["subscription_invoice_id".to_string()],
            )
        );
        assert_eq!(
            create_index_ddl(DriverKind::Mysql, "t", &["c".to_string()]),
            "CREATE INDEX `idx_t_c` ON `t` (`c`);"
        );
        let sqlite = create_index_ddl(
            DriverKind::Sqlite,
            "customer_subscription_invoice_line_items",
            &["subscription_invoice_id".to_string()],
        );
        assert!(
            sqlite.contains("idx_customer_subscription_invoice_line_items_subscription_invoice_id")
        );
    }

    // --- #1540: テーブル単位のまとめ DDL ---

    fn fk_named(table: &str, column: &str, ref_table: &str, name: &str) -> ForeignKey {
        ForeignKey {
            constraint_name: Some(name.to_string()),
            ..fk(table, column, ref_table, Some("id"))
        }
    }

    /// FK 2 本が未インデックス + 重複インデックス 1 本を持つ `orders` テーブル。
    fn messy_orders() -> AdvisorInput {
        let t = table(
            "orders",
            vec![
                col("id", "int", true),
                col("user_id", "int", false),
                col("shop_id", "int", false),
                col("a", "int", false),
            ],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("idx_a", &["a"], false, false),
                idx("idx_a_dup", &["a"], false, false),
            ],
        );
        input(
            DriverKind::Mysql,
            vec![t],
            vec![
                fk_named("orders", "user_id", "users", "fk_u"),
                fk_named("orders", "shop_id", "shops", "fk_s"),
            ],
        )
    }

    #[test]
    fn mysql_plan_merges_everything_into_one_alter_table() {
        let report = analyze(&messy_orders());
        assert_eq!(report.table_plans.len(), 1);
        let plan = &report.table_plans[0];
        assert_eq!(plan.table, "orders");
        assert_eq!(plan.change_count, 3);
        assert_eq!(
            plan.ddl,
            "ALTER TABLE `orders`\n  DROP INDEX `idx_a_dup`,\n  ADD INDEX `idx_orders_shop_id` (`shop_id`),\n  ADD INDEX `idx_orders_user_id` (`user_id`);"
        );
        assert_eq!(
            plan.ddl_online.as_deref(),
            Some(
                "ALTER TABLE `orders`\n  DROP INDEX `idx_a_dup`,\n  ADD INDEX `idx_orders_shop_id` (`shop_id`),\n  ADD INDEX `idx_orders_user_id` (`user_id`),\n  ALGORITHM=INPLACE, LOCK=NONE;"
            )
        );
    }

    #[test]
    fn postgres_plan_merges_drops_and_keeps_creates_separate() {
        let mut i = messy_orders();
        i.driver = DriverKind::Postgres;
        let plan = &analyze(&i).table_plans[0];
        assert_eq!(
            plan.ddl,
            "DROP INDEX \"idx_a_dup\";\nCREATE INDEX \"idx_orders_shop_id\" ON \"orders\" (\"shop_id\");\nCREATE INDEX \"idx_orders_user_id\" ON \"orders\" (\"user_id\");"
        );
        // CONCURRENTLY は 1 本ずつ。
        let online = plan.ddl_online.as_deref().unwrap_or_default();
        assert!(online.starts_with("DROP INDEX CONCURRENTLY \"idx_a_dup\";"));
        assert!(online.contains("CREATE INDEX CONCURRENTLY \"idx_orders_user_id\""));
    }

    #[test]
    fn postgres_plan_joins_several_drops_into_one_statement_but_not_online() {
        let t = table(
            "t",
            vec![
                col("id", "int", true),
                col("a", "int", false),
                col("b", "int", false),
            ],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("i_a", &["a"], false, false),
                idx("i_a2", &["a"], false, false),
                idx("i_ab", &["a", "b"], false, false),
            ],
        );
        let report = analyze(&input(DriverKind::Postgres, vec![t], vec![]));
        // i_a2 は i_a の重複、i_a / i_a2 は i_ab のプレフィックス冗長。
        let plan = &report.table_plans[0];
        assert!(plan.ddl.starts_with("DROP INDEX "));
        assert!(plan.ddl.contains("\"i_a\", \"i_a2\"") || plan.ddl.contains("\"i_a2\", \"i_a\""));
        let online = plan.ddl_online.clone().unwrap_or_default();
        assert_eq!(online.matches("DROP INDEX CONCURRENTLY").count(), 2);
    }

    #[test]
    fn sqlite_plan_has_one_statement_per_change_and_no_online_variant() {
        let mut i = messy_orders();
        i.driver = DriverKind::Sqlite;
        let plan = &analyze(&i).table_plans[0];
        assert_eq!(plan.ddl.lines().count(), 3);
        assert!(plan.ddl.starts_with("DROP INDEX \"idx_a_dup\";"));
        assert!(plan.ddl_online.is_none());
    }

    #[test]
    fn single_change_gets_no_plan() {
        let t = table(
            "orders",
            vec![col("id", "int", true), col("user_id", "int", false)],
            vec![idx("PRIMARY", &["id"], true, true)],
        );
        let report = analyze(&input(
            DriverKind::Mysql,
            vec![t],
            vec![fk_named("orders", "user_id", "users", "fk_u")],
        ));
        assert_eq!(report.findings.len(), 1);
        assert!(report.table_plans.is_empty());
    }

    #[test]
    fn plans_are_per_table_and_statistical_findings_are_left_out() {
        let t1 = messy_orders().tables.remove(0);
        let t2 = table(
            "zeta",
            vec![col("id", "int", true), col("x", "int", false)],
            vec![
                idx("PRIMARY", &["id"], true, true),
                idx("i_x", &["x"], false, false),
            ],
        );
        let mut i = messy_orders();
        i.tables = vec![t1, t2];
        i.unused = unused_supported(vec![UnusedIndexEntry {
            table: "zeta".into(),
            index: "i_x".into(),
        }]);
        let report = analyze(&i);
        // zeta には統計依存の未使用インデックス 1 件だけ → まとめ対象外。
        assert!(findings_for(&report, RuleId::UnusedIndex).len() == 1);
        assert_eq!(report.table_plans.len(), 1);
        assert_eq!(report.table_plans[0].table, "orders");
    }

    #[test]
    fn duplicate_actions_are_collapsed() {
        let actions = vec![
            FixAction::DropIndex { name: "a".into() },
            FixAction::DropIndex { name: "A".into() },
            FixAction::CreateIndex {
                columns: vec!["x".into()],
            },
            FixAction::CreateIndex {
                columns: vec!["X".into()],
            },
        ];
        let plan = combine_fixes(DriverKind::Mysql, "t", &actions);
        assert_eq!(plan.map(|p| p.change_count), Some(2));
        // 畳んだ結果が 1 件なら計画を作らない。
        let one = vec![
            FixAction::DropIndex { name: "a".into() },
            FixAction::DropIndex { name: "a".into() },
        ];
        assert!(combine_fixes(DriverKind::Mysql, "t", &one).is_none());
    }

    #[test]
    fn plan_quotes_hostile_identifiers() {
        let actions = vec![
            FixAction::DropIndex {
                name: "we`ird".into(),
            },
            FixAction::CreateIndex {
                columns: vec!["c`ol".into()],
            },
        ];
        let plan = combine_fixes(DriverKind::Mysql, "ta`ble", &actions).map(|p| p.ddl);
        let ddl = plan.unwrap_or_default();
        assert!(ddl.contains("`ta``ble`"));
        assert!(ddl.contains("DROP INDEX `we``ird`"));
        assert!(ddl.contains("(`c``ol`)"));
    }
}
