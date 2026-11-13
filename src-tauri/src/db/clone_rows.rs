//! 行を子レコードごと同じ DB 内に複製する (#2304) の純粋層。
//!
//! 行の収集は `db::subset::SubsetWalk` を子の方向だけで動かす (親は辿らない)。ここは、集めた行を
//! 新しいキーで INSERT するための判断だけを持ち、I/O は持たない。実 DB での駆動は
//! `commands::clone_rows`。
//!
//! ## 複製の規則
//!
//! - **複製した行どうしの参照だけを新しいキーへ張り替える。** 子の行の外部キーが、複製した親の行を
//!   指していれば新しい親のキーに替え、複製に含まれない行 (外部への参照。例: `product_id`) は
//!   元の値のまま残す。中間表・自己参照・複合キーも同じ規則 ([`FkRemap`])。
//! - **キーの生成方針は列ごと。** 主キーの列は、自動採番 (既定) / SQL の式 / 上書き値のどれか
//!   ([`KeyRule`])。どれでもなく、参照の張り替えも無い主キーは複製しても元の行と衝突するので、
//!   実行前にエラーにする ([`TableReport::needs_policy`])。
//! - **UNIQUE の衝突は実行前に見つける** ([`UniqueConflict`])。元の値のまま複製される列だけで
//!   できた UNIQUE インデックスは、必ず元の行と衝突する。式の結果 (実行しないと分からない) と
//!   張り替えで値が変わる列を含むインデックスは検査しない (実行時に DB が検出する)。

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use super::data_diff::{is_binary_type, is_hex_wire, is_numeric_literal, key_signature};
use super::subset::{is_integer_type, loose_signature, SubsetEdge, SubsetTable};
use super::sync::quote_ident;
use super::types::Value;
use super::DriverKind;
use crate::error::{AppError, Result};

/// 複製する行数の上限 (1 行ごとに DB へ往復するため、抽出より低い)。
pub const MAX_CLONE_ROWS: u64 = 10_000;
/// 式の最大文字数。
pub const MAX_EXPRESSION_LEN: usize = 500;
/// 式の中で元の値のリテラルに置き換えられる記号。
pub const OLD_PLACEHOLDER: &str = "{old}";

/// 列の値の作り方 (自動採番以外)。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KeyRule {
    /// SQL の式 (`gen_random_uuid()` / `UUID()` / `lower(hex(randomblob(16)))` など)。行ごとに
    /// `SELECT (式)` で評価した値を INSERT する。式の中の `{old}` は元の値 (バインドパラメータ) に置き換わる
    /// (例: `{old} || '-copy'`)。
    Expression { sql: String },
    /// すべての複製行にこの文字列を入れる (`null` は NULL)。
    Literal { value: Option<String> },
}

/// 表の列 1 つへの方針。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneColumnRule {
    pub table: String,
    pub column: String,
    pub rule: KeyRule,
}

/// 文字列リテラル・引用識別子・コメントの中身を伏せた SQL (`db::mask_for_driver`)。
fn masked(driver: DriverKind, sql: &str) -> Vec<char> {
    let chars: Vec<char> = sql.chars().collect();
    super::mask_for_driver(driver, &chars)
}

/// 式を実行してよい形か検査する。評価は `SELECT (式)` の 1 文に限る。
/// - コメントは (MySQL の `/*!...*/` も含めて) 丸ごと禁止する。入れ子・ドライバ差で解釈が割れる。
/// - 文の区切り `;` は、文字列リテラル・引用識別子の外に置けない。
/// - `{old}` は引用符の外にだけ置ける。値は SQL に埋め込まずバインドパラメータで渡すので、引用符の
///   中に書いても値にはならない (書いた人の意図と食い違う)。
/// - バインド記号 (PostgreSQL の `$1`、MySQL / SQLite の `?`) を式に直接書くことはできない。
pub fn validate_expression(driver: DriverKind, sql: &str) -> Result<()> {
    let t = sql.trim();
    if t.is_empty() {
        return Err(AppError::InvalidInput(
            "the key expression must not be empty".into(),
        ));
    }
    if t.chars().count() > MAX_EXPRESSION_LEN {
        return Err(AppError::InvalidInput(format!(
            "the key expression exceeds {MAX_EXPRESSION_LEN} characters"
        )));
    }
    if super::strip_sql_comments(t, super::sql_flavor_of(driver)) != t {
        return Err(AppError::InvalidInput(
            "the key expression must not contain comments".into(),
        ));
    }
    let src: Vec<char> = t.chars().collect();
    let m = masked(driver, t);
    if m.len() != src.len() {
        return Err(AppError::InvalidInput(
            "the key expression could not be analyzed".into(),
        ));
    }
    if m.contains(&';') {
        return Err(AppError::InvalidInput(
            "the key expression must be a single expression (no ';' outside a string literal)"
                .into(),
        ));
    }
    let own_bind = match driver {
        DriverKind::Postgres => m.windows(2).any(|w| w[0] == '$' && w[1].is_ascii_digit()),
        _ => m.contains(&'?'),
    };
    if own_bind {
        return Err(AppError::InvalidInput(
            "the key expression must not contain bind placeholders ($1 / ?)".into(),
        ));
    }
    let ph: Vec<char> = OLD_PLACEHOLDER.chars().collect();
    let mut i = 0;
    while i + ph.len() <= src.len() {
        if src[i..i + ph.len()] == ph[..] {
            if m[i..i + ph.len()] != ph[..] {
                return Err(AppError::InvalidInput(
                    "{old} must not be inside a string literal, quoted identifier or comment; write it without quotes".into(),
                ));
            }
            i += ph.len();
        } else {
            i += 1;
        }
    }
    Ok(())
}

/// バインドする値 (ドライバへ渡す型付きの値)。元の値は SQL の文字列にしない。
#[derive(Debug, Clone, PartialEq)]
pub enum SqlBind {
    Int(i64),
    UInt(u64),
    Float(f64),
    Bool(bool),
    Text(String),
    Bytes(Vec<u8>),
}

/// バインドパラメータ付きの評価用 `SELECT`。
#[derive(Debug, Clone, PartialEq)]
pub struct BoundSelect {
    pub sql: String,
    pub binds: Vec<SqlBind>,
}

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 {
        return None;
    }
    b.chunks(2)
        .map(|p| {
            let h = (p[0] as char).to_digit(16)?;
            let l = (p[1] as char).to_digit(16)?;
            Some((h * 16 + l) as u8)
        })
        .collect()
}

/// 元の値を、桁を丸めずにバインドできる型へ直す。`None` は NULL。
/// 整数列の数字の文字列 (JS の安全整数を超える値) は整数のまま、バイナリ列の 16 進文字列は
/// バイト列にする (`db::subset::key_literal` と同じ解釈)。
pub fn bind_of(column_type: &str, value: &Value) -> Option<SqlBind> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(SqlBind::Bool(*b)),
        Value::Int(i) => Some(SqlBind::Int(*i)),
        Value::UInt(u) => Some(SqlBind::UInt(*u)),
        Value::Float(f) => Some(SqlBind::Float(*f)),
        Value::Bytes(h) => Some(match decode_hex(h) {
            Some(b) => SqlBind::Bytes(b),
            None => SqlBind::Text(h.clone()),
        }),
        Value::String(s) => {
            let t = s.trim();
            if is_binary_type(column_type) && is_hex_wire(s) {
                if let Some(b) = decode_hex(s) {
                    return Some(SqlBind::Bytes(b));
                }
            }
            if is_integer_type(column_type) && is_numeric_literal(t) {
                if let Ok(i) = t.parse::<i64>() {
                    return Some(SqlBind::Int(i));
                }
                if let Ok(u) = t.parse::<u64>() {
                    return Some(SqlBind::UInt(u));
                }
            }
            Some(SqlBind::Text(s.clone()))
        }
    }
}

/// 式の `{old}` を、元の値のバインドパラメータに置き換えた評価用の `SELECT` を作る。値は SQL の
/// 文字列に埋め込まない (PostgreSQL は `$1::型`、MySQL / SQLite は出現ごとに `?`)。NULL だけは
/// `NULL` と直接書く。置き換えた後の SQL にも文の区切りが現れていないことを再検査する。
pub fn expression_select(
    driver: DriverKind,
    sql: &str,
    column_type: &str,
    old: &Value,
) -> Result<BoundSelect> {
    validate_expression(driver, sql)?;
    let t = sql.trim();
    let bind = bind_of(column_type, old);
    let mut binds = Vec::new();
    let body = match (&bind, driver) {
        (None, _) => t.replace(OLD_PLACEHOLDER, "NULL"),
        (Some(b), DriverKind::Postgres) => {
            if !t.contains(OLD_PLACEHOLDER) {
                t.to_string()
            } else {
                let (slot, value) = match b {
                    SqlBind::Int(_) => ("($1::int8)", b.clone()),
                    SqlBind::Float(_) => ("($1::float8)", b.clone()),
                    SqlBind::Bool(_) => ("($1::bool)", b.clone()),
                    SqlBind::Bytes(_) => ("($1::bytea)", b.clone()),
                    SqlBind::Text(_) => ("($1::text)", b.clone()),
                    // u64 は int8 に収まらないので numeric として受ける
                    SqlBind::UInt(u) => match i64::try_from(*u) {
                        Ok(i) => ("($1::int8)", SqlBind::Int(i)),
                        Err(_) => ("(CAST($1::text AS numeric))", SqlBind::Text(u.to_string())),
                    },
                };
                binds.push(value);
                t.replace(OLD_PLACEHOLDER, slot)
            }
        }
        (Some(b), _) => {
            let n = t.matches(OLD_PLACEHOLDER).count();
            let value = match (b, driver) {
                // SQLite の整数は符号付き 64 ビット
                (SqlBind::UInt(u), DriverKind::Sqlite) => match i64::try_from(*u) {
                    Ok(i) => SqlBind::Int(i),
                    Err(_) => SqlBind::Text(u.to_string()),
                },
                _ => b.clone(),
            };
            binds.extend(std::iter::repeat(value).take(n));
            t.replace(OLD_PLACEHOLDER, "?")
        }
    };
    let out = format!("SELECT ({body})");
    if masked(driver, &out).contains(&';') {
        return Err(AppError::InvalidInput(
            "the key expression produced more than one statement".into(),
        ));
    }
    Ok(BoundSelect { sql: out, binds })
}

/// 複製する表のメタデータ。
#[derive(Debug, Clone)]
pub struct CloneTable {
    pub meta: SubsetTable,
    /// 主キーの列のうち、DB が採番する列 (AUTO_INCREMENT / IDENTITY / serial / rowid)。
    pub auto_columns: Vec<String>,
    /// 主キー以外の UNIQUE インデックス (名前, 列)。
    pub unique_indexes: Vec<(String, Vec<String>)>,
}

/// 主キーの列が複製でどう決まるか。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyStatus {
    /// DB の採番 (INSERT に含めず、採番された値を受け取る)。
    Auto,
    /// 式 / 上書き値の指定。
    Rule,
    /// 複製した親の行を指す外部キー (新しい親のキーに張り替わる)。
    Remapped,
    /// 何も起きない (元の値のまま)。
    Unchanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyColumnReport {
    pub name: String,
    pub status: KeyStatus,
}

/// 実行前に見つかった UNIQUE の衝突。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UniqueConflict {
    pub index: String,
    pub columns: Vec<String>,
    /// 衝突する複製行の数。
    pub rows: u64,
}

/// 表ごとの方針の検査結果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableReport {
    pub table: String,
    pub key_columns: Vec<KeyColumnReport>,
    /// 主キーのすべての列が元の値のまま = 方針の指定が要る (指定なしでは実行できない)。
    pub needs_policy: bool,
    pub conflicts: Vec<UniqueConflict>,
}

impl TableReport {
    /// 実行を止める問題があるか。
    pub fn blocked(&self) -> bool {
        self.needs_policy || !self.conflicts.is_empty()
    }
}

/// 表ごとの方針の検査に渡す、集めた行。
pub struct CloneInput<'a> {
    pub table: &'a CloneTable,
    pub rows: &'a [Vec<Value>],
}

/// 複製した行どうしの外部キーのうち、`table` の子の側の列 (張り替わりうる列)。
fn remappable_columns(
    table: &str,
    edges: &[SubsetEdge],
    cloned: &BTreeSet<&str>,
) -> BTreeSet<String> {
    edges
        .iter()
        .filter(|e| e.child == table && cloned.contains(e.parent.as_str()))
        .flat_map(|e| e.child_cols.iter().cloned())
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
enum ColumnFate<'r> {
    Rule(&'r KeyRule),
    Remapped,
    Auto,
    Unchanged,
}

fn rule_for<'r>(rules: &'r [CloneColumnRule], table: &str, column: &str) -> Option<&'r KeyRule> {
    rules
        .iter()
        .find(|r| r.table == table && r.column == column)
        .map(|r| &r.rule)
}

/// 方針を検査する (主キーの決まり方・方針の要否・UNIQUE の衝突)。
pub fn analyze(
    inputs: &[CloneInput<'_>],
    edges: &[SubsetEdge],
    rules: &[CloneColumnRule],
) -> Vec<TableReport> {
    let cloned: BTreeSet<&str> = inputs.iter().map(|i| i.table.meta.name.as_str()).collect();
    inputs
        .iter()
        .map(|input| {
            let t = input.table;
            let name = t.meta.name.as_str();
            let remap = remappable_columns(name, edges, &cloned);
            let fate = |col: &str| -> ColumnFate<'_> {
                if let Some(r) = rule_for(rules, name, col) {
                    ColumnFate::Rule(r)
                } else if remap.contains(col) {
                    ColumnFate::Remapped
                } else if t.auto_columns.iter().any(|a| a == col) {
                    ColumnFate::Auto
                } else {
                    ColumnFate::Unchanged
                }
            };
            let key_columns: Vec<KeyColumnReport> = t
                .meta
                .primary_key
                .iter()
                .map(|c| KeyColumnReport {
                    name: c.clone(),
                    status: match fate(c) {
                        ColumnFate::Rule(_) => KeyStatus::Rule,
                        ColumnFate::Remapped => KeyStatus::Remapped,
                        ColumnFate::Auto => KeyStatus::Auto,
                        ColumnFate::Unchanged => KeyStatus::Unchanged,
                    },
                })
                .collect();
            let needs_policy = !key_columns.is_empty()
                && key_columns.iter().all(|k| k.status == KeyStatus::Unchanged);
            let conflicts = unique_conflicts(t, input.rows, &fate);
            TableReport {
                table: name.to_string(),
                key_columns,
                needs_policy,
                conflicts,
            }
        })
        .collect()
}

/// 元の値のまま (または上書き値) になる列だけでできた UNIQUE インデックスの衝突を数える。
fn unique_conflicts<'r>(
    t: &CloneTable,
    rows: &[Vec<Value>],
    fate: &dyn Fn(&str) -> ColumnFate<'r>,
) -> Vec<UniqueConflict> {
    let mut out = Vec::new();
    for (index, cols) in &t.unique_indexes {
        let fates: Vec<ColumnFate<'_>> = cols.iter().map(|c| fate(c)).collect();
        // 式・張り替え・採番を含むインデックスは、新しい値を実行前に知れない。
        if fates.iter().any(|f| {
            matches!(
                f,
                ColumnFate::Remapped
                    | ColumnFate::Auto
                    | ColumnFate::Rule(KeyRule::Expression { .. })
            )
        }) {
            continue;
        }
        let idx: Vec<usize> = cols
            .iter()
            .filter_map(|c| t.meta.columns.iter().position(|x| x == c))
            .collect();
        if idx.len() != cols.len() {
            continue;
        }
        let mut seen: HashMap<String, u64> = HashMap::new();
        let mut conflicting = 0u64;
        for row in rows {
            let mut old_key: Vec<Value> = Vec::with_capacity(idx.len());
            let mut new_key: Vec<Value> = Vec::with_capacity(idx.len());
            for (f, &i) in fates.iter().zip(idx.iter()) {
                let old = row.get(i).cloned().unwrap_or(Value::Null);
                let new = match f {
                    ColumnFate::Rule(KeyRule::Literal { value: Some(s) }) => {
                        Value::String(s.clone())
                    }
                    ColumnFate::Rule(KeyRule::Literal { value: None }) => Value::Null,
                    _ => old.clone(),
                };
                old_key.push(old);
                new_key.push(new);
            }
            // NULL を含むキーは UNIQUE で衝突しない (3 ドライバ共通)。
            if new_key.iter().any(|v| matches!(v, Value::Null)) {
                continue;
            }
            let sig = key_signature(&new_key);
            let same_as_original = sig == key_signature(&old_key);
            let count = seen.entry(sig).or_insert(0);
            *count += 1;
            if same_as_original || *count > 1 {
                conflicting += 1;
            }
        }
        if conflicting > 0 {
            out.push(UniqueConflict {
                index: index.clone(),
                columns: cols.clone(),
                rows: conflicting,
            });
        }
    }
    out
}

/// 自己参照の外部キーで、自分自身か挿入順で後ろにある行を指す行があるか。
/// [`FkRemap`] は挿入済みの行しか張り替えられないので、そのまま複製すると新しい行が元の行を
/// 指したまま残る (例: `(id=1, parent_id=1)` が `(id=2, parent_id=1)` になる)。行どうしの循環も同じ。
/// `rows` は挿入順。照合は張り替えと同じ ([`FkRemap`] 参照: 完全一致を先に、無ければ [`loosens_collation`] な
/// ドライバだけ大文字小文字・末尾空白を無視して引く)。
pub fn has_unresolvable_self_reference(
    driver: DriverKind,
    meta: &SubsetTable,
    rows: &[Vec<Value>],
    edges: &[SubsetEdge],
) -> bool {
    let pick = |row: &[Value], cols: &[String]| -> Option<Vec<Value>> {
        cols.iter()
            .map(|c| {
                meta.columns
                    .iter()
                    .position(|x| x == c)
                    .and_then(|i| row.get(i).cloned())
            })
            .collect()
    };
    for e in edges
        .iter()
        .filter(|e| e.child == meta.name && e.parent == meta.name)
    {
        // 参照先キー → その行が最初に現れる挿入位置。
        let mut first_at: HashMap<String, usize> = HashMap::new();
        let mut first_loose: HashMap<String, usize> = HashMap::new();
        for (i, r) in rows.iter().enumerate() {
            if let Some(k) = pick(r, &e.parent_cols) {
                first_at.entry(key_signature(&k)).or_insert(i);
                first_loose.entry(loose_signature(&k)).or_insert(i);
            }
        }
        for (i, r) in rows.iter().enumerate() {
            let Some(k) = pick(r, &e.child_cols) else {
                continue;
            };
            if k.iter().any(|v| matches!(v, Value::Null)) {
                continue;
            }
            let found = first_at.get(&key_signature(&k)).or_else(|| {
                loosens_collation(driver)
                    .then(|| first_loose.get(&loose_signature(&k)))
                    .flatten()
            });
            if found.is_some_and(|&p| p >= i) {
                return true;
            }
        }
    }
    false
}

/// 外部キーの照合で、大文字小文字・末尾空白の差を無視してよいドライバか。
/// MySQL は既定の照合順序が区別せず ('abc' が 'ABC' を参照できる)、SQLite も列に `NOCASE` を付けると
/// 区別しない。PostgreSQL の既定は区別するので、緩く引くと別の行を取り違える (子 'abc' が、複製していない
/// 親 'abc' ではなく複製した親 'ABC' へ張り替わる) ため完全一致だけにする。
fn loosens_collation(driver: DriverKind) -> bool {
    !matches!(driver, DriverKind::Postgres)
}

/// 複製した行の外部キーの張り替え表。辺ごとに「元の参照先キー → 新しい参照先キー」を持つ。
/// 引くときは完全一致 (`key_signature`) を先に、無ければ (照合を区別しないドライバだけ)
/// 大文字小文字・末尾空白を無視した表 (`loose_signature`) で引く。
#[derive(Debug)]
pub struct FkRemap {
    driver: DriverKind,
    edges: Vec<SubsetEdge>,
    maps: Vec<HashMap<String, Vec<Value>>>,
    loose_maps: Vec<HashMap<String, Vec<Value>>>,
}

impl FkRemap {
    pub fn new(driver: DriverKind, edges: &[SubsetEdge]) -> Self {
        Self {
            driver,
            edges: edges.to_vec(),
            maps: vec![HashMap::new(); edges.len()],
            loose_maps: vec![HashMap::new(); edges.len()],
        }
    }

    /// 複製した行 (`old_row` → `new_row`) を、その表を参照先とする辺に登録する。
    pub fn register(&mut self, meta: &SubsetTable, old_row: &[Value], new_row: &[Value]) {
        for ((e, map), loose) in self
            .edges
            .iter()
            .zip(self.maps.iter_mut())
            .zip(self.loose_maps.iter_mut())
        {
            if e.parent != meta.name {
                continue;
            }
            let pick = |row: &[Value]| -> Option<Vec<Value>> {
                e.parent_cols
                    .iter()
                    .map(|c| {
                        meta.columns
                            .iter()
                            .position(|x| x == c)
                            .and_then(|i| row.get(i).cloned())
                    })
                    .collect()
            };
            if let (Some(old), Some(new)) = (pick(old_row), pick(new_row)) {
                loose
                    .entry(loose_signature(&old))
                    .or_insert_with(|| new.clone());
                map.insert(key_signature(&old), new);
            }
        }
    }

    /// `row` (元の行) の外部キーのうち、複製済みの行を指すものを新しいキーに替える。
    /// 替えた列の位置を返す。NULL を含む外部キーと、複製していない行への参照はそのまま。
    pub fn remap(&self, meta: &SubsetTable, row: &mut [Value]) -> BTreeSet<usize> {
        // 引くキーは必ず元の行から全部計算してから値を適用する。列を共有する外部キーがあると、
        // 先の張り替えで書き換わった値で後の外部キーを引いてしまうため。
        let mut updates: Vec<(usize, Value)> = Vec::new();
        for ((e, map), loose) in self
            .edges
            .iter()
            .zip(self.maps.iter())
            .zip(self.loose_maps.iter())
        {
            if e.child != meta.name {
                continue;
            }
            let idx: Option<Vec<usize>> = e
                .child_cols
                .iter()
                .map(|c| meta.columns.iter().position(|x| x == c))
                .collect();
            let Some(idx) = idx else { continue };
            let key: Vec<Value> = idx.iter().filter_map(|&i| row.get(i).cloned()).collect();
            if key.len() != idx.len() || key.iter().any(|v| matches!(v, Value::Null)) {
                continue;
            }
            let found = map.get(&key_signature(&key)).or_else(|| {
                loosens_collation(self.driver)
                    .then(|| loose.get(&loose_signature(&key)))
                    .flatten()
            });
            if let Some(new) = found {
                updates.extend(idx.iter().copied().zip(new.iter().cloned()));
            }
        }
        let mut changed = BTreeSet::new();
        for (i, v) in updates {
            if let Some(slot) = row.get_mut(i) {
                *slot = v;
                changed.insert(i);
            }
        }
        changed
    }
}

/// 採番値 (MySQL の `LAST_INSERT_ID()` は符号なし) と読み戻した行で整数の型が違っても同じ行と
/// 見なす署名。
pub fn loose_sig(key: &[Value]) -> String {
    key.iter()
        .map(|v| match v {
            Value::Int(i) => i.to_string(),
            Value::UInt(u) => u.to_string(),
            Value::String(s) => s.clone(),
            other => format!("{other:?}"),
        })
        .collect::<Vec<_>>()
        .join("\u{1f}")
}

/// 複製した行 (`rows`、挿入順 = 親が先) を、自己参照の外部キーの深さごとの組に分ける。
/// 深さ 0 は同じ表の行を指さない行、深さ n は深さ n-1 までの行を指す行。自己参照が無い表は 1 組。
/// 各組は挿入順を保ち、組は深さの浅い順に並ぶ。Undo のバッチは記録の新しい順 (深い組から DELETE)、
/// Redo は古い順 (浅い組から INSERT) に流れるので、組ごとに別の記録にすれば両方が外部キー違反にならない。
/// 参照先の行が `rows` に無い (複製していない) ときと NULL は深さ 0 として扱う。
pub fn self_reference_generations(
    meta: &SubsetTable,
    rows: &[Vec<Value>],
    edges: &[SubsetEdge],
) -> Vec<Vec<Vec<Value>>> {
    let pick = |row: &[Value], cols: &[String]| -> Option<Vec<Value>> {
        cols.iter()
            .map(|c| {
                meta.columns
                    .iter()
                    .position(|x| x == c)
                    .and_then(|i| row.get(i).cloned())
            })
            .collect()
    };
    let self_edges: Vec<&SubsetEdge> = edges
        .iter()
        .filter(|e| e.child == meta.name && e.parent == meta.name)
        .collect();
    if self_edges.is_empty() {
        return vec![rows.to_vec()];
    }
    // 辺ごとの「参照先キー → 行の深さ」。親は子より前にあるので、挿入順に 1 回なめれば足りる。
    let mut depth_by_key: Vec<HashMap<String, usize>> = vec![HashMap::new(); self_edges.len()];
    let mut groups: Vec<Vec<Vec<Value>>> = Vec::new();
    for row in rows {
        let mut depth = 0;
        for (e, map) in self_edges.iter().zip(depth_by_key.iter()) {
            let Some(k) = pick(row, &e.child_cols) else {
                continue;
            };
            if k.iter().any(|v| matches!(v, Value::Null)) {
                continue;
            }
            if let Some(&d) = map.get(&loose_sig(&k)) {
                depth = depth.max(d + 1);
            }
        }
        for (e, map) in self_edges.iter().zip(depth_by_key.iter_mut()) {
            if let Some(k) = pick(row, &e.parent_cols) {
                map.entry(loose_sig(&k)).or_insert(depth);
            }
        }
        if groups.len() <= depth {
            groups.resize_with(depth + 1, Vec::new);
        }
        groups[depth].push(row.clone());
    }
    groups.retain(|g| !g.is_empty());
    groups
}

/// 複製した行 1 件分の `INSERT`。`values` は `columns` と同じ並びのリテラル。
/// `returning` は採番された値を受け取る列 (PostgreSQL / SQLite の `RETURNING`。MySQL は
/// `LAST_INSERT_ID()` で別に取るので呼び出し側が空にする)。
pub fn insert_sql(
    driver: DriverKind,
    table_ref: &str,
    columns: &[String],
    values: &[String],
    returning: &[String],
) -> String {
    let mut sql = if columns.is_empty() {
        match driver {
            DriverKind::Mysql => format!("INSERT INTO {table_ref} () VALUES ()"),
            DriverKind::Postgres | DriverKind::Sqlite => {
                format!("INSERT INTO {table_ref} DEFAULT VALUES")
            }
        }
    } else {
        let cols: Vec<String> = columns.iter().map(|c| quote_ident(driver, c)).collect();
        format!(
            "INSERT INTO {table_ref} ({}) VALUES ({})",
            cols.join(", "),
            values.join(", ")
        )
    };
    if !returning.is_empty() && driver != DriverKind::Mysql {
        let cols: Vec<String> = returning.iter().map(|c| quote_ident(driver, c)).collect();
        sql.push_str(&format!(" RETURNING {}", cols.join(", ")));
    }
    sql
}

/// 主キーの列の値 (列の並び順)。主キーが無い表は `None`。
pub fn key_of(meta: &SubsetTable, row: &[Value]) -> Option<Vec<Value>> {
    if meta.primary_key.is_empty() {
        return None;
    }
    meta.primary_key
        .iter()
        .map(|c| {
            meta.columns
                .iter()
                .position(|x| x == c)
                .and_then(|i| row.get(i).cloned())
        })
        .collect()
}

/// 既定値の式が「行ごとに値が変わる」もの (採番・乱数・UUID) か。定数・`CURRENT_TIMESTAMP` 以外の
/// 固定の既定値 (例: `tenant_id DEFAULT 1`) を採番扱いにすると、複製が静かに別の値へ変わる。
fn is_generating_default(default: &str) -> bool {
    let d = default.to_ascii_lowercase();
    [
        "nextval(",
        "gen_random_uuid",
        "uuid_generate_",
        "uuid_generate",
        "randomblob(",
        "random()",
    ]
    .iter()
    .any(|k| d.contains(k))
}

/// 主キーの列のうち DB が採番する列を判定する。それ以外の主キー列は元の値のまま (`Unchanged`)。
/// - MySQL: `AUTO_INCREMENT`。
/// - PostgreSQL: IDENTITY / `nextval(` / 揮発する既定値 (`gen_random_uuid()` など。`RETURNING` で受け取れる)。
/// - SQLite: rowid の別名になる単一列の `INTEGER PRIMARY KEY` / 揮発する既定値 (`randomblob` など)。
///   `rowid_alias` は表が rowid 表かどうか (WITHOUT ROWID 表の INTEGER 主キーは採番されない)。
///
/// 定数の既定値 (`DEFAULT 1`) は、INSERT から外しても元の行と同じ値になり衝突するので採番扱いにしない。
pub fn auto_columns(
    driver: DriverKind,
    columns: &[super::types::TableColumnInfo],
    primary_key: &[String],
    rowid_alias: bool,
) -> Vec<String> {
    let single = primary_key.len() == 1;
    columns
        .iter()
        .filter(|c| primary_key.iter().any(|p| p == &c.name))
        .filter(|c| {
            let extra = c.extra.to_ascii_lowercase();
            let default = c
                .default
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty());
            let generating = default.is_some_and(is_generating_default);
            match driver {
                DriverKind::Mysql => extra.contains("auto_increment"),
                DriverKind::Postgres => extra.contains("identity") || generating,
                DriverKind::Sqlite => {
                    generating
                        || (single && rowid_alias && c.data_type.eq_ignore_ascii_case("integer"))
                }
            }
        })
        .map(|c| c.name.clone())
        .collect()
}

/// 方針の指定を表ごとの列名の集合にまとめる (存在しない列の検査用)。
pub fn rule_columns(rules: &[CloneColumnRule]) -> BTreeMap<&str, BTreeSet<&str>> {
    let mut m: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for r in rules {
        m.entry(r.table.as_str())
            .or_default()
            .insert(r.column.as_str());
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(name: &str, cols: &[&str], pk: &[&str]) -> SubsetTable {
        SubsetTable {
            name: name.into(),
            columns: cols.iter().map(|c| c.to_string()).collect(),
            column_types: cols.iter().map(|_| "int".to_string()).collect(),
            primary_key: pk.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn table(name: &str, cols: &[&str], pk: &[&str], auto: &[&str]) -> CloneTable {
        CloneTable {
            meta: meta(name, cols, pk),
            auto_columns: auto.iter().map(|c| c.to_string()).collect(),
            unique_indexes: Vec::new(),
        }
    }

    fn edge(child: &str, cc: &[&str], parent: &str, pc: &[&str]) -> SubsetEdge {
        SubsetEdge {
            constraint: format!("fk_{child}_{parent}"),
            child: child.into(),
            child_cols: cc.iter().map(|c| c.to_string()).collect(),
            parent: parent.into(),
            parent_cols: pc.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn ints(v: &[i64]) -> Vec<Value> {
        v.iter().map(|&i| Value::Int(i)).collect()
    }

    #[test]
    fn auto_key_needs_no_policy_but_plain_key_does() {
        let orders = table("orders", &["id", "no"], &["id"], &["id"]);
        let tags = table("tags", &["code", "name"], &["code"], &[]);
        let rows: Vec<Vec<Value>> = vec![ints(&[1, 5])];
        let r = analyze(
            &[
                CloneInput {
                    table: &orders,
                    rows: &rows,
                },
                CloneInput {
                    table: &tags,
                    rows: &rows,
                },
            ],
            &[],
            &[],
        );
        assert_eq!(r[0].key_columns[0].status, KeyStatus::Auto);
        assert!(!r[0].needs_policy);
        assert_eq!(r[1].key_columns[0].status, KeyStatus::Unchanged);
        assert!(r[1].needs_policy);
        // 式を指定すれば方針は足りる。
        let rules = [CloneColumnRule {
            table: "tags".into(),
            column: "code".into(),
            rule: KeyRule::Expression {
                sql: "UUID()".into(),
            },
        }];
        let r = analyze(
            &[CloneInput {
                table: &tags,
                rows: &rows,
            }],
            &[],
            &rules,
        );
        assert_eq!(r[0].key_columns[0].status, KeyStatus::Rule);
        assert!(!r[0].needs_policy);
    }

    #[test]
    fn remapped_composite_key_is_enough() {
        // 中間表: 主キー (order_id, product_id)。order_id だけ複製した親を指す。
        let orders = table("orders", &["id"], &["id"], &["id"]);
        let link = table(
            "link",
            &["order_id", "product_id"],
            &["order_id", "product_id"],
            &[],
        );
        let rows: Vec<Vec<Value>> = vec![ints(&[1, 9])];
        let edges = [edge("link", &["order_id"], "orders", &["id"])];
        let r = analyze(
            &[
                CloneInput {
                    table: &orders,
                    rows: &rows,
                },
                CloneInput {
                    table: &link,
                    rows: &rows,
                },
            ],
            &edges,
            &[],
        );
        assert_eq!(r[1].key_columns[0].status, KeyStatus::Remapped);
        assert_eq!(r[1].key_columns[1].status, KeyStatus::Unchanged);
        assert!(!r[1].needs_policy);
        // 親が複製に含まれなければ張り替えは起きないので方針が要る。
        let r = analyze(
            &[CloneInput {
                table: &link,
                rows: &rows,
            }],
            &edges,
            &[],
        );
        assert!(r[0].needs_policy);
    }

    #[test]
    fn unchanged_unique_index_is_a_conflict_unless_overridden() {
        let mut orders = table("orders", &["id", "order_no"], &["id"], &["id"]);
        orders.unique_indexes = vec![("uq_no".into(), vec!["order_no".into()])];
        let rows: Vec<Vec<Value>> = vec![
            vec![Value::Int(1), Value::String("A-1".into())],
            vec![Value::Int(2), Value::Null],
        ];
        let r = analyze(
            &[CloneInput {
                table: &orders,
                rows: &rows,
            }],
            &[],
            &[],
        );
        // NULL の行は衝突しない。
        assert_eq!(
            r[0].conflicts,
            vec![UniqueConflict {
                index: "uq_no".into(),
                columns: vec!["order_no".into()],
                rows: 1
            }]
        );
        assert!(r[0].blocked());
        // 式で上書きすれば検査の対象外。
        let rules = [CloneColumnRule {
            table: "orders".into(),
            column: "order_no".into(),
            rule: KeyRule::Expression {
                sql: "{old} || '-copy'".into(),
            },
        }];
        let r = analyze(
            &[CloneInput {
                table: &orders,
                rows: &rows,
            }],
            &[],
            &rules,
        );
        assert!(r[0].conflicts.is_empty());
        // 同じ上書き値を複数行に入れると複製どうしで衝突する。
        let rows2: Vec<Vec<Value>> = vec![
            vec![Value::Int(1), Value::String("A-1".into())],
            vec![Value::Int(2), Value::String("A-2".into())],
        ];
        let rules = [CloneColumnRule {
            table: "orders".into(),
            column: "order_no".into(),
            rule: KeyRule::Literal {
                value: Some("X".into()),
            },
        }];
        let r = analyze(
            &[CloneInput {
                table: &orders,
                rows: &rows2,
            }],
            &[],
            &rules,
        );
        assert_eq!(r[0].conflicts[0].rows, 1);
    }

    #[test]
    fn remap_replaces_only_cloned_references() {
        let orders = meta("orders", &["id", "customer_id"], &["id"]);
        let items = meta("items", &["id", "order_id", "product_id"], &["id"]);
        let edges = [
            edge("items", &["order_id"], "orders", &["id"]),
            edge("orders", &["customer_id"], "customers", &["id"]),
        ];
        let mut m = FkRemap::new(DriverKind::Sqlite, &edges);
        m.register(&orders, &ints(&[1, 7]), &ints(&[100, 7]));
        let mut row = ints(&[10, 1, 55]);
        let changed = m.remap(&items, &mut row);
        assert_eq!(row, ints(&[10, 100, 55]));
        assert_eq!(changed, BTreeSet::from([1]));
        // 複製していない親への参照は変わらない。
        let mut other = ints(&[11, 2, 55]);
        assert!(m.remap(&items, &mut other).is_empty());
        assert_eq!(other, ints(&[11, 2, 55]));
        // NULL の外部キーはそのまま。
        let mut nul = vec![Value::Int(12), Value::Null, Value::Int(1)];
        assert!(m.remap(&items, &mut nul).is_empty());
    }

    #[test]
    fn self_reference_to_itself_or_a_later_row_is_unresolvable() {
        let cat = meta("cat", &["id", "parent_id"], &["id"]);
        let edges = [edge("cat", &["parent_id"], "cat", &["id"])];
        // 親が先: 張り替えられる。
        assert!(!has_unresolvable_self_reference(
            DriverKind::Sqlite,
            &cat,
            &[vec![Value::Int(1), Value::Null], ints(&[2, 1])],
            &edges
        ));
        // 複製しない行への参照はそのまま残してよい。
        assert!(!has_unresolvable_self_reference(
            DriverKind::Sqlite,
            &cat,
            &[ints(&[2, 99])],
            &edges
        ));
        // 自分自身を指す行。
        assert!(has_unresolvable_self_reference(
            DriverKind::Sqlite,
            &cat,
            &[ints(&[1, 1])],
            &edges
        ));
        // 行どうしの循環 (1 → 2 → 1)。
        assert!(has_unresolvable_self_reference(
            DriverKind::Sqlite,
            &cat,
            &[ints(&[1, 2]), ints(&[2, 1])],
            &edges
        ));
    }

    #[test]
    fn overlapping_foreign_keys_are_looked_up_with_the_original_row() {
        // C(a_id) -> A(id) と C(a_id, b_id) -> B(a_id, id)。A: 1→2、B: (1,10)→(2,20)。
        let a = meta("a", &["id"], &["id"]);
        let b = meta("b", &["a_id", "id"], &["a_id", "id"]);
        let c = meta("c", &["id", "a_id", "b_id"], &["id"]);
        let edges = [
            edge("c", &["a_id"], "a", &["id"]),
            edge("c", &["a_id", "b_id"], "b", &["a_id", "id"]),
        ];
        let mut m = FkRemap::new(DriverKind::Sqlite, &edges);
        m.register(&a, &ints(&[1]), &ints(&[2]));
        m.register(&b, &ints(&[1, 10]), &ints(&[2, 20]));
        let mut row = ints(&[5, 1, 10]);
        let changed = m.remap(&c, &mut row);
        assert_eq!(row, ints(&[5, 2, 20]));
        assert_eq!(changed, BTreeSet::from([1, 2]));
    }

    fn text(s: &str) -> Value {
        Value::String(s.to_string())
    }

    #[test]
    fn collation_insensitive_drivers_remap_a_case_differing_reference() {
        let cat = meta("cat", &["id", "parent_id"], &["id"]);
        let edges = [edge("cat", &["parent_id"], "cat", &["id"])];
        let rows = [
            vec![text("ABC"), Value::Null],
            vec![text("child"), text("abc ")],
        ];
        for driver in [DriverKind::Mysql, DriverKind::Sqlite] {
            let mut m = FkRemap::new(driver, &edges);
            m.register(&cat, &rows[0], &[text("NEW"), Value::Null]);
            let mut child = rows[1].clone();
            m.remap(&cat, &mut child);
            assert_eq!(child[1], text("NEW"), "{driver:?}");
            // 親が先なら解決できる。親が子より後ろにある場合は、大文字小文字が違っても止める。
            assert!(!has_unresolvable_self_reference(
                driver, &cat, &rows, &edges
            ));
            let reversed = [rows[1].clone(), rows[0].clone()];
            assert!(has_unresolvable_self_reference(
                driver, &cat, &reversed, &edges
            ));
        }
        // 完全一致があればそちらを優先する。
        let mut m = FkRemap::new(DriverKind::Mysql, &edges);
        m.register(
            &cat,
            &[text("ABC"), Value::Null],
            &[text("UP"), Value::Null],
        );
        m.register(
            &cat,
            &[text("abc"), Value::Null],
            &[text("LOW"), Value::Null],
        );
        let mut child = vec![text("x"), text("abc")];
        m.remap(&cat, &mut child);
        assert_eq!(child[1], text("LOW"));
    }

    #[test]
    fn postgres_keeps_case_sensitive_matching() {
        let cat = meta("cat", &["id", "parent_id"], &["id"]);
        let edges = [edge("cat", &["parent_id"], "cat", &["id"])];
        let mut m = FkRemap::new(DriverKind::Postgres, &edges);
        m.register(
            &cat,
            &[text("ABC"), Value::Null],
            &[text("NEW"), Value::Null],
        );
        let mut child = vec![text("child"), text("abc")];
        assert!(m.remap(&cat, &mut child).is_empty());
        assert_eq!(child[1], text("abc"));
        let rows = [
            vec![text("child"), text("abc")],
            vec![text("ABC"), Value::Null],
        ];
        assert!(!has_unresolvable_self_reference(
            DriverKind::Postgres,
            &cat,
            &rows,
            &edges
        ));
    }

    #[test]
    fn self_reference_generations_split_parent_first() {
        let cat = meta("cat", &["id", "parent_id"], &["id"]);
        let edges = [edge("cat", &["parent_id"], "cat", &["id"])];
        // 1 (根) / 2 → 1 / 3 → 2 / 4 (根) / 5 → 1 / 6 → 99 (複製していない親)。
        let n = || Value::Null;
        let rows = vec![
            vec![Value::Int(1), n()],
            ints(&[2, 1]),
            ints(&[3, 2]),
            vec![Value::Int(4), n()],
            ints(&[5, 1]),
            ints(&[6, 99]),
        ];
        let g = self_reference_generations(&cat, &rows, &edges);
        let ids: Vec<Vec<i64>> = g
            .iter()
            .map(|grp| {
                grp.iter()
                    .map(|r| match r[0] {
                        Value::Int(i) => i,
                        _ => -1,
                    })
                    .collect()
            })
            .collect();
        assert_eq!(ids, vec![vec![1, 4, 6], vec![2, 5], vec![3]]);
        // 自己参照が無ければ 1 組のまま。
        let flat = self_reference_generations(&cat, &rows, &[]);
        assert_eq!(flat, vec![rows]);
    }

    #[test]
    fn self_reference_is_remapped_through_the_same_table() {
        let cat = meta("cat", &["id", "parent_id"], &["id"]);
        let edges = [edge("cat", &["parent_id"], "cat", &["id"])];
        let mut m = FkRemap::new(DriverKind::Sqlite, &edges);
        m.register(
            &cat,
            &[Value::Int(1), Value::Null],
            &[Value::Int(10), Value::Null],
        );
        let mut child = ints(&[2, 1]);
        m.remap(&cat, &mut child);
        assert_eq!(child, ints(&[2, 10]));
    }

    #[test]
    fn insert_sql_per_driver() {
        let cols = vec!["a".to_string(), "b".to_string()];
        let vals = vec!["1".to_string(), "'x'".to_string()];
        let ret = vec!["id".to_string()];
        assert_eq!(
            insert_sql(DriverKind::Postgres, "\"t\"", &cols, &vals, &ret),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES (1, 'x') RETURNING \"id\""
        );
        assert_eq!(
            insert_sql(DriverKind::Mysql, "`t`", &cols, &vals, &ret),
            "INSERT INTO `t` (`a`, `b`) VALUES (1, 'x')"
        );
        assert_eq!(
            insert_sql(DriverKind::Sqlite, "\"t\"", &[], &[], &ret),
            "INSERT INTO \"t\" DEFAULT VALUES RETURNING \"id\""
        );
        assert_eq!(
            insert_sql(DriverKind::Mysql, "`t`", &[], &[], &[]),
            "INSERT INTO `t` () VALUES ()"
        );
    }

    #[test]
    fn expression_validation_and_substitution() {
        let d = DriverKind::Sqlite;
        assert!(validate_expression(d, "UUID()").is_ok());
        assert!(validate_expression(d, "  ").is_err());
        assert!(validate_expression(d, "1; DROP TABLE t").is_err());
        // 文字列リテラルの中の ';' は式の一部。
        assert!(validate_expression(d, "{old} || ';'").is_ok());
        let b = expression_select(d, "{old} || '-copy'", "text", &Value::String("A".into()))
            .expect("select");
        assert_eq!(b.sql, "SELECT (? || '-copy')");
        assert_eq!(b.binds, vec![SqlBind::Text("A".into())]);
        let b = expression_select(
            DriverKind::Postgres,
            "{old} || {old}",
            "bigint",
            &Value::String("9007199254740993".into()),
        )
        .expect("select");
        assert_eq!(b.sql, "SELECT (($1::int8) || ($1::int8))");
        assert_eq!(b.binds, vec![SqlBind::Int(9007199254740993)]);
        let b = expression_select(d, "{old} + {old}", "int", &Value::Null).expect("select");
        assert_eq!(b.sql, "SELECT (NULL + NULL)");
        assert!(b.binds.is_empty());
        // `?` の数 == binds の数 (`{old}` が複数回出ても食い違わない)
        for d in [DriverKind::Mysql, DriverKind::Sqlite] {
            let b = expression_select(
                d,
                "CONCAT({old}, '?', {old})",
                "text",
                &Value::String("A".into()),
            )
            .expect("select");
            assert_eq!(
                masked(d, &b.sql).iter().filter(|c| **c == '?').count(),
                b.binds.len()
            );
            assert_eq!(b.binds.len(), 2);
        }
    }

    #[test]
    fn old_placeholder_must_stay_outside_quotes() {
        for d in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            // 引用符の中・引用識別子・コメントの中は拒否。
            assert!(validate_expression(d, "'{old}-copy'").is_err(), "{d:?}");
            assert!(validate_expression(d, "'x' || '{old}'").is_err(), "{d:?}");
            assert!(validate_expression(d, "1 /* {old} */").is_err(), "{d:?}");
            assert!(validate_expression(d, "1 -- {old}").is_err(), "{d:?}");
            // 外なら可。
            assert!(validate_expression(d, "{old} + 1").is_ok(), "{d:?}");
        }
        assert!(validate_expression(DriverKind::Postgres, "\"{old}\"").is_err());
    }

    /// 元の値は SQL の文字列に埋め込まれない。敵対的な式 + 値でも、拒否されるか、値の文字列が
    /// 生成 SQL に現れない (バインドで渡る) ことを確かめる。
    #[test]
    fn old_value_is_never_embedded_in_sql() {
        let hostile = [
            "x*/ (SELECT 1)) --",
            "\\'), (SELECT 1) --",
            "a'; DROP TABLE t; --",
            "$$ ; SELECT 1 $$",
        ];
        let exprs: [(DriverKind, &str); 12] = [
            // (a) PostgreSQL の入れ子ブロックコメント
            (DriverKind::Postgres, "/* /* */ {old} */ 1"),
            // (b) E'..' の連結 (バックスラッシュエスケープ)
            (DriverKind::Postgres, "E'x'\n{old}"),
            // (c) MySQL の実行コメント
            (DriverKind::Mysql, "/*!99999 {old} */"),
            (DriverKind::Mysql, "1 /*!50000 + {old} */"),
            // ドル引用
            (DriverKind::Postgres, "$$ {old} $$"),
            (DriverKind::Postgres, "$t$ {old} $t$ || {old}"),
            // MySQL のバックスラッシュ境界
            (DriverKind::Mysql, "'\\' {old} '"),
            (DriverKind::Mysql, "'\\' || {old}"),
            (DriverKind::Sqlite, "'a' || {old}"),
            (DriverKind::Mysql, "CONCAT({old}, 'x')"),
            (DriverKind::Postgres, "{old}::text"),
            (DriverKind::Sqlite, "{old} -- x"),
        ];
        for (d, e) in exprs {
            for h in hostile {
                match expression_select(d, e, "text", &Value::String(h.into())) {
                    Err(_) => {}
                    Ok(b) => {
                        assert!(!b.sql.contains(h), "{d:?} {e:?} {h:?}: {}", b.sql);
                        let m: String = masked(d, &b.sql).into_iter().collect();
                        assert!(!m.contains(';'), "{d:?} {e:?}: {}", b.sql);
                    }
                }
            }
        }
    }

    #[test]
    fn comments_are_rejected_in_expressions() {
        for d in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            assert!(validate_expression(d, "1 /* c */").is_err(), "{d:?}");
            assert!(validate_expression(d, "{old} -- c").is_err(), "{d:?}");
            // 文字列の中のコメント記号は式の一部。
            assert!(validate_expression(d, "'a -- b /* c */'").is_ok(), "{d:?}");
        }
        assert!(validate_expression(DriverKind::Mysql, "/*!99999 {old} */").is_err());
        assert!(validate_expression(DriverKind::Mysql, "1 # c").is_err());
        assert!(validate_expression(DriverKind::Postgres, "/* /* */ {old} */ 1").is_err());
        // バインド記号を式に直接書けない。
        assert!(validate_expression(DriverKind::Postgres, "$1").is_err());
        assert!(validate_expression(DriverKind::Sqlite, "?").is_err());
        assert!(validate_expression(DriverKind::Postgres, "'?'").is_ok());
    }

    #[test]
    fn bind_of_keeps_exact_types() {
        assert_eq!(bind_of("int", &Value::Null), None);
        assert_eq!(
            bind_of("bigint", &Value::String("9223372036854775807".into())),
            Some(SqlBind::Int(i64::MAX))
        );
        assert_eq!(
            bind_of(
                "bigint unsigned",
                &Value::String("18446744073709551615".into())
            ),
            Some(SqlBind::UInt(u64::MAX))
        );
        assert_eq!(
            bind_of("text", &Value::String("123".into())),
            Some(SqlBind::Text("123".into()))
        );
        assert_eq!(
            bind_of("blob", &Value::Bytes("00ff".into())),
            Some(SqlBind::Bytes(vec![0, 255]))
        );
    }

    #[test]
    fn auto_columns_per_driver() {
        let cpk_with = |c: &str| vec!["tenant_id".to_string(), c.to_string()];
        use super::super::types::TableColumnInfo;
        let col = |name: &str, ty: &str, extra: &str, default: Option<&str>| TableColumnInfo {
            name: name.into(),
            data_type: ty.into(),
            nullable: false,
            key: "PRI".into(),
            default: default.map(str::to_string),
            extra: extra.into(),
            referenced_table: None,
            referenced_column: None,
            comment: None,
        };
        fn auto_columns(d: DriverKind, c: &[TableColumnInfo], p: &[String]) -> Vec<String> {
            super::auto_columns(d, c, p, true)
        }
        let pk = vec!["id".to_string()];
        assert_eq!(
            auto_columns(
                DriverKind::Mysql,
                &[col("id", "int", "auto_increment", None)],
                &pk
            ),
            pk
        );
        assert!(auto_columns(DriverKind::Mysql, &[col("id", "char", "", None)], &pk).is_empty());
        assert_eq!(
            auto_columns(
                DriverKind::Postgres,
                &[col("id", "integer", "IDENTITY", None)],
                &pk
            ),
            pk
        );
        assert_eq!(
            auto_columns(
                DriverKind::Postgres,
                &[col("id", "integer", "", Some("nextval('s'::regclass)"))],
                &pk
            ),
            pk
        );
        assert!(auto_columns(DriverKind::Postgres, &[col("id", "text", "", None)], &pk).is_empty());
        // 複合主キーの既定値つき列 (tenant_id DEFAULT 1) は採番扱いにしない。揮発する既定値は採番扱い。
        let cpk = vec!["tenant_id".to_string(), "id".to_string()];
        for d in [DriverKind::Postgres, DriverKind::Sqlite] {
            assert!(
                auto_columns(d, &[col("tenant_id", "integer", "", Some("1"))], &cpk).is_empty()
            );
            assert!(auto_columns(d, &[col("tenant_id", "INTEGER", "", None)], &cpk).is_empty());
        }
        assert_eq!(
            auto_columns(
                DriverKind::Postgres,
                &[col("id", "uuid", "", Some("gen_random_uuid()"))],
                &["id".to_string()]
            ),
            vec!["id".to_string()]
        );
        assert_eq!(
            auto_columns(
                DriverKind::Postgres,
                &[col("id", "uuid", "", Some("gen_random_uuid()"))],
                &cpk_with("id")
            ),
            vec!["id".to_string()]
        );
        assert_eq!(
            auto_columns(
                DriverKind::Sqlite,
                &[col("id", "blob", "", Some("(randomblob(16))"))],
                &cpk_with("id")
            ),
            vec!["id".to_string()]
        );
        assert_eq!(
            auto_columns(DriverKind::Sqlite, &[col("id", "INTEGER", "", None)], &pk),
            pk
        );
        assert!(auto_columns(DriverKind::Sqlite, &[col("id", "TEXT", "", None)], &pk).is_empty());
        // WITHOUT ROWID 表の INTEGER 主キーは採番されない。
        assert!(super::auto_columns(
            DriverKind::Sqlite,
            &[col("id", "INTEGER", "", None)],
            &pk,
            false
        )
        .is_empty());
        // 単一列でも定数の既定値は採番扱いにしない (外すと元の行と同じ値になる)。
        for d in [DriverKind::Postgres, DriverKind::Sqlite] {
            assert!(auto_columns(d, &[col("id", "text", "", Some("'fixed'"))], &pk).is_empty());
        }
    }
}
