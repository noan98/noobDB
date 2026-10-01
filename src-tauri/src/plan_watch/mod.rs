//! 実行計画ウォッチ (#743 / #1260) — スニペット単位の EXPLAIN 計画の世代管理。
//!
//! 旧実装はフロントが EXPLAIN を 1 件ずつ直列に `run_query` し、計画の正規化・
//! フィンガープリント・比較 (`components/planDiff.ts`) をすべて JS で行い、毎回
//! `localStorage` 全体を JSON で読み書きしていた (#1260)。現在は世代を [`store`]
//! (`<data_dir>/plan_watch.sqlite`) に持ち、`plan_watch_refresh` が EXPLAIN 実行・
//! 正規化・フィンガープリント・世代記録・前世代との比較を Rust 内で完結させて
//! 「何件変化したか」だけを返す。
//!
//! このモジュールの純関数部分 (パース・正規化・フィンガープリント・比較) は
//! `src/components/explainPlan.ts` / `planDiff.ts` の移植で、Rust とフロントの二重実装は
//! 共有ゴールデンベクタ (`src/__tests__/fixtures/plan_watch.json`) で固定している。
//! 計画ウォッチパネルの 2 面比較・変化点リストは引き続きフロントの `planDiff.ts` が
//! 保存済みペイロードから描画する (表示専用)。
//!
//! 対象は `EXPLAIN FORMAT=JSON` (MySQL) / `EXPLAIN (FORMAT JSON)` (PostgreSQL) /
//! `EXPLAIN QUERY PLAN` (SQLite) のみ。MySQL の `EXPLAIN ANALYZE` (テキストツリー) は
//! ウォッチの対象外。

pub mod store;

use std::collections::HashMap;

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::db::types::{QueryResult, Value};
use crate::db::{Connection, DriverKind};
use crate::error::Result;

/// 1 ウォッチあたり保持する世代の上限。
pub const MAX_GENERATIONS: usize = 20;

/// 推定行数の変化を「桁違い」とみなす既定の倍率。
pub const DEFAULT_ROW_FACTOR: f64 = 10.0;

/// 保存ペイロードの種別。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PayloadKind {
    /// MySQL / PostgreSQL: 生 JSON 文字列。
    Json,
    /// SQLite: `[id, parent, detail]` 行の JSON。
    SqliteRows,
}

impl PayloadKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PayloadKind::Json => "json",
            PayloadKind::SqliteRows => "sqliteRows",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "json" => Some(PayloadKind::Json),
            "sqliteRows" => Some(PayloadKind::SqliteRows),
            _ => None,
        }
    }
}

/// 保存用スナップショット (ペイロードのみ。ドライバは世代側が持つ)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub payload_kind: PayloadKind,
    pub payload: String,
}

/// EXPLAIN の方言別プレフィックス (フロント `bundleExplainPrefix` と同じ)。
pub fn explain_prefix(driver: DriverKind) -> &'static str {
    match driver {
        DriverKind::Postgres => "EXPLAIN (FORMAT JSON) ",
        DriverKind::Sqlite => "EXPLAIN QUERY PLAN ",
        DriverKind::Mysql => "EXPLAIN FORMAT=JSON ",
    }
}

// --- JSON (キー順を保つ) ------------------------------------------------------
//
// MySQL のプランは子ノードの出現順が構造パスに効くため、`serde_json::Value`
// (feature `preserve_order` 無しでは BTreeMap = キー順ソート) は使えない。

#[derive(Debug, Clone)]
enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = J;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_unit<E>(self) -> std::result::Result<J, E> {
                Ok(J::Null)
            }
            fn visit_none<E>(self) -> std::result::Result<J, E> {
                Ok(J::Null)
            }
            fn visit_bool<E>(self, v: bool) -> std::result::Result<J, E> {
                Ok(J::Bool(v))
            }
            fn visit_i64<E>(self, v: i64) -> std::result::Result<J, E> {
                Ok(J::Num(v as f64))
            }
            fn visit_u64<E>(self, v: u64) -> std::result::Result<J, E> {
                Ok(J::Num(v as f64))
            }
            fn visit_f64<E>(self, v: f64) -> std::result::Result<J, E> {
                Ok(J::Num(v))
            }
            fn visit_str<E>(self, v: &str) -> std::result::Result<J, E> {
                Ok(J::Str(v.to_string()))
            }
            fn visit_string<E>(self, v: String) -> std::result::Result<J, E> {
                Ok(J::Str(v))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<J, A::Error> {
                let mut out = Vec::new();
                while let Some(v) = seq.next_element::<J>()? {
                    out.push(v);
                }
                Ok(J::Arr(out))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<J, A::Error> {
                let mut out: Vec<(String, J)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, J>()? {
                    // JS の JSON.parse と同じく、重複キーは最初の位置のまま値だけ上書き。
                    match out.iter_mut().find(|(ek, _)| *ek == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                }
                Ok(J::Obj(out))
            }
        }
        d.deserialize_any(V)
    }
}

fn parse_json(s: &str) -> Option<J> {
    serde_json::from_str::<J>(s).ok()
}

fn is_obj(v: &J) -> bool {
    matches!(v, J::Obj(_))
}

/// JS の `Number(s)` 相当 (空白だけ → 0)。有限でなければ `None`。
fn js_number_from_str(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// `explainPlan.parseNum`: 有限の数値、または数値に読める文字列。
fn parse_num(v: Option<&J>) -> Option<f64> {
    match v? {
        J::Num(n) if n.is_finite() => Some(*n),
        J::Str(s) => js_number_from_str(s),
        _ => None,
    }
}

/// `planDiff.asString`: 空でない文字列のみ。
fn as_string(v: Option<&J>) -> Option<String> {
    match v? {
        J::Str(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

// --- プランツリー (explainPlan.ts の PlanNode) --------------------------------

#[derive(Debug)]
struct Node {
    id: String,
    kind: String,
    /// スカラー属性 (構造的な子になるオブジェクト / 構造配列は含まない)。
    attrs: Vec<(String, J)>,
    children: Vec<Node>,
}

impl Node {
    fn attr(&self, key: &str) -> Option<&J> {
        self.attrs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }
}

fn is_scalar_array(v: &[J]) -> bool {
    v.iter().all(|x| !matches!(x, J::Arr(_) | J::Obj(_)))
}

fn collect_attrs(obj: &[(String, J)], skip: &[&str]) -> Vec<(String, J)> {
    let mut attrs = Vec::new();
    for (k, v) in obj {
        if skip.contains(&k.as_str()) {
            continue;
        }
        match v {
            J::Obj(_) => continue, // 構造的な子 (cost_info は平坦化するが ops では使わない)
            J::Arr(a) => {
                if is_scalar_array(a) {
                    attrs.push((k.clone(), v.clone()));
                }
            }
            _ => attrs.push((k.clone(), v.clone())),
        }
    }
    attrs
}

fn build_mysql_node(key: &str, obj: &[(String, J)], path: &str) -> Node {
    // `cost_info` がオブジェクトのときだけ属性側へ平坦化される (ここでは読み捨て)。
    // スカラーの `cost_info` は通常の属性として残る。
    Node {
        id: path.to_string(),
        kind: key.to_string(),
        attrs: collect_attrs(obj, &[]),
        children: build_mysql_children(obj, path),
    }
}

fn build_mysql_children(obj: &[(String, J)], path: &str) -> Vec<Node> {
    let mut out = Vec::new();
    for (k, v) in obj {
        if k == "cost_info" {
            continue;
        }
        match v {
            J::Obj(o) => out.push(build_mysql_node(k, o, &format!("{path}/{k}"))),
            J::Arr(a) if a.iter().any(is_obj) => {
                // 構造配列 (nested_loop, query_specifications, *_subqueries)。各要素は
                // 単一のサブプランを包むので、要素自身の子を直接つなぐ。
                let arr_path = format!("{path}/{k}");
                let mut children = Vec::new();
                for (i, el) in a.iter().enumerate() {
                    if let J::Obj(o) = el {
                        children.extend(build_mysql_children(o, &format!("{arr_path}/{i}")));
                    }
                }
                out.push(Node {
                    id: arr_path,
                    kind: k.clone(),
                    attrs: Vec::new(),
                    children,
                });
            }
            _ => {}
        }
    }
    out
}

fn parse_mysql_plan(json: &str) -> Option<Node> {
    let J::Obj(obj) = parse_json(json)? else {
        return None;
    };
    if let Some((_, J::Obj(qb))) = obj.iter().find(|(k, _)| k == "query_block") {
        return Some(build_mysql_node("query_block", qb, "query_block"));
    }
    Some(build_mysql_node("plan", &obj, "plan"))
}

fn build_pg_node(obj: &[(String, J)], path: &str) -> Node {
    let mut children = Vec::new();
    if let Some((_, J::Arr(plans))) = obj.iter().find(|(k, _)| k == "Plans") {
        for (i, p) in plans.iter().enumerate() {
            if let J::Obj(o) = p {
                children.push(build_pg_node(o, &format!("{path}/{i}")));
            }
        }
    }
    let kind = match obj.iter().find(|(k, _)| k == "Node Type") {
        Some((_, J::Str(s))) => s.clone(),
        _ => "plan".to_string(),
    };
    Node {
        id: path.to_string(),
        kind,
        attrs: collect_attrs(obj, &["Plans"]),
        children,
    }
}

fn parse_postgres_plan(json: &str) -> Option<Node> {
    let data = parse_json(json)?;
    let first = match data {
        J::Arr(mut a) => {
            if a.is_empty() {
                return None;
            }
            a.swap_remove(0)
        }
        other => other,
    };
    let J::Obj(first) = first else { return None };
    let plan = match first.iter().find(|(k, _)| k == "Plan") {
        Some((_, J::Obj(p))) => p.clone(),
        _ => first,
    };
    Some(build_pg_node(&plan, "plan"))
}

/// 再帰の深さ上限 (循環した parent 参照を持つ不正なペイロードでのスタック枯渇防止)。
const SQLITE_MAX_DEPTH: usize = 64;

struct SqliteRow {
    id: i64,
    parent: i64,
    detail: String,
}

fn build_sqlite_node(
    row: &SqliteRow,
    path: &str,
    by_parent: &HashMap<i64, Vec<&SqliteRow>>,
    depth: usize,
) -> Node {
    let kids: &[&SqliteRow] = if depth >= SQLITE_MAX_DEPTH {
        &[]
    } else {
        by_parent.get(&row.id).map_or(&[], Vec::as_slice)
    };
    Node {
        id: path.to_string(),
        kind: "sqliteStep".to_string(),
        attrs: vec![("detail".to_string(), J::Str(row.detail.clone()))],
        children: kids
            .iter()
            .enumerate()
            .map(|(i, k)| build_sqlite_node(k, &format!("{path}/{i}"), by_parent, depth + 1))
            .collect(),
    }
}

fn parse_sqlite_plan(rows: &[SqliteRow]) -> Option<Node> {
    let mut by_parent: HashMap<i64, Vec<&SqliteRow>> = HashMap::new();
    for r in rows {
        by_parent.entry(r.parent).or_default().push(r);
    }
    let tops = by_parent.get(&0)?;
    match tops.as_slice() {
        [] => None,
        [one] => Some(build_sqlite_node(one, "plan", &by_parent, 0)),
        many => Some(Node {
            id: "plan".to_string(),
            kind: "queryPlan".to_string(),
            attrs: Vec::new(),
            children: many
                .iter()
                .enumerate()
                .map(|(i, tp)| build_sqlite_node(tp, &format!("plan/{i}"), &by_parent, 1))
                .collect(),
        }),
    }
}

/// JS の `String(x)` 相当。
fn js_string(v: &J) -> String {
    match v {
        J::Null => "null".to_string(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => n.to_string(),
        J::Str(s) => s.clone(),
        J::Arr(_) => String::new(),
        J::Obj(_) => "[object Object]".to_string(),
    }
}

/// JS の `Number(x) || 0` 相当。
fn js_number_or_zero(v: Option<&J>) -> i64 {
    let n = match v {
        Some(J::Num(n)) => *n,
        Some(J::Str(s)) => js_number_from_str(s).unwrap_or(0.0),
        Some(J::Bool(true)) => 1.0,
        _ => 0.0,
    };
    if n.is_finite() {
        n as i64
    } else {
        0
    }
}

fn sqlite_rows_from_payload(payload: &str) -> Vec<SqliteRow> {
    let Some(J::Arr(rows)) = parse_json(payload) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|r| match r {
            J::Arr(cells) => Some(SqliteRow {
                id: js_number_or_zero(cells.first()),
                parent: js_number_or_zero(cells.get(1)),
                detail: match cells.get(2) {
                    None | Some(J::Null) => String::new(),
                    Some(v) => js_string(v),
                },
            }),
            _ => None,
        })
        .collect()
}

// --- 正規化 (planDiff.ts の PlanOp) -------------------------------------------

/// 正規化した計画の 1 オペレーション (ツリーを行きがけ順に平坦化したもの)。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanOp {
    pub path: String,
    pub kind: String,
    pub object: Option<String>,
    pub access: Option<String>,
    pub index: Option<String>,
    pub join: Option<String>,
    pub est_rows: Option<f64>,
}

#[derive(Default)]
struct OpFields {
    object: Option<String>,
    access: Option<String>,
    index: Option<String>,
    join: Option<String>,
    est_rows: Option<f64>,
}

fn mysql_fields(node: &Node) -> OpFields {
    if node.kind == "table" {
        return OpFields {
            object: as_string(node.attr("table_name")),
            access: as_string(node.attr("access_type")),
            index: as_string(node.attr("key")),
            join: as_string(node.attr("using_join_buffer")).map(|j| j.to_lowercase()),
            est_rows: parse_num(node.attr("rows_examined_per_scan")),
        };
    }
    if node.kind == "nested_loop" {
        return OpFields {
            join: Some("nested loop".to_string()),
            ..Default::default()
        };
    }
    OpFields::default()
}

fn postgres_fields(node: &Node) -> OpFields {
    let node_type = as_string(node.attr("Node Type")).unwrap_or_else(|| node.kind.clone());
    let is_scan = node_type.to_lowercase().contains("scan");
    let is_join = matches!(
        node_type.as_str(),
        "Nested Loop" | "Hash Join" | "Merge Join"
    );
    OpFields {
        object: as_string(node.attr("Relation Name")),
        access: is_scan.then(|| node_type.clone()),
        index: as_string(node.attr("Index Name")),
        join: is_join.then(|| node_type.to_lowercase()),
        est_rows: parse_num(node.attr("Plan Rows")),
    }
}

/// SQLite `EXPLAIN QUERY PLAN` の detail 行をトークンで読む。`planDiff.ts` の
/// `SQLITE_STEP_RE` (大文字小文字を区別しない) と同じ受理範囲:
///
/// ```text
/// (SCAN|SEARCH) [TABLE] <name> [AS <alias>]
///     [USING [COVERING] INDEX <index> | USING INTEGER PRIMARY KEY]
/// ```
fn sqlite_fields(node: &Node) -> OpFields {
    let detail = as_string(node.attr("detail")).unwrap_or_default();
    let tokens: Vec<&str> = detail.split_whitespace().collect();
    let eq = |i: usize, w: &str| tokens.get(i).is_some_and(|t| t.eq_ignore_ascii_case(w));
    let verb = match tokens.first() {
        Some(t) if t.eq_ignore_ascii_case("SCAN") => "SCAN",
        Some(t) if t.eq_ignore_ascii_case("SEARCH") => "SEARCH",
        _ => return OpFields::default(),
    };
    let mut i = 1;
    // `TABLE` は後ろにもう 1 トークンあるときだけ省略可能なキーワードとして読む
    // (正規表現のバックトラックと同じ: 無ければ `TABLE` 自体がテーブル名)。
    if eq(i, "TABLE") && tokens.get(i + 1).is_some() {
        i += 1;
    }
    let Some(name) = tokens.get(i) else {
        return OpFields::default();
    };
    i += 1;
    if eq(i, "AS") && tokens.get(i + 1).is_some() {
        i += 2;
    }
    let mut covering = false;
    let mut index: Option<String> = None;
    if eq(i, "USING") {
        let (cov, at) = if eq(i + 1, "COVERING") {
            (true, i + 2)
        } else {
            (false, i + 1)
        };
        if eq(at, "INDEX") {
            if let Some(ix) = tokens.get(at + 1) {
                covering = cov;
                index = Some((*ix).to_string());
            }
        }
    }
    // 位置に依らず `USING INTEGER PRIMARY KEY` を含むか (元実装の `usesPk`)。
    let uses_pk = tokens.windows(4).any(|w| {
        w[0].eq_ignore_ascii_case("USING")
            && w[1].eq_ignore_ascii_case("INTEGER")
            && w[2].eq_ignore_ascii_case("PRIMARY")
            && w[3].eq_ignore_ascii_case("KEY")
    });
    let access = if index.is_some() {
        format!(
            "{verb} USING {}INDEX",
            if covering { "COVERING " } else { "" }
        )
    } else if uses_pk {
        format!("{verb} USING INTEGER PRIMARY KEY")
    } else {
        verb.to_string()
    };
    OpFields {
        object: Some((*name).to_string()),
        access: Some(access),
        index,
        ..Default::default()
    }
}

/// パース済みツリーを方言非依存の [`PlanOp`] 列へ正規化する (行きがけ順)。
fn normalize_plan(root: Option<&Node>, driver: &str) -> Vec<PlanOp> {
    let mut ops = Vec::new();
    let Some(root) = root else { return ops };
    let fields_for: fn(&Node) -> OpFields = match driver {
        "postgres" => postgres_fields,
        "sqlite" => sqlite_fields,
        _ => mysql_fields,
    };
    fn walk(node: &Node, f: fn(&Node) -> OpFields, ops: &mut Vec<PlanOp>) {
        let o = f(node);
        ops.push(PlanOp {
            path: node.id.clone(),
            kind: node.kind.clone(),
            object: o.object,
            access: o.access,
            index: o.index,
            join: o.join,
            est_rows: o.est_rows,
        });
        for c in &node.children {
            walk(c, f, ops);
        }
    }
    walk(root, fields_for, &mut ops);
    ops
}

/// 保存ペイロードを正規化済み [`PlanOp`] 列へ復元する (パース失敗・空は空列)。
/// `driver` は `mysql` / `postgres` / `sqlite` のワイヤ名。
pub fn ops_from_payload(driver: &str, kind: PayloadKind, payload: &str) -> Vec<PlanOp> {
    let root = match (driver == "sqlite", kind) {
        (true, PayloadKind::SqliteRows) => parse_sqlite_plan(&sqlite_rows_from_payload(payload)),
        (false, PayloadKind::Json) if !payload.is_empty() => {
            if driver == "postgres" {
                parse_postgres_plan(payload)
            } else {
                parse_mysql_plan(payload)
            }
        }
        _ => None,
    };
    normalize_plan(root.as_ref(), driver)
}

/// 推定行数の「桁」(log10 の床)。null は不明、0 以下は 0 桁。
pub fn rows_magnitude(rows: Option<f64>) -> Option<i64> {
    let r = rows?;
    if r <= 0.0 {
        return Some(0);
    }
    Some(r.log10().floor() as i64)
}

/// 計画の同一判定に使うフィンガープリント (構造・アクセス方式・インデックス・結合方式
/// と推定行数の**桁**のみ)。`planDiff.planFingerprint` と同じ JSON 文字列。
pub fn plan_fingerprint(ops: &[PlanOp]) -> String {
    let rows: Vec<_> = ops
        .iter()
        .map(|o| {
            (
                &o.path,
                &o.kind,
                &o.object,
                &o.access,
                &o.index,
                &o.join,
                rows_magnitude(o.est_rows),
            )
        })
        .collect();
    serde_json::to_string(&rows).unwrap_or_default()
}

// --- 比較 (planDiff.ts の comparePlans) ---------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanChangeKind {
    Access,
    Index,
    Join,
    EstRows,
    OpAdded,
    OpRemoved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanChangeSeverity {
    Info,
    Warning,
}

/// 2 世代間で検知した 1 件の変化。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanChange {
    pub kind: PlanChangeKind,
    pub severity: PlanChangeSeverity,
    pub path: String,
    pub object: String,
    pub before: Option<String>,
    pub after: Option<String>,
}

/// アクセス方式がフルスキャン (テーブル全読み) を表すか (3 方言対応)。
pub fn is_full_scan_access(access: Option<&str>) -> bool {
    match access {
        None => false,
        Some(a) => {
            a == "ALL" || a.eq_ignore_ascii_case("seq scan") || a.eq_ignore_ascii_case("SCAN")
        }
    }
}

fn op_display_name(op: &PlanOp) -> String {
    op.object.clone().unwrap_or_else(|| op.kind.clone())
}

struct Pairing {
    pairs: Vec<(usize, usize)>,
    removed: Vec<usize>,
    added: Vec<usize>,
}

fn pair_ops(prev: &[PlanOp], next: &[PlanOp]) -> Pairing {
    let mut pairs = Vec::new();
    // `new Map(next.map(o => [o.path, o]))` と同じく、同一パスは後勝ち。
    let mut next_by_path: HashMap<&str, usize> = HashMap::new();
    for (i, o) in next.iter().enumerate() {
        next_by_path.insert(o.path.as_str(), i);
    }
    let mut matched = vec![false; next.len()];
    let mut unmatched_prev = Vec::new();
    // 第一パス: 構造パス + 対象オブジェクトの一致でペアリング。
    for (pi, p) in prev.iter().enumerate() {
        match next_by_path.get(p.path.as_str()) {
            Some(&ni) if !matched[ni] && p.object == next[ni].object => {
                pairs.push((pi, ni));
                matched[ni] = true;
            }
            _ => unmatched_prev.push(pi),
        }
    }
    // 第二パス: ノード挿入で配列インデックスがずれたケースを、オブジェクト名 +
    // 種別の一致で救済する (先勝ち)。
    let mut removed = Vec::new();
    for pi in unmatched_prev {
        let p = &prev[pi];
        let hit = (0..next.len()).find(|&ni| {
            !matched[ni]
                && next[ni].object.is_some()
                && next[ni].object == p.object
                && next[ni].kind == p.kind
        });
        match hit {
            Some(ni) => {
                pairs.push((pi, ni));
                matched[ni] = true;
            }
            None => removed.push(pi),
        }
    }
    let added = (0..next.len()).filter(|&ni| !matched[ni]).collect();
    Pairing {
        pairs,
        removed,
        added,
    }
}

/// 2 世代の正規化済み計画を比較して重要な変化を列挙する。検知対象はアクセス方式・
/// 使用インデックス・結合方式の変化と、推定行数の `row_factor` 倍以上の変化、および
/// オペレーションの追加/削除。コスト値は見ない。
pub fn compare_plans(prev: &[PlanOp], next: &[PlanOp], row_factor: f64) -> Vec<PlanChange> {
    let row_factor = row_factor.max(2.0);
    let mut changes = Vec::new();
    let Pairing {
        pairs,
        removed,
        added,
    } = pair_ops(prev, next);
    for (pi, ni) in pairs {
        let (p, n) = (&prev[pi], &next[ni]);
        if p.access != n.access {
            changes.push(PlanChange {
                kind: PlanChangeKind::Access,
                // インデックスが効いていた読みがフルスキャンへ退行したときだけ警告。
                severity: if is_full_scan_access(n.access.as_deref())
                    && !is_full_scan_access(p.access.as_deref())
                {
                    PlanChangeSeverity::Warning
                } else {
                    PlanChangeSeverity::Info
                },
                path: n.path.clone(),
                object: op_display_name(n),
                before: p.access.clone(),
                after: n.access.clone(),
            });
        } else if p.index != n.index {
            changes.push(PlanChange {
                kind: PlanChangeKind::Index,
                severity: if n.index.is_none() {
                    PlanChangeSeverity::Warning
                } else {
                    PlanChangeSeverity::Info
                },
                path: n.path.clone(),
                object: op_display_name(n),
                before: p.index.clone(),
                after: n.index.clone(),
            });
        }
        if p.join != n.join {
            changes.push(PlanChange {
                kind: PlanChangeKind::Join,
                severity: PlanChangeSeverity::Info,
                path: n.path.clone(),
                object: op_display_name(n),
                before: p.join.clone(),
                after: n.join.clone(),
            });
        }
        if let (Some(pr), Some(nr)) = (p.est_rows, n.est_rows) {
            if pr != nr {
                let lo = pr.min(nr).max(1.0);
                let hi = pr.max(nr);
                if hi / lo >= row_factor {
                    changes.push(PlanChange {
                        kind: PlanChangeKind::EstRows,
                        severity: if nr > pr {
                            PlanChangeSeverity::Warning
                        } else {
                            PlanChangeSeverity::Info
                        },
                        path: n.path.clone(),
                        object: op_display_name(n),
                        before: Some(pr.to_string()),
                        after: Some(nr.to_string()),
                    });
                }
            }
        }
    }
    for pi in removed {
        let p = &prev[pi];
        changes.push(PlanChange {
            kind: PlanChangeKind::OpRemoved,
            severity: PlanChangeSeverity::Info,
            path: p.path.clone(),
            object: op_display_name(p),
            before: Some(p.access.clone().unwrap_or_else(|| p.kind.clone())),
            after: None,
        });
    }
    for ni in added {
        let n = &next[ni];
        changes.push(PlanChange {
            kind: PlanChangeKind::OpAdded,
            // 追加されたノードがフルスキャンなら退行の疑いが強いので警告。
            severity: if is_full_scan_access(n.access.as_deref()) {
                PlanChangeSeverity::Warning
            } else {
                PlanChangeSeverity::Info
            },
            path: n.path.clone(),
            object: op_display_name(n),
            before: None,
            after: Some(n.access.clone().unwrap_or_else(|| n.kind.clone())),
        });
    }
    changes
}

// --- EXPLAIN 結果 → スナップショット -----------------------------------------

fn value_to_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Int(i) => Some(i.to_string()),
        Value::UInt(u) => Some(u.to_string()),
        Value::Float(f) => Some(f.to_string()),
        Value::String(s) | Value::Bytes(s) => Some(s.clone()),
    }
}

fn value_to_number_or_zero(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Int(i)) => *i,
        Some(Value::UInt(u)) => i64::try_from(*u).unwrap_or(0),
        Some(Value::Float(f)) if f.is_finite() => *f as i64,
        Some(Value::String(s)) => js_number_from_str(s).map_or(0, |n| n as i64),
        Some(Value::Bool(true)) => 1,
        _ => 0,
    }
}

/// EXPLAIN の [`QueryResult`] から保存用スナップショットを作る。空結果は `None`。
pub fn snapshot_from_result(driver: DriverKind, result: &QueryResult) -> Option<Snapshot> {
    if result.rows.is_empty() {
        return None;
    }
    if driver == DriverKind::Sqlite {
        let rows: Vec<(i64, i64, String)> = result
            .rows
            .iter()
            .map(|r| {
                let detail = r
                    .get(3)
                    .and_then(value_to_string)
                    .or_else(|| r.last().and_then(value_to_string))
                    .unwrap_or_default();
                (
                    value_to_number_or_zero(r.first()),
                    value_to_number_or_zero(r.get(1)),
                    detail,
                )
            })
            .collect();
        return Some(Snapshot {
            payload_kind: PayloadKind::SqliteRows,
            payload: serde_json::to_string(&rows).ok()?,
        });
    }
    let cell = result.rows.first()?.first()?;
    Some(Snapshot {
        payload_kind: PayloadKind::Json,
        payload: value_to_string(cell)?,
    })
}

/// `sql` の EXPLAIN を実行してスナップショットを返す。履歴・クエリキャッシュを
/// 経由しない (計画の変化を見るので常に最新を取る)。読み取り専用ガードは呼び出し側
/// (`ensure_allowed_for_session`) が済ませている前提。
pub async fn explain_snapshot(conn: &Connection, sql: &str) -> Result<Option<Snapshot>> {
    let driver = conn.driver_kind();
    let explain_sql = format!("{}{}", explain_prefix(driver), sql);
    let result = conn.execute_explain(&explain_sql, None).await?;
    Ok(snapshot_from_result(driver, &result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MYSQL_PLAN: &str = r#"{"query_block":{"select_id":1,"cost_info":{"query_cost":"1.20"},
        "nested_loop":[
          {"table":{"table_name":"a","access_type":"ALL","rows_examined_per_scan":1000}},
          {"table":{"table_name":"b","access_type":"ref","key":"ix_b","rows_examined_per_scan":3,
                    "using_join_buffer":"hash join"}}]}}"#;

    fn mysql_ops(json: &str) -> Vec<PlanOp> {
        ops_from_payload("mysql", PayloadKind::Json, json)
    }

    #[test]
    fn mysql_ops_follow_key_order_and_paths() {
        let ops = mysql_ops(MYSQL_PLAN);
        let paths: Vec<&str> = ops.iter().map(|o| o.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "query_block",
                "query_block/nested_loop",
                "query_block/nested_loop/0/table",
                "query_block/nested_loop/1/table"
            ]
        );
        assert_eq!(ops[2].object.as_deref(), Some("a"));
        assert_eq!(ops[2].access.as_deref(), Some("ALL"));
        assert_eq!(ops[3].index.as_deref(), Some("ix_b"));
        assert_eq!(ops[3].join.as_deref(), Some("hash join"));
        assert_eq!(ops[2].est_rows, Some(1000.0));
    }

    #[test]
    fn mysql_children_keep_document_order_not_alphabetical() {
        // serde_json の既定 (BTreeMap) だと "a_op" が先に並んでしまう。
        let ops = mysql_ops(
            r#"{"query_block":{"z_op":{"table":{"table_name":"z"}},"a_op":{"table":{"table_name":"a"}}}}"#,
        );
        let paths: Vec<&str> = ops.iter().map(|o| o.path.as_str()).collect();
        assert_eq!(paths[1], "query_block/z_op");
        assert_eq!(paths[3], "query_block/a_op");
    }

    #[test]
    fn unparseable_or_empty_payloads_yield_no_ops() {
        assert!(mysql_ops("not json").is_empty());
        assert!(mysql_ops("").is_empty());
        assert!(mysql_ops("[1,2]").is_empty());
        assert!(ops_from_payload("postgres", PayloadKind::Json, "[]").is_empty());
        assert!(ops_from_payload("sqlite", PayloadKind::Json, "[]").is_empty());
    }

    #[test]
    fn postgres_ops_classify_scans_and_joins() {
        let plan = json!([{"Plan":{"Node Type":"Hash Join","Plan Rows":50,"Plans":[
            {"Node Type":"Seq Scan","Relation Name":"a","Plan Rows":1000},
            {"Node Type":"Index Scan","Relation Name":"b","Index Name":"b_pkey","Plan Rows":1}]}}])
        .to_string();
        let ops = ops_from_payload("postgres", PayloadKind::Json, &plan);
        assert_eq!(ops.len(), 3);
        assert_eq!(ops[0].join.as_deref(), Some("hash join"));
        assert_eq!(ops[0].access, None);
        assert_eq!(ops[1].access.as_deref(), Some("Seq Scan"));
        assert_eq!(ops[2].index.as_deref(), Some("b_pkey"));
        assert_eq!(ops[2].path, "plan/1");
    }

    #[test]
    fn sqlite_ops_read_scan_search_steps() {
        let payload = r#"[[2,0,"SEARCH t USING INDEX ix_a (a=?)"],[3,0,"SCAN u"],
            [4,0,"SEARCH v USING COVERING INDEX ix_v (x=?)"],
            [5,0,"SEARCH w USING INTEGER PRIMARY KEY (rowid=?)"]]"#;
        let ops = ops_from_payload("sqlite", PayloadKind::SqliteRows, payload);
        // トップが複数なので合成ルート "queryPlan" が先頭に立つ。
        assert_eq!(ops[0].kind, "queryPlan");
        assert_eq!(ops[1].access.as_deref(), Some("SEARCH USING INDEX"));
        assert_eq!(ops[1].index.as_deref(), Some("ix_a"));
        assert_eq!(ops[2].access.as_deref(), Some("SCAN"));
        assert_eq!(
            ops[3].access.as_deref(),
            Some("SEARCH USING COVERING INDEX")
        );
        assert_eq!(
            ops[4].access.as_deref(),
            Some("SEARCH USING INTEGER PRIMARY KEY")
        );
    }

    #[test]
    fn sqlite_detail_parser_handles_table_keyword_alias_and_case() {
        let f = |detail: &str| {
            let n = Node {
                id: "plan".into(),
                kind: "sqliteStep".into(),
                attrs: vec![("detail".into(), J::Str(detail.into()))],
                children: vec![],
            };
            sqlite_fields(&n)
        };
        let a = f("scan table t as x using index ix (a=?)");
        assert_eq!(a.object.as_deref(), Some("t"));
        assert_eq!(a.access.as_deref(), Some("SCAN USING INDEX"));
        assert_eq!(a.index.as_deref(), Some("ix"));
        // `TABLE` だけのときは TABLE 自体がテーブル名。
        assert_eq!(f("SCAN TABLE").object.as_deref(), Some("TABLE"));
        assert!(f("USE TEMP B-TREE FOR ORDER BY").object.is_none());
        assert!(f("").object.is_none());
    }

    #[test]
    fn sqlite_cyclic_parent_links_do_not_overflow_the_stack() {
        // id 0 の行が parent 0 (自分自身) を指す不正なペイロード。
        let ops = ops_from_payload("sqlite", PayloadKind::SqliteRows, r#"[[0,0,"SCAN t"]]"#);
        assert!(!ops.is_empty());
        assert!(ops.len() <= SQLITE_MAX_DEPTH + 2);
    }

    #[test]
    fn fingerprint_ignores_small_row_changes_but_not_magnitude() {
        let a = mysql_ops(MYSQL_PLAN);
        let b = mysql_ops(&MYSQL_PLAN.replace("1000", "5000"));
        let c = mysql_ops(&MYSQL_PLAN.replace("1000", "100000"));
        assert_eq!(plan_fingerprint(&a), plan_fingerprint(&b));
        assert_ne!(plan_fingerprint(&a), plan_fingerprint(&c));
    }

    #[test]
    fn compare_flags_index_to_full_scan_regression_as_warning() {
        let prev = mysql_ops(
            r#"{"query_block":{"table":{"table_name":"t","access_type":"ref","key":"ix"}}}"#,
        );
        let next = mysql_ops(r#"{"query_block":{"table":{"table_name":"t","access_type":"ALL"}}}"#);
        let changes = compare_plans(&prev, &next, DEFAULT_ROW_FACTOR);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, PlanChangeKind::Access);
        assert_eq!(changes[0].severity, PlanChangeSeverity::Warning);
        assert!(compare_plans(&prev, &prev, DEFAULT_ROW_FACTOR).is_empty());
    }

    #[test]
    fn compare_detects_row_magnitude_added_and_removed_ops() {
        let prev = mysql_ops(
            r#"{"query_block":{"table":{"table_name":"t","access_type":"ALL","rows_examined_per_scan":10}}}"#,
        );
        let next = mysql_ops(
            r#"{"query_block":{"table":{"table_name":"t","access_type":"ALL","rows_examined_per_scan":1000}}}"#,
        );
        let changes = compare_plans(&prev, &next, DEFAULT_ROW_FACTOR);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].kind, PlanChangeKind::EstRows);
        assert_eq!(changes[0].severity, PlanChangeSeverity::Warning);
        let joined = mysql_ops(MYSQL_PLAN);
        let only_a = mysql_ops(
            r#"{"query_block":{"nested_loop":[{"table":{"table_name":"a","access_type":"ALL","rows_examined_per_scan":1000}}]}}"#,
        );
        let removed = compare_plans(&joined, &only_a, DEFAULT_ROW_FACTOR);
        assert!(removed
            .iter()
            .any(|c| c.kind == PlanChangeKind::OpRemoved && c.object == "b"));
        let added = compare_plans(&only_a, &joined, DEFAULT_ROW_FACTOR);
        assert!(added
            .iter()
            .any(|c| c.kind == PlanChangeKind::OpAdded && c.object == "b"));
    }

    fn result(rows: Vec<Vec<Value>>) -> QueryResult {
        QueryResult {
            columns: vec![],
            rows,
            rows_affected: 0,
            elapsed_ms: 0,
            server_messages: vec![],
        }
    }

    #[test]
    fn snapshot_from_result_handles_each_dialect() {
        assert!(snapshot_from_result(DriverKind::Mysql, &result(vec![])).is_none());
        let mysql = snapshot_from_result(
            DriverKind::Mysql,
            &result(vec![vec![Value::String("{\"a\":1}".into())]]),
        )
        .unwrap();
        assert_eq!(mysql.payload_kind, PayloadKind::Json);
        assert_eq!(mysql.payload, "{\"a\":1}");
        assert!(
            snapshot_from_result(DriverKind::Postgres, &result(vec![vec![Value::Null]])).is_none()
        );
        let sqlite = snapshot_from_result(
            DriverKind::Sqlite,
            &result(vec![vec![
                Value::Int(2),
                Value::Int(0),
                Value::Int(0),
                Value::String("SCAN t".into()),
            ]]),
        )
        .unwrap();
        assert_eq!(sqlite.payload_kind, PayloadKind::SqliteRows);
        assert_eq!(sqlite.payload, r#"[[2,0,"SCAN t"]]"#);
    }

    #[test]
    fn explain_prefix_matches_the_frontend_bundle_prefix() {
        assert_eq!(explain_prefix(DriverKind::Mysql), "EXPLAIN FORMAT=JSON ");
        assert_eq!(
            explain_prefix(DriverKind::Postgres),
            "EXPLAIN (FORMAT JSON) "
        );
        assert_eq!(explain_prefix(DriverKind::Sqlite), "EXPLAIN QUERY PLAN ");
    }
}
