//! サブセット抽出 (#2241) の純粋層 — 外部キーを行単位で辿り、参照整合性を保ったまま
//! 「一部の行だけ」を取り出す計画と、表ごとの取得 SQL を組み立てる。
//!
//! 起点の表と条件で選んだ行 (起点) から、次の 2 方向へ辿る。
//!
//! - **親の方向** (行が参照している行): 参照整合性に必須なので、**常に最後まで**辿る。
//!   起点の行だけでなく、子の方向で足した行の親も含める。親の行の親もさらに辿る。
//! - **子の方向** (行を参照している行): 任意。辿る**段数** (`child_depth`) と、表ごとの
//!   **件数** (`child_row_limit`) に上限を付ける。上限で打ち切った表は [`SubsetWarning`] で
//!   知らせる。子の方向で足した行の「他の子」は辿らない (親の方向だけが整合性に必須)。
//!
//! I/O は持たない。[`SubsetWalk`] は「次に取得すべき行の要求 ([`FetchRequest`]) を返し、
//! 取得結果を受け取る」状態機械で、`commands::subset` が実 DB で駆動し、単体テストは
//! 小さな擬似 DB で駆動する。`WHERE (k) IN (...)` はキーをチャンクに分け、複合キーは
//! 3 ドライバで共通に通る `(a = x AND b = y) OR ...` で組む (SQLite は行値の `IN` の右辺に
//! 値リストを書けないため)。
//!
//! ## 境界の扱い
//!
//! - **NULL の外部キー**: 構成列のどれかが NULL の行は参照していないものとして辿らない
//!   (`MATCH SIMPLE`)。
//! - **自己参照**: 同じ表の親子として辿る。重複は行の同一性 (主キー、無ければ全列) で除く
//!   ので、循環しても止まる。出力順は [`order_self_referencing`] で「参照される行が先」にする。
//! - **循環参照**: 表の取得順 ([`table_order`]) は強連結成分にまとめ、成分内は名前順で並べて
//!   [`SubsetWarning::Cycle`] を返す。行の取得そのものは同一性の重複排除で必ず止まる。
//! - **複合キー**: 構成列ごとに対応付けた列組で辿る。
//! - 暗黙の参照先 (SQLite の `REFERENCES t` で列を省略) は、参照先の主キー列に解決する。
//!   列数が合わないものは辿れないので [`SubsetWarning::UnresolvedForeignKey`] にする。
//! - 主キーの無い表は全列で行を同一視する (まったく同じ行は 1 行にまとまる)。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use serde::Serialize;

use super::data_diff::{
    is_binary_type, is_hex_wire, is_numeric_literal, key_signature, sql_literal,
};
use super::sync::quote_ident;
use super::types::{ForeignKey, Value};
use super::DriverKind;
use crate::error::{AppError, Result};

/// 1 回の取得 SQL に入れるキーの数 (単一列)。
pub const KEY_CHUNK: usize = 500;
/// 複合キーの 1 回あたりのキー数 (条件式が長くなるので単一列より少なくする)。
pub const COMPOSITE_KEY_CHUNK: usize = 100;
/// 起点の行数の既定値と上限。
pub const DEFAULT_ROOT_ROW_LIMIT: u64 = 1_000;
pub const MAX_ROOT_ROW_LIMIT: u64 = 100_000;
/// 子の方向で表ごとに足す行数の既定値と上限。
pub const DEFAULT_CHILD_ROW_LIMIT: u64 = 1_000;
pub const MAX_CHILD_ROW_LIMIT: u64 = 100_000;
/// 子の方向へ辿る段数の上限。
pub const MAX_CHILD_DEPTH: u32 = 5;
/// 抽出全体の行数の上限 (メモリに載せるため)。親の方向は打ち切れない (整合性が壊れる)
/// ので、超えたら黙って切らずに失敗させる。
pub const MAX_TOTAL_ROWS: u64 = 200_000;

/// 起点の行数の指定を `[1, MAX_ROOT_ROW_LIMIT]` に収める。未指定 / 0 は既定値。
pub fn clamp_root_row_limit(limit: Option<u64>) -> u64 {
    limit
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_ROOT_ROW_LIMIT)
        .min(MAX_ROOT_ROW_LIMIT)
}

/// 子の方向の件数の指定を `[1, MAX_CHILD_ROW_LIMIT]` に収める。未指定 / 0 は既定値。
pub fn clamp_child_row_limit(limit: Option<u64>) -> u64 {
    limit
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_CHILD_ROW_LIMIT)
        .min(MAX_CHILD_ROW_LIMIT)
}

/// 子の方向の段数の指定を `[0, MAX_CHILD_DEPTH]` に収める。未指定は 0 (子は辿らない)。
pub fn clamp_child_depth(depth: Option<u32>) -> u32 {
    depth.unwrap_or(0).min(MAX_CHILD_DEPTH)
}

/// 抽出計画の注意。UI が翻訳して表示する。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SubsetWarning {
    /// 外部キーが循環している表のまとまり。取り込み先で FK 違反にならない順序は決まらない。
    Cycle { tables: Vec<String> },
    /// 参照先の列を決められず、辿れなかった外部キー。
    #[serde(rename_all = "camelCase")]
    UnresolvedForeignKey { table: String, constraint: String },
    /// 子の方向の件数の上限で打ち切った表。
    #[serde(rename_all = "camelCase")]
    ChildTruncated { table: String, limit: u64 },
    /// 起点の行数の上限で打ち切った。
    #[serde(rename_all = "camelCase")]
    RootTruncated { table: String, limit: u64 },
}

/// 1 つの外部キー制約 (複合キーは構成列をまとめたもの)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FkGroup {
    pub constraint: String,
    pub child: String,
    pub child_cols: Vec<String>,
    pub parent: String,
    /// 参照先の列。暗黙の参照 (`REFERENCES t`) では `None` (参照先の主キーに解決する)。
    pub parent_cols: Option<Vec<String>>,
}

/// `ForeignKey` (参照元の列ごとに 1 件) を制約ごとにまとめる。制約名の無いものは
/// 列ごとに独立した単一列の外部キーとして扱う。
pub fn group_foreign_keys(fks: &[ForeignKey]) -> Vec<FkGroup> {
    let mut groups: Vec<FkGroup> = Vec::new();
    let mut index_of: HashMap<(String, String), usize> = HashMap::new();
    for (i, fk) in fks.iter().enumerate() {
        let (key, name) = match &fk.constraint_name {
            Some(n) => ((fk.table.clone(), n.clone()), n.clone()),
            None => (
                (fk.table.clone(), format!("\u{0}unnamed:{i}")),
                format!("{}:{i}", fk.table),
            ),
        };
        match index_of.get(&key) {
            Some(&gi) => {
                groups[gi].child_cols.push(fk.column.clone());
                match (&mut groups[gi].parent_cols, &fk.referenced_column) {
                    (Some(cols), Some(c)) => cols.push(c.clone()),
                    _ => groups[gi].parent_cols = None,
                }
            }
            None => {
                index_of.insert(key, groups.len());
                groups.push(FkGroup {
                    constraint: name,
                    child: fk.table.clone(),
                    child_cols: vec![fk.column.clone()],
                    parent: fk.referenced_table.clone(),
                    parent_cols: fk.referenced_column.clone().map(|c| vec![c]),
                });
            }
        }
    }
    groups
}

/// 抽出が触れうる表の集合。起点から、子の方向へ `child_depth` 段 (表の水準での
/// 上限の見積もり)、その後に全員の親を不動点まで足す。列メタデータを取る範囲を決めるのに使う。
pub fn reachable_tables(
    roots: &[String],
    groups: &[FkGroup],
    child_depth: u32,
) -> BTreeSet<String> {
    let mut set: BTreeSet<String> = roots.iter().cloned().collect();
    let mut frontier: BTreeSet<String> = set.clone();
    for _ in 0..child_depth {
        let next: BTreeSet<String> = groups
            .iter()
            .filter(|g| frontier.contains(&g.parent))
            .map(|g| g.child.clone())
            .collect();
        if next.is_empty() {
            break;
        }
        set.extend(next.iter().cloned());
        frontier = next;
    }
    loop {
        let before = set.len();
        for g in groups {
            if set.contains(&g.child) {
                set.insert(g.parent.clone());
            }
        }
        if set.len() == before {
            break;
        }
    }
    set
}

/// 抽出が扱う表 1 つのメタデータ。`columns` は取得 / 出力する列 (生成列を除く)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubsetTable {
    pub name: String,
    pub columns: Vec<String>,
    /// `columns` と同じ並びの型名 (キーのリテラルの書き方を決める)。
    pub column_types: Vec<String>,
    /// 主キーの列 (列の並び順)。無ければ空。
    pub primary_key: Vec<String>,
}

impl SubsetTable {
    fn col_index(&self, name: &str) -> Option<usize> {
        self.columns.iter().position(|c| c == name)
    }

    /// 行の同一性に使う列の位置 (主キー。無ければ全列)。
    fn identity_indices(&self) -> Vec<usize> {
        let pk: Vec<usize> = self
            .primary_key
            .iter()
            .filter_map(|c| self.col_index(c))
            .collect();
        if pk.is_empty() || pk.len() != self.primary_key.len() {
            (0..self.columns.len()).collect()
        } else {
            pk
        }
    }
}

/// 辿れる外部キー (列が解決済み)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubsetEdge {
    pub constraint: String,
    pub child: String,
    pub child_cols: Vec<String>,
    pub parent: String,
    pub parent_cols: Vec<String>,
}

/// 外部キーを、メタデータが揃った表同士の辺に解決する。メタデータに無い表への外部キーは
/// 抽出範囲の外なので黙って捨てる。参照先の列を決められないもの (暗黙の参照で列数が
/// 合わない、列が取得対象に無い) は警告にして辿らない。
pub fn resolve_edges(
    groups: &[FkGroup],
    tables: &BTreeMap<String, SubsetTable>,
) -> (Vec<SubsetEdge>, Vec<SubsetWarning>) {
    let mut edges = Vec::new();
    let mut warnings = Vec::new();
    for g in groups {
        let (Some(child), Some(parent)) = (tables.get(&g.child), tables.get(&g.parent)) else {
            continue;
        };
        let parent_cols = match &g.parent_cols {
            Some(c) => c.clone(),
            None => parent.primary_key.clone(),
        };
        let ok = !parent_cols.is_empty()
            && parent_cols.len() == g.child_cols.len()
            && g.child_cols.iter().all(|c| child.col_index(c).is_some())
            && parent_cols.iter().all(|c| parent.col_index(c).is_some());
        if !ok {
            warnings.push(SubsetWarning::UnresolvedForeignKey {
                table: g.child.clone(),
                constraint: g.constraint.clone(),
            });
            continue;
        }
        edges.push(SubsetEdge {
            constraint: g.constraint.clone(),
            child: g.child.clone(),
            child_cols: g.child_cols.clone(),
            parent: g.parent.clone(),
            parent_cols,
        });
    }
    (edges, warnings)
}

/// 取得順 (親が先) と、循環している表のまとまり。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableOrder {
    pub order: Vec<String>,
    pub cycles: Vec<Vec<String>>,
}

/// `tables` を「親が先、子が後」の順に並べる。自己参照は無視する。循環は強連結成分
/// (Tarjan) にまとめ、成分の中は名前順で並べる。同じ入力には必ず同じ順を返す。
pub fn table_order(tables: &BTreeSet<String>, edges: &[SubsetEdge]) -> TableOrder {
    // 子 -> 親 (依存先)。
    let mut deps: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for t in tables {
        deps.entry(t.as_str()).or_default();
    }
    for e in edges {
        if e.child != e.parent && tables.contains(&e.child) && tables.contains(&e.parent) {
            deps.entry(e.child.as_str())
                .or_default()
                .insert(e.parent.as_str());
        }
    }

    struct Tarjan<'a> {
        deps: &'a BTreeMap<&'a str, BTreeSet<&'a str>>,
        index: HashMap<&'a str, usize>,
        low: HashMap<&'a str, usize>,
        on_stack: HashSet<&'a str>,
        stack: Vec<&'a str>,
        counter: usize,
        out: Vec<Vec<&'a str>>,
    }
    impl<'a> Tarjan<'a> {
        fn visit(&mut self, v: &'a str) {
            self.index.insert(v, self.counter);
            self.low.insert(v, self.counter);
            self.counter += 1;
            self.stack.push(v);
            self.on_stack.insert(v);
            let next: Vec<&'a str> = self
                .deps
                .get(v)
                .map(|s| s.iter().copied().collect())
                .unwrap_or_default();
            for w in next {
                if !self.index.contains_key(w) {
                    self.visit(w);
                    let lw = self.low.get(w).copied().unwrap_or(usize::MAX);
                    let lv = self.low.get(v).copied().unwrap_or(usize::MAX);
                    self.low.insert(v, lv.min(lw));
                } else if self.on_stack.contains(w) {
                    let iw = self.index.get(w).copied().unwrap_or(usize::MAX);
                    let lv = self.low.get(v).copied().unwrap_or(usize::MAX);
                    self.low.insert(v, lv.min(iw));
                }
            }
            if self.low.get(v) == self.index.get(v) {
                let mut comp = Vec::new();
                while let Some(w) = self.stack.pop() {
                    self.on_stack.remove(w);
                    comp.push(w);
                    if w == v {
                        break;
                    }
                }
                comp.sort_unstable();
                self.out.push(comp);
            }
        }
    }

    let mut t = Tarjan {
        deps: &deps,
        index: HashMap::new(),
        low: HashMap::new(),
        on_stack: HashSet::new(),
        stack: Vec::new(),
        counter: 0,
        out: Vec::new(),
    };
    for v in deps.keys() {
        if !t.index.contains_key(v) {
            t.visit(v);
        }
    }
    // Tarjan は「依存先 (親) の成分が先」の順で成分を出す。
    let mut order = Vec::with_capacity(tables.len());
    let mut cycles = Vec::new();
    for comp in t.out {
        if comp.len() > 1 {
            cycles.push(comp.iter().map(|s| s.to_string()).collect());
        }
        order.extend(comp.into_iter().map(str::to_string));
    }
    TableOrder { order, cycles }
}

/// 文字列を小文字化し末尾の空白を除いた、照合順序の差を吸収するシグネチャ。
fn loose_signature(key: &[Value]) -> String {
    let norm: Vec<Value> = key
        .iter()
        .map(|v| match v {
            Value::String(s) => Value::String(s.trim_end().to_lowercase()),
            other => other.clone(),
        })
        .collect();
    key_signature(&norm)
}

/// 他のデータベースの表を指す外部キー ((参照元の表, 制約名) の組) を、辿る対象から外す。
/// 外した制約は辿れなかった外部キーの警告にする。MySQL の外部キー一覧は参照先の表名しか
/// 持たないので、同名の表が手元の DB にあると無関係な表として辿ってしまうのを防ぐ。
pub fn exclude_cross_database_groups(
    groups: Vec<FkGroup>,
    cross: &BTreeSet<(String, String)>,
) -> (Vec<FkGroup>, Vec<SubsetWarning>) {
    let mut kept = Vec::with_capacity(groups.len());
    let mut warnings = Vec::new();
    for g in groups {
        if cross.contains(&(g.child.clone(), g.constraint.clone())) {
            warnings.push(SubsetWarning::UnresolvedForeignKey {
                table: g.child,
                constraint: g.constraint,
            });
        } else {
            kept.push(g);
        }
    }
    (kept, warnings)
}

/// 自己参照の外部キーを持つ表の行を、「参照される行が先」の順に並べ直す。
/// 取り込み先で行ごとに FK が検査される場合に、親の行が先に入るようにするため。
/// 循環している行は元の相対順のまま。
pub fn order_self_referencing(
    rows: Vec<Vec<Value>>,
    table: &SubsetTable,
    edges: &[SubsetEdge],
) -> Vec<Vec<Value>> {
    let self_edges: Vec<&SubsetEdge> = edges
        .iter()
        .filter(|e| e.child == table.name && e.parent == table.name)
        .collect();
    if self_edges.is_empty() || rows.len() < 2 {
        return rows;
    }
    // 辺ごとに「参照先キー → 行番号」を作る。
    // 完全一致 (key_signature) の表と、大文字小文字・末尾空白を無視した表 (MySQL の既定の照合順序では
    // 'boss' が 'BOSS' を参照できる) の 2 つを持つ。
    let mut by_parent_key: Vec<HashMap<String, usize>> = Vec::new();
    let mut by_parent_loose: Vec<HashMap<String, usize>> = Vec::new();
    for e in &self_edges {
        let idx: Vec<usize> = e
            .parent_cols
            .iter()
            .filter_map(|c| table.col_index(c))
            .collect();
        let mut m = HashMap::new();
        let mut loose = HashMap::new();
        for (i, r) in rows.iter().enumerate() {
            let key: Vec<Value> = idx.iter().filter_map(|&k| r.get(k).cloned()).collect();
            if key.len() == idx.len() {
                m.entry(key_signature(&key)).or_insert(i);
                loose.entry(loose_signature(&key)).or_insert(i);
            }
        }
        by_parent_key.push(m);
        by_parent_loose.push(loose);
    }
    let mut deps: Vec<Vec<usize>> = vec![Vec::new(); rows.len()];
    for (ei, e) in self_edges.iter().enumerate() {
        let idx: Vec<usize> = e
            .child_cols
            .iter()
            .filter_map(|c| table.col_index(c))
            .collect();
        for (i, r) in rows.iter().enumerate() {
            let key: Vec<Value> = idx.iter().filter_map(|&k| r.get(k).cloned()).collect();
            if key.len() != idx.len() || key.iter().any(|v| matches!(v, Value::Null)) {
                continue;
            }
            let found = by_parent_key[ei]
                .get(&key_signature(&key))
                .or_else(|| by_parent_loose[ei].get(&loose_signature(&key)));
            if let Some(&p) = found {
                if p != i {
                    deps[i].push(p);
                }
            }
        }
    }
    // 依存を先に出す深さ優先 (連鎖が長くてもスタックを使い切らないよう明示スタック)。
    let mut state = vec![0u8; rows.len()]; // 0: 未訪問 / 1: 訪問中 / 2: 出力済み
    let mut order: Vec<usize> = Vec::with_capacity(rows.len());
    for start in 0..rows.len() {
        if state[start] != 0 {
            continue;
        }
        let mut stack: Vec<(usize, usize)> = vec![(start, 0)];
        state[start] = 1;
        while let Some((node, next_dep)) = stack.pop() {
            if let Some(&d) = deps[node].get(next_dep) {
                stack.push((node, next_dep + 1));
                if state[d] == 0 {
                    state[d] = 1;
                    stack.push((d, 0));
                }
            } else {
                state[node] = 2;
                order.push(node);
            }
        }
    }
    let mut slots: Vec<Option<Vec<Value>>> = rows.into_iter().map(Some).collect();
    order
        .into_iter()
        .filter_map(|i| slots.get_mut(i).and_then(Option::take))
        .collect()
}

/// 行の由来。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchKind {
    /// 子の方向 (キーを持つ行を参照している行)。件数に上限がある。
    Child,
    /// 親の方向 (行が参照している行)。
    Parent,
}

/// 取得する行の要求。`table` の `key_columns` が `keys` のどれかに一致する行を返す。
#[derive(Debug, Clone, PartialEq)]
pub struct FetchRequest {
    pub table: String,
    pub key_columns: Vec<String>,
    pub keys: Vec<Vec<Value>>,
    pub kind: FetchKind,
    /// SQL の `LIMIT`。子の方向だけ付く (上限の判定に 1 行余分に読む)。
    pub limit: Option<u64>,
}

/// 抽出の設定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubsetOptions {
    pub child_depth: u32,
    pub child_row_limit: u64,
    pub max_total_rows: u64,
}

impl Default for SubsetOptions {
    fn default() -> Self {
        Self {
            child_depth: 0,
            child_row_limit: DEFAULT_CHILD_ROW_LIMIT,
            max_total_rows: MAX_TOTAL_ROWS,
        }
    }
}

struct TableState {
    meta: SubsetTable,
    identity: Vec<usize>,
    rows: Vec<Vec<Value>>,
    seen: HashSet<String>,
    roots: u64,
    children: u64,
    parents: u64,
    /// 親の要求を出し終えた行数 (これ以降が未処理)。
    parent_cursor: usize,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Children,
    Parents,
    Done,
}

/// 抽出の状態機械。使い方:
///
/// 1. [`SubsetWalk::add_root_rows`] で起点の行を入れる。
/// 2. [`SubsetWalk::next_request`] が `Some` の間、その要求を実行して
///    [`SubsetWalk::supply`] へ結果を渡す (**1 件ずつ、結果を渡してから次を要求する**)。
/// 3. `None` になったら [`SubsetWalk::finish`]。
pub struct SubsetWalk {
    tables: BTreeMap<String, TableState>,
    edges: Vec<SubsetEdge>,
    options: SubsetOptions,
    phase: Phase,
    queue: VecDeque<FetchRequest>,
    /// いま辿っている段の行 (表名, 行番号)。0 段目は起点。
    frontier: Vec<(String, usize)>,
    next_frontier: Vec<(String, usize)>,
    level: u32,
    level_started: bool,
    /// 要求済みのキー (辺の番号, キーの署名)。同じキーを 2 度取らない。
    requested: HashSet<(usize, bool, String)>,
    truncated: BTreeSet<String>,
    child_added: HashMap<String, u64>,
    total_rows: u64,
    warnings: Vec<SubsetWarning>,
    /// 親の方向を辿るか。行の複製 (#2304) は外部への参照をそのまま残すので辿らない。
    follow_parents: bool,
}

impl SubsetWalk {
    pub fn new(
        tables: BTreeMap<String, SubsetTable>,
        edges: Vec<SubsetEdge>,
        options: SubsetOptions,
    ) -> Self {
        let tables = tables
            .into_iter()
            .map(|(name, meta)| {
                let identity = meta.identity_indices();
                (
                    name,
                    TableState {
                        meta,
                        identity,
                        rows: Vec::new(),
                        seen: HashSet::new(),
                        roots: 0,
                        children: 0,
                        parents: 0,
                        parent_cursor: 0,
                    },
                )
            })
            .collect();
        Self {
            tables,
            edges,
            options,
            phase: Phase::Children,
            queue: VecDeque::new(),
            frontier: Vec::new(),
            next_frontier: Vec::new(),
            level: 0,
            level_started: false,
            requested: HashSet::new(),
            truncated: BTreeSet::new(),
            child_added: HashMap::new(),
            total_rows: 0,
            warnings: Vec::new(),
            follow_parents: true,
        }
    }

    /// 親の方向を辿らない走査にする (行の複製 #2304)。起点と子の方向の行だけが集まる。
    pub fn children_only(mut self) -> Self {
        self.follow_parents = false;
        self
    }

    /// いま集まっている行の総数 (進捗表示用)。
    pub fn total_rows(&self) -> u64 {
        self.total_rows
    }

    /// 警告を足す (起点の打ち切りなど、呼び出し側だけが知るもの)。
    pub fn push_warning(&mut self, w: SubsetWarning) {
        self.warnings.push(w);
    }

    fn add_row(&mut self, table: &str, row: Vec<Value>, kind: Role) -> Result<Option<usize>> {
        let max = self.options.max_total_rows;
        let total = self.total_rows;
        let st = self
            .tables
            .get_mut(table)
            .ok_or_else(|| AppError::InvalidInput(format!("unknown table in subset: {table}")))?;
        if row.len() != st.meta.columns.len() {
            return Err(AppError::Other(format!(
                "subset fetch for '{table}' returned {} columns, expected {}",
                row.len(),
                st.meta.columns.len()
            )));
        }
        let key: Vec<Value> = st
            .identity
            .iter()
            .filter_map(|&i| row.get(i).cloned())
            .collect();
        let sig = key_signature(&key);
        if st.seen.contains(&sig) {
            return Ok(None);
        }
        if total >= max {
            // 子の方向を辿らない走査 (サンドボックスなど) では「段数を減らす」案内を出さない。
            let hint = if self.options.child_depth > 0 {
                "narrow the start condition or reduce the child depth"
            } else {
                "narrow the start condition"
            };
            return Err(AppError::InvalidInput(format!(
                "the subset exceeds {max} rows; {hint}"
            )));
        }
        st.seen.insert(sig);
        st.rows.push(row);
        match kind {
            Role::Root => st.roots += 1,
            Role::Child => st.children += 1,
            Role::Parent => st.parents += 1,
        }
        self.total_rows += 1;
        Ok(Some(st.rows.len() - 1))
    }

    /// 起点の行を入れる (重複は無視する)。
    pub fn add_root_rows(&mut self, table: &str, rows: Vec<Vec<Value>>) -> Result<()> {
        for row in rows {
            if let Some(i) = self.add_row(table, row, Role::Root)? {
                self.frontier.push((table.to_string(), i));
            }
        }
        Ok(())
    }

    /// 次に取得すべき行の要求。無ければ `None` (抽出が完了した)。
    pub fn next_request(&mut self) -> Option<FetchRequest> {
        loop {
            if let Some(mut req) = self.queue.pop_front() {
                if req.kind == FetchKind::Child {
                    if self.truncated.contains(&req.table) {
                        continue;
                    }
                    let added = self.child_added.get(&req.table).copied().unwrap_or(0);
                    let remaining = self.options.child_row_limit.saturating_sub(added);
                    // 既に入っている行 (起点・他の子) と重なっても上限の判定を誤らないよう、
                    // 余裕を持って読む。
                    let existing = self
                        .tables
                        .get(&req.table)
                        .map_or(0, |t| t.rows.len() as u64);
                    req.limit = Some(remaining.saturating_add(1).saturating_add(existing));
                }
                return Some(req);
            }
            match self.phase {
                Phase::Children => {
                    if self.level_started {
                        self.frontier = std::mem::take(&mut self.next_frontier);
                        self.level += 1;
                        self.level_started = false;
                    }
                    if self.level >= self.options.child_depth || self.frontier.is_empty() {
                        self.phase = if self.follow_parents {
                            Phase::Parents
                        } else {
                            Phase::Done
                        };
                        continue;
                    }
                    self.enqueue_child_requests();
                    self.level_started = true;
                }
                Phase::Parents => {
                    if !self.enqueue_parent_requests() {
                        self.phase = Phase::Done;
                        return None;
                    }
                }
                Phase::Done => return None,
            }
        }
    }

    fn key_of(&self, table: &str, idx: usize, cols: &[String]) -> Option<Vec<Value>> {
        let st = self.tables.get(table)?;
        let row = st.rows.get(idx)?;
        let mut key = Vec::with_capacity(cols.len());
        for c in cols {
            let v = row.get(st.meta.col_index(c)?)?;
            if matches!(v, Value::Null) {
                return None;
            }
            key.push(v.clone());
        }
        Some(key)
    }

    fn push_requests(
        &mut self,
        edge_idx: usize,
        child_direction: bool,
        table: &str,
        key_columns: &[String],
        keys: Vec<Vec<Value>>,
        kind: FetchKind,
    ) -> bool {
        let mut fresh: Vec<Vec<Value>> = Vec::new();
        for k in keys {
            if self
                .requested
                .insert((edge_idx, child_direction, key_signature(&k)))
            {
                fresh.push(k);
            }
        }
        if fresh.is_empty() {
            return false;
        }
        let chunk = if key_columns.len() > 1 {
            COMPOSITE_KEY_CHUNK
        } else {
            KEY_CHUNK
        };
        for c in fresh.chunks(chunk) {
            self.queue.push_back(FetchRequest {
                table: table.to_string(),
                key_columns: key_columns.to_vec(),
                keys: c.to_vec(),
                kind,
                limit: None,
            });
        }
        true
    }

    fn enqueue_child_requests(&mut self) {
        let frontier = self.frontier.clone();
        for ei in 0..self.edges.len() {
            let Some(edge) = self.edges.get(ei).cloned() else {
                continue;
            };
            let keys: Vec<Vec<Value>> = frontier
                .iter()
                .filter(|(t, _)| *t == edge.parent)
                .filter_map(|(t, i)| self.key_of(t, *i, &edge.parent_cols))
                .collect();
            if keys.is_empty() {
                continue;
            }
            self.push_requests(
                ei,
                true,
                &edge.child,
                &edge.child_cols,
                keys,
                FetchKind::Child,
            );
        }
    }

    /// 親の要求を積む。積んだものがあれば `true`。
    fn enqueue_parent_requests(&mut self) -> bool {
        let mut any = false;
        let names: Vec<String> = self.tables.keys().cloned().collect();
        for name in names {
            let (start, end) = match self.tables.get(&name) {
                Some(st) => (st.parent_cursor, st.rows.len()),
                None => continue,
            };
            if let Some(st) = self.tables.get_mut(&name) {
                st.parent_cursor = end;
            }
            if start >= end {
                continue;
            }
            for ei in 0..self.edges.len() {
                let Some(edge) = self.edges.get(ei).cloned() else {
                    continue;
                };
                if edge.child != name {
                    continue;
                }
                let mut keys: Vec<Vec<Value>> = Vec::new();
                for i in start..end {
                    let Some(key) = self.key_of(&name, i, &edge.child_cols) else {
                        continue;
                    };
                    if self.parent_already_present(&edge, &key) {
                        continue;
                    }
                    keys.push(key);
                }
                if self.push_requests(
                    ei,
                    false,
                    &edge.parent,
                    &edge.parent_cols,
                    keys,
                    FetchKind::Parent,
                ) {
                    any = true;
                }
            }
        }
        any
    }

    /// 参照先の列が親の主キーそのもので、その行が既に入っているか。
    fn parent_already_present(&self, edge: &SubsetEdge, key: &[Value]) -> bool {
        let Some(parent) = self.tables.get(&edge.parent) else {
            return false;
        };
        let pk = &parent.meta.primary_key;
        if pk.is_empty() || pk.len() != edge.parent_cols.len() {
            return false;
        }
        // 主キーの並びへ入れ替える。主キーの列と一致しなければ判定しない。
        let mut ordered = Vec::with_capacity(pk.len());
        for c in pk {
            match edge.parent_cols.iter().position(|p| p == c) {
                Some(i) => match key.get(i) {
                    Some(v) => ordered.push(v.clone()),
                    None => return false,
                },
                None => return false,
            }
        }
        parent.seen.contains(&key_signature(&ordered))
    }

    /// `req` の取得結果 (列は [`SubsetTable::columns`] の並び) を取り込む。
    pub fn supply(&mut self, req: &FetchRequest, rows: Vec<Vec<Value>>) -> Result<()> {
        match req.kind {
            FetchKind::Parent => {
                for row in rows {
                    self.add_row(&req.table, row, Role::Parent)?;
                }
            }
            FetchKind::Child => {
                let limit = self.options.child_row_limit;
                for row in rows {
                    let added = self.child_added.get(&req.table).copied().unwrap_or(0);
                    // 既に入っている行は数えない。新しい行が上限を超えたら打ち切る。
                    let is_new = self.would_add(&req.table, &row);
                    if is_new && added >= limit {
                        self.truncated.insert(req.table.clone());
                        self.warnings.push(SubsetWarning::ChildTruncated {
                            table: req.table.clone(),
                            limit,
                        });
                        break;
                    }
                    if let Some(i) = self.add_row(&req.table, row, Role::Child)? {
                        *self.child_added.entry(req.table.clone()).or_insert(0) += 1;
                        self.next_frontier.push((req.table.clone(), i));
                    }
                }
            }
        }
        Ok(())
    }

    fn would_add(&self, table: &str, row: &[Value]) -> bool {
        let Some(st) = self.tables.get(table) else {
            return false;
        };
        let key: Vec<Value> = st
            .identity
            .iter()
            .filter_map(|&i| row.get(i).cloned())
            .collect();
        !st.seen.contains(&key_signature(&key))
    }

    /// 結果を確定する。行のある表だけを、親が先の順に返す。
    pub fn finish(self) -> SubsetResult {
        let SubsetWalk {
            tables,
            edges,
            mut warnings,
            ..
        } = self;
        let with_rows: BTreeSet<String> = tables
            .iter()
            .filter(|(_, t)| !t.rows.is_empty())
            .map(|(n, _)| n.clone())
            .collect();
        let order = table_order(&with_rows, &edges);
        for cyc in &order.cycles {
            warnings.push(SubsetWarning::Cycle {
                tables: cyc.clone(),
            });
        }
        let mut states = tables;
        let mut out = Vec::with_capacity(order.order.len());
        for name in &order.order {
            let Some(st) = states.remove(name) else {
                continue;
            };
            let rows = order_self_referencing(st.rows, &st.meta, &edges);
            out.push(SubsetTableRows {
                table: st.meta.name.clone(),
                columns: st.meta.columns.clone(),
                column_types: st.meta.column_types.clone(),
                primary_key: st.meta.primary_key.clone(),
                rows,
                root_rows: st.roots,
                child_rows: st.children,
                parent_rows: st.parents,
            });
        }
        SubsetResult {
            tables: out,
            cycles: order.cycles,
            warnings,
        }
    }
}

#[derive(Clone, Copy)]
enum Role {
    Root,
    Child,
    Parent,
}

/// 表ごとの抽出結果。
#[derive(Debug, Clone, PartialEq)]
pub struct SubsetTableRows {
    pub table: String,
    pub columns: Vec<String>,
    pub column_types: Vec<String>,
    pub primary_key: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub root_rows: u64,
    pub child_rows: u64,
    pub parent_rows: u64,
}

/// 抽出の結果。`tables` は親が先の順。
#[derive(Debug, Clone, PartialEq)]
pub struct SubsetResult {
    pub tables: Vec<SubsetTableRows>,
    pub cycles: Vec<Vec<String>>,
    pub warnings: Vec<SubsetWarning>,
}

impl SubsetResult {
    pub fn total_rows(&self) -> u64 {
        self.tables.iter().map(|t| t.rows.len() as u64).sum()
    }
}

/// キーのリテラル。2^53 を超える整数は `Value::String` で来るので、整数型の列では引用符なしの
/// 数値で書く (MySQL は文字列定数と整数列を倍精度で比較し、下位桁が丸まるため)。
/// バイナリ列は 16 進の文字列を `Bytes` に戻して書く。
pub(crate) fn key_literal(driver: DriverKind, column_type: &str, value: &Value) -> String {
    match value {
        Value::String(s) if is_binary_type(column_type) && is_hex_wire(s) => {
            sql_literal(driver, &Value::Bytes(s.clone()))
        }
        Value::String(s) if is_integer_type(column_type) && is_numeric_literal(s.trim()) => {
            s.trim().to_string()
        }
        other => sql_literal(driver, other),
    }
}

fn is_integer_type(column_type: &str) -> bool {
    let t = column_type.to_ascii_lowercase();
    t.contains("int") || t.contains("serial")
}

/// 取得 SQL の `FROM` 句の表参照を受け取り、`key_columns` が `keys` に一致する行を
/// 取る `SELECT` を組む。単一列は `col IN (...)`、複合キーは `(a = x AND b = y) OR ...`。
/// 主キーがあれば `ORDER BY` を付ける (`LIMIT` で打ち切るときに読む行を安定させる)。
pub fn select_by_keys_sql(
    driver: DriverKind,
    table_ref: &str,
    table: &SubsetTable,
    key_columns: &[String],
    keys: &[Vec<Value>],
    limit: Option<u64>,
) -> Result<String> {
    if key_columns.is_empty() || keys.is_empty() {
        return Err(AppError::InvalidInput(
            "subset fetch needs at least one key column and one key".into(),
        ));
    }
    let mut key_idx = Vec::with_capacity(key_columns.len());
    for c in key_columns {
        key_idx.push(table.col_index(c).ok_or_else(|| {
            AppError::InvalidInput(format!("column '{c}' not found in table '{}'", table.name))
        })?);
    }
    let lit = |pos: usize, v: &Value| {
        let ty = key_idx
            .get(pos)
            .and_then(|&i| table.column_types.get(i))
            .map_or("", String::as_str);
        key_literal(driver, ty, v)
    };
    let cond = if key_columns.len() == 1 {
        let items: Vec<String> = keys
            .iter()
            .filter_map(|k| k.first())
            .map(|v| lit(0, v))
            .collect();
        format!(
            "{} IN ({})",
            quote_ident(driver, &key_columns[0]),
            items.join(", ")
        )
    } else {
        let alts: Vec<String> = keys
            .iter()
            .filter(|k| k.len() == key_columns.len())
            .map(|k| {
                let parts: Vec<String> = key_columns
                    .iter()
                    .zip(k.iter())
                    .enumerate()
                    .map(|(pos, (c, v))| format!("{} = {}", quote_ident(driver, c), lit(pos, v)))
                    .collect();
                format!("({})", parts.join(" AND "))
            })
            .collect();
        alts.join(" OR ")
    };
    let cols = table
        .columns
        .iter()
        .map(|c| quote_ident(driver, c))
        .collect::<Vec<_>>()
        .join(", ");
    let mut sql = format!("SELECT {cols} FROM {table_ref} WHERE {cond}");
    if !table.primary_key.is_empty() {
        let order = table
            .primary_key
            .iter()
            .map(|c| quote_ident(driver, c))
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(&format!(" ORDER BY {order}"));
    }
    if let Some(n) = limit {
        sql.push_str(&format!(" LIMIT {n}"));
    }
    Ok(sql)
}

/// マスクの対象が外部キー / 主キーの列でないことを確かめる。キーの列を書き換えると、
/// 出力した行どうしの参照が壊れるため拒否する。`masked` は (表, 列) の組。
pub fn check_mask_targets(
    masked: &[(String, String)],
    tables: &BTreeMap<String, SubsetTable>,
    edges: &[SubsetEdge],
) -> Result<()> {
    for (table, column) in masked {
        let Some(meta) = tables.get(table) else {
            return Err(AppError::InvalidInput(format!(
                "masked table '{table}' is not part of the subset"
            )));
        };
        if meta.col_index(column).is_none() {
            return Err(AppError::InvalidInput(format!(
                "masked column '{table}.{column}' does not exist"
            )));
        }
        let is_key = meta.primary_key.iter().any(|c| c == column)
            || edges.iter().any(|e| {
                (e.child == *table && e.child_cols.iter().any(|c| c == column))
                    || (e.parent == *table && e.parent_cols.iter().any(|c| c == column))
            });
        if is_key {
            return Err(AppError::InvalidInput(format!(
                "'{table}.{column}' is a key column and cannot be masked (it would break the references)"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &str) -> String {
        v.to_string()
    }

    fn table(name: &str, cols: &[&str], pk: &[&str]) -> SubsetTable {
        SubsetTable {
            name: s(name),
            columns: cols.iter().map(|c| s(c)).collect(),
            column_types: cols.iter().map(|_| s("int")).collect(),
            primary_key: pk.iter().map(|c| s(c)).collect(),
        }
    }

    fn edge(child: &str, ccols: &[&str], parent: &str, pcols: &[&str]) -> SubsetEdge {
        SubsetEdge {
            constraint: format!("fk_{child}_{parent}"),
            child: s(child),
            child_cols: ccols.iter().map(|c| s(c)).collect(),
            parent: s(parent),
            parent_cols: pcols.iter().map(|c| s(c)).collect(),
        }
    }

    fn i(n: i64) -> Value {
        Value::Int(n)
    }

    /// 擬似 DB: 表名 -> (列, 行)。`FetchRequest` を実行して行を返す。
    struct FakeDb {
        tables: BTreeMap<String, (Vec<String>, Vec<Vec<Value>>)>,
    }

    impl FakeDb {
        fn fetch(&self, req: &FetchRequest) -> Vec<Vec<Value>> {
            let (cols, rows) = &self.tables[&req.table];
            let idx: Vec<usize> = req
                .key_columns
                .iter()
                .map(|k| cols.iter().position(|c| c == k).unwrap())
                .collect();
            let mut out: Vec<Vec<Value>> = rows
                .iter()
                .filter(|r| {
                    req.keys
                        .iter()
                        .any(|k| idx.iter().zip(k).all(|(&i, v)| &r[i] == v))
                })
                .cloned()
                .collect();
            if let Some(l) = req.limit {
                out.truncate(l as usize);
            }
            out
        }
    }

    fn run(
        metas: Vec<SubsetTable>,
        edges: Vec<SubsetEdge>,
        db: &FakeDb,
        roots: (&str, Vec<Vec<Value>>),
        options: SubsetOptions,
    ) -> SubsetResult {
        let tables = metas.into_iter().map(|t| (t.name.clone(), t)).collect();
        let mut walk = SubsetWalk::new(tables, edges, options);
        walk.add_root_rows(roots.0, roots.1).unwrap();
        while let Some(req) = walk.next_request() {
            let rows = db.fetch(&req);
            walk.supply(&req, rows).unwrap();
        }
        walk.finish()
    }

    fn rows_of<'a>(r: &'a SubsetResult, t: &str) -> Vec<&'a Vec<Value>> {
        r.tables
            .iter()
            .find(|x| x.table == t)
            .map(|x| x.rows.iter().collect())
            .unwrap_or_default()
    }

    /// customers <- orders <- order_items -> products
    fn shop() -> (Vec<SubsetTable>, Vec<SubsetEdge>, FakeDb) {
        let metas = vec![
            table("customers", &["id", "name"], &["id"]),
            table("orders", &["id", "customer_id"], &["id"]),
            table("order_items", &["id", "order_id", "product_id"], &["id"]),
            table("products", &["id", "label"], &["id"]),
        ];
        let edges = vec![
            edge("orders", &["customer_id"], "customers", &["id"]),
            edge("order_items", &["order_id"], "orders", &["id"]),
            edge("order_items", &["product_id"], "products", &["id"]),
        ];
        let mut t = BTreeMap::new();
        t.insert(
            s("customers"),
            (
                vec![s("id"), s("name")],
                vec![
                    vec![i(1), Value::String("a".into())],
                    vec![i(2), Value::String("b".into())],
                ],
            ),
        );
        t.insert(
            s("orders"),
            (
                vec![s("id"), s("customer_id")],
                vec![vec![i(10), i(1)], vec![i(11), i(1)], vec![i(12), i(2)]],
            ),
        );
        t.insert(
            s("order_items"),
            (
                vec![s("id"), s("order_id"), s("product_id")],
                vec![
                    vec![i(100), i(10), i(7)],
                    vec![i(101), i(10), i(8)],
                    vec![i(102), i(11), i(7)],
                    vec![i(103), i(12), i(9)],
                ],
            ),
        );
        t.insert(
            s("products"),
            (
                vec![s("id"), s("label")],
                vec![
                    vec![i(7), Value::String("p7".into())],
                    vec![i(8), Value::String("p8".into())],
                    vec![i(9), Value::String("p9".into())],
                ],
            ),
        );
        (metas, edges, FakeDb { tables: t })
    }

    #[test]
    fn parents_are_followed_to_the_end_from_the_root_row() {
        let (metas, edges, db) = shop();
        // 起点: 明細 100 だけ。親 (注文 → 顧客、商品) が最後まで入る。
        let r = run(
            metas,
            edges,
            &db,
            ("order_items", vec![vec![i(100), i(10), i(7)]]),
            SubsetOptions::default(),
        );
        assert_eq!(rows_of(&r, "order_items").len(), 1);
        assert_eq!(rows_of(&r, "orders"), vec![&vec![i(10), i(1)]]);
        assert_eq!(rows_of(&r, "customers").len(), 1);
        assert_eq!(
            rows_of(&r, "products"),
            vec![&vec![i(7), Value::String("p7".into())]]
        );
        // 親が先の順。
        let names: Vec<&str> = r.tables.iter().map(|t| t.table.as_str()).collect();
        let pos = |n: &str| names.iter().position(|x| *x == n).unwrap();
        assert!(pos("customers") < pos("orders"));
        assert!(pos("orders") < pos("order_items"));
        assert!(pos("products") < pos("order_items"));
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn children_are_not_followed_by_default() {
        let (metas, edges, db) = shop();
        let r = run(
            metas,
            edges,
            &db,
            ("customers", vec![vec![i(1), Value::String("a".into())]]),
            SubsetOptions::default(),
        );
        assert_eq!(r.tables.len(), 1);
        assert_eq!(r.total_rows(), 1);
    }

    #[test]
    fn child_depth_limits_how_far_children_are_followed() {
        let (metas, edges, db) = shop();
        let opts = |d| SubsetOptions {
            child_depth: d,
            ..SubsetOptions::default()
        };
        let root = || ("customers", vec![vec![i(1), Value::String("a".into())]]);
        // 1 段: 顧客 1 の注文 (10, 11) だけ。明細は入らない。
        let r1 = run(metas.clone(), edges.clone(), &db, root(), opts(1));
        assert_eq!(rows_of(&r1, "orders").len(), 2);
        assert!(rows_of(&r1, "order_items").is_empty());
        // 2 段: 明細 (100, 101, 102) まで。親の商品 7, 8 は整合性のために入る。
        let r2 = run(metas, edges, &db, root(), opts(2));
        assert_eq!(rows_of(&r2, "order_items").len(), 3);
        assert_eq!(rows_of(&r2, "products").len(), 2);
        // 子で足した行の「他の子」(= 注文 12 や明細 103) や別の顧客は入らない。
        assert_eq!(rows_of(&r2, "customers").len(), 1);
        assert!(!rows_of(&r2, "orders").iter().any(|r| r[0] == i(12)));
    }

    #[test]
    fn child_row_limit_truncates_and_warns() {
        let (metas, edges, db) = shop();
        let opts = SubsetOptions {
            child_depth: 1,
            child_row_limit: 1,
            ..SubsetOptions::default()
        };
        let r = run(
            metas,
            edges,
            &db,
            ("customers", vec![vec![i(1), Value::String("a".into())]]),
            opts,
        );
        assert_eq!(rows_of(&r, "orders").len(), 1);
        assert!(r.warnings.contains(&SubsetWarning::ChildTruncated {
            table: s("orders"),
            limit: 1
        }));
    }

    #[test]
    fn child_row_limit_is_not_a_false_positive_when_exactly_at_the_limit() {
        let (metas, edges, db) = shop();
        let opts = SubsetOptions {
            child_depth: 1,
            child_row_limit: 2,
            ..SubsetOptions::default()
        };
        let r = run(
            metas,
            edges,
            &db,
            ("customers", vec![vec![i(1), Value::String("a".into())]]),
            opts,
        );
        assert_eq!(rows_of(&r, "orders").len(), 2);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn null_foreign_key_is_not_followed() {
        let metas = vec![
            table("p", &["id"], &["id"]),
            table("c", &["id", "p_id"], &["id"]),
        ];
        let edges = vec![edge("c", &["p_id"], "p", &["id"])];
        let mut t = BTreeMap::new();
        t.insert(s("p"), (vec![s("id")], vec![vec![i(1)]]));
        t.insert(
            s("c"),
            (vec![s("id"), s("p_id")], vec![vec![i(1), Value::Null]]),
        );
        let r = run(
            metas,
            edges,
            &FakeDb { tables: t },
            ("c", vec![vec![i(1), Value::Null]]),
            SubsetOptions::default(),
        );
        assert_eq!(r.tables.len(), 1);
    }

    #[test]
    fn composite_foreign_key_matches_on_all_columns() {
        let metas = vec![
            table("p", &["a", "b", "v"], &["a", "b"]),
            table("c", &["id", "pa", "pb"], &["id"]),
        ];
        let edges = vec![edge("c", &["pa", "pb"], "p", &["a", "b"])];
        let mut t = BTreeMap::new();
        t.insert(
            s("p"),
            (
                vec![s("a"), s("b"), s("v")],
                vec![
                    vec![i(1), i(1), i(10)],
                    vec![i(1), i(2), i(11)],
                    vec![i(2), i(1), i(12)],
                ],
            ),
        );
        t.insert(
            s("c"),
            (
                vec![s("id"), s("pa"), s("pb")],
                vec![vec![i(1), i(1), i(2)]],
            ),
        );
        let r = run(
            metas,
            edges,
            &FakeDb { tables: t },
            ("c", vec![vec![i(1), i(1), i(2)]]),
            SubsetOptions::default(),
        );
        // (1,2) の 1 行だけ。(1,1) や (2,1) は入らない。
        assert_eq!(rows_of(&r, "p"), vec![&vec![i(1), i(2), i(11)]]);
    }

    #[test]
    fn self_reference_walks_up_the_hierarchy_and_orders_parents_first() {
        let metas = vec![table("emp", &["id", "boss"], &["id"])];
        let edges = vec![edge("emp", &["boss"], "emp", &["id"])];
        let mut t = BTreeMap::new();
        t.insert(
            s("emp"),
            (
                vec![s("id"), s("boss")],
                vec![
                    vec![i(1), Value::Null],
                    vec![i(2), i(1)],
                    vec![i(3), i(2)],
                    vec![i(4), i(2)],
                ],
            ),
        );
        let r = run(
            metas,
            edges,
            &FakeDb { tables: t },
            ("emp", vec![vec![i(3), i(2)]]),
            SubsetOptions::default(),
        );
        let ids: Vec<Value> = rows_of(&r, "emp").iter().map(|r| r[0].clone()).collect();
        // 3 → 2 → 1 と上に辿り、4 (別の部下) は入らない。出力は上司が先。
        assert_eq!(ids, vec![i(1), i(2), i(3)]);
        assert!(r.warnings.is_empty());
    }

    #[test]
    fn self_reference_children_follow_the_depth_limit() {
        let metas = vec![table("emp", &["id", "boss"], &["id"])];
        let edges = vec![edge("emp", &["boss"], "emp", &["id"])];
        let mut t = BTreeMap::new();
        t.insert(
            s("emp"),
            (
                vec![s("id"), s("boss")],
                vec![
                    vec![i(1), Value::Null],
                    vec![i(2), i(1)],
                    vec![i(3), i(2)],
                    vec![i(4), i(3)],
                ],
            ),
        );
        let opts = SubsetOptions {
            child_depth: 2,
            ..SubsetOptions::default()
        };
        let r = run(
            metas,
            edges,
            &FakeDb { tables: t },
            ("emp", vec![vec![i(1), Value::Null]]),
            opts,
        );
        let ids: Vec<Value> = rows_of(&r, "emp").iter().map(|r| r[0].clone()).collect();
        assert_eq!(ids, vec![i(1), i(2), i(3)]);
    }

    #[test]
    fn cycle_between_tables_terminates_and_warns() {
        // a.b_id -> b.id, b.a_id -> a.id
        let metas = vec![
            table("a", &["id", "b_id"], &["id"]),
            table("b", &["id", "a_id"], &["id"]),
        ];
        let edges = vec![
            edge("a", &["b_id"], "b", &["id"]),
            edge("b", &["a_id"], "a", &["id"]),
        ];
        let mut t = BTreeMap::new();
        t.insert(s("a"), (vec![s("id"), s("b_id")], vec![vec![i(1), i(1)]]));
        t.insert(s("b"), (vec![s("id"), s("a_id")], vec![vec![i(1), i(1)]]));
        let r = run(
            metas,
            edges,
            &FakeDb { tables: t },
            ("a", vec![vec![i(1), i(1)]]),
            SubsetOptions::default(),
        );
        assert_eq!(r.total_rows(), 2);
        assert_eq!(r.cycles, vec![vec![s("a"), s("b")]]);
        assert!(r.warnings.contains(&SubsetWarning::Cycle {
            tables: vec![s("a"), s("b")]
        }));
    }

    #[test]
    fn total_row_cap_fails_instead_of_truncating_parents() {
        let (metas, edges, db) = shop();
        let tables = metas.into_iter().map(|t| (t.name.clone(), t)).collect();
        let mut walk = SubsetWalk::new(
            tables,
            edges,
            SubsetOptions {
                max_total_rows: 2,
                ..SubsetOptions::default()
            },
        );
        walk.add_root_rows("order_items", vec![vec![i(100), i(10), i(7)]])
            .unwrap();
        let mut err = None;
        while let Some(req) = walk.next_request() {
            let rows = db.fetch(&req);
            if let Err(e) = walk.supply(&req, rows) {
                err = Some(e);
                break;
            }
        }
        assert!(matches!(err, Some(AppError::InvalidInput(_))));
    }

    #[test]
    fn dangling_parent_reference_is_tolerated() {
        let (metas, edges, db) = shop();
        // 親の無い明細 (order_id = 999)。親が見つからなくても失敗せず、行だけ入る。
        let r = run(
            metas,
            edges,
            &db,
            ("order_items", vec![vec![i(500), i(999), i(7)]]),
            SubsetOptions::default(),
        );
        assert!(rows_of(&r, "orders").is_empty());
        assert_eq!(rows_of(&r, "order_items").len(), 1);
    }

    #[test]
    fn group_foreign_keys_folds_composite_and_unnamed() {
        let fk = |t: &str, c: &str, rt: &str, rc: Option<&str>, n: Option<&str>| ForeignKey {
            table: s(t),
            column: s(c),
            referenced_table: s(rt),
            referenced_column: rc.map(s),
            constraint_name: n.map(s),
            on_delete: None,
            on_update: None,
        };
        let groups = group_foreign_keys(&[
            fk("c", "pa", "p", Some("a"), Some("fk1")),
            fk("c", "pb", "p", Some("b"), Some("fk1")),
            fk("d", "x", "p", None, None),
            fk("d", "y", "p", None, None),
        ]);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].child_cols, vec![s("pa"), s("pb")]);
        assert_eq!(groups[0].parent_cols, Some(vec![s("a"), s("b")]));
        // 制約名の無いものは列ごとに別の外部キー。暗黙の参照先は未解決 (`None`)。
        assert_eq!(groups[1].parent_cols, None);
        assert_eq!(groups[2].child_cols, vec![s("y")]);
    }

    #[test]
    fn resolve_edges_uses_parent_primary_key_for_implicit_references() {
        let tables: BTreeMap<String, SubsetTable> = [
            table("p", &["id"], &["id"]),
            table("c", &["id", "p_id"], &["id"]),
            table("q", &["a", "b"], &["a", "b"]),
            table("d", &["id", "q_a"], &["id"]),
        ]
        .into_iter()
        .map(|t| (t.name.clone(), t))
        .collect();
        let groups = vec![
            FkGroup {
                constraint: s("c:0"),
                child: s("c"),
                child_cols: vec![s("p_id")],
                parent: s("p"),
                parent_cols: None,
            },
            // 暗黙の参照で、参照先の主キー (2 列) と列数が合わない。
            FkGroup {
                constraint: s("d:0"),
                child: s("d"),
                child_cols: vec![s("q_a")],
                parent: s("q"),
                parent_cols: None,
            },
            // 抽出範囲の外の表への外部キーは捨てる。
            FkGroup {
                constraint: s("c:1"),
                child: s("c"),
                child_cols: vec![s("p_id")],
                parent: s("outside"),
                parent_cols: Some(vec![s("id")]),
            },
        ];
        let (edges, warnings) = resolve_edges(&groups, &tables);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].parent_cols, vec![s("id")]);
        assert_eq!(
            warnings,
            vec![SubsetWarning::UnresolvedForeignKey {
                table: s("d"),
                constraint: s("d:0")
            }]
        );
    }

    #[test]
    fn reachable_tables_follows_parents_always_and_children_by_depth() {
        let groups = vec![
            FkGroup {
                constraint: s("1"),
                child: s("orders"),
                child_cols: vec![s("customer_id")],
                parent: s("customers"),
                parent_cols: Some(vec![s("id")]),
            },
            FkGroup {
                constraint: s("2"),
                child: s("items"),
                child_cols: vec![s("order_id")],
                parent: s("orders"),
                parent_cols: Some(vec![s("id")]),
            },
            FkGroup {
                constraint: s("3"),
                child: s("items"),
                child_cols: vec![s("product_id")],
                parent: s("products"),
                parent_cols: Some(vec![s("id")]),
            },
        ];
        let roots = vec![s("customers")];
        let d0: Vec<_> = reachable_tables(&roots, &groups, 0).into_iter().collect();
        assert_eq!(d0, vec![s("customers")]);
        let d1: Vec<_> = reachable_tables(&roots, &groups, 1).into_iter().collect();
        assert_eq!(d1, vec![s("customers"), s("orders")]);
        let d2: Vec<_> = reachable_tables(&roots, &groups, 2).into_iter().collect();
        // items の親である products も入る。
        assert_eq!(
            d2,
            vec![s("customers"), s("items"), s("orders"), s("products")]
        );
        let from_items: Vec<_> = reachable_tables(&[s("items")], &groups, 0)
            .into_iter()
            .collect();
        assert_eq!(
            from_items,
            vec![s("customers"), s("items"), s("orders"), s("products")]
        );
    }

    #[test]
    fn table_order_puts_parents_first_and_groups_cycles() {
        let tables: BTreeSet<String> = ["a", "b", "c", "d"].iter().map(|x| s(x)).collect();
        let edges = vec![
            edge("d", &["x"], "c", &["id"]),
            edge("c", &["x"], "a", &["id"]),
            edge("c", &["y"], "b", &["id"]),
            edge("b", &["x"], "c", &["id"]),
            edge("a", &["x"], "a", &["id"]), // 自己参照は無視
        ];
        let o = table_order(&tables, &edges);
        assert_eq!(o.cycles, vec![vec![s("b"), s("c")]]);
        let pos = |n: &str| o.order.iter().position(|x| x == n).unwrap();
        assert!(pos("a") < pos("b"));
        assert!(pos("a") < pos("c"));
        assert!(pos("c") < pos("d"));
        assert_eq!(o.order.len(), 4);
    }

    #[test]
    fn order_self_referencing_handles_long_chains_and_cycles() {
        let t = table("e", &["id", "boss"], &["id"]);
        let e = vec![edge("e", &["boss"], "e", &["id"])];
        // 逆順 (子が先) に並んだ長い連鎖。
        let n = 20_000i64;
        let rows: Vec<Vec<Value>> = (1..=n)
            .rev()
            .map(|k| vec![i(k), if k == 1 { Value::Null } else { i(k - 1) }])
            .collect();
        let ordered = order_self_referencing(rows, &t, &e);
        assert_eq!(ordered.first().unwrap()[0], i(1));
        assert_eq!(ordered.last().unwrap()[0], i(n));
        // 循環 (1 -> 2 -> 1) でも全行が 1 回ずつ出る。
        let cyc = vec![vec![i(1), i(2)], vec![i(2), i(1)]];
        assert_eq!(order_self_referencing(cyc, &t, &e).len(), 2);
    }

    #[test]
    fn select_by_keys_sql_single_composite_and_limit() {
        let t = SubsetTable {
            name: s("t"),
            columns: vec![s("a"), s("b")],
            column_types: vec![s("bigint"), s("varchar(10)")],
            primary_key: vec![s("a")],
        };
        let sql = select_by_keys_sql(
            DriverKind::Mysql,
            "`t`",
            &t,
            &[s("a")],
            &[vec![i(1)], vec![Value::String("9007199254740993".into())]],
            Some(5),
        )
        .unwrap();
        // 2^53 を超える整数は引用符なし (MySQL の倍精度比較で丸まらないように)。
        assert_eq!(
            sql,
            "SELECT `a`, `b` FROM `t` WHERE `a` IN (1, 9007199254740993) ORDER BY `a` LIMIT 5"
        );
        let sql = select_by_keys_sql(
            DriverKind::Postgres,
            "\"t\"",
            &t,
            &[s("a"), s("b")],
            &[
                vec![i(1), Value::String("x'y".into())],
                vec![i(2), Value::String("z".into())],
            ],
            None,
        )
        .unwrap();
        assert_eq!(
            sql,
            "SELECT \"a\", \"b\" FROM \"t\" WHERE (\"a\" = 1 AND \"b\" = 'x''y') OR (\"a\" = 2 AND \"b\" = 'z') ORDER BY \"a\""
        );
        assert!(select_by_keys_sql(
            DriverKind::Sqlite,
            "\"t\"",
            &t,
            &[s("nope")],
            &[vec![i(1)]],
            None
        )
        .is_err());
        assert!(select_by_keys_sql(DriverKind::Sqlite, "\"t\"", &t, &[s("a")], &[], None).is_err());
    }

    #[test]
    fn select_by_keys_sql_is_read_only_for_every_driver() {
        let t = table("t", &["a", "b"], &[]);
        for d in [DriverKind::Mysql, DriverKind::Postgres, DriverKind::Sqlite] {
            let sql = select_by_keys_sql(
                d,
                &quote_ident(d, "t"),
                &t,
                &[s("a"), s("b")],
                &[vec![i(1), i(2)]],
                Some(3),
            )
            .unwrap();
            assert!(crate::db::is_read_only_sql_for(d, &sql), "{sql}");
        }
    }

    #[test]
    fn check_mask_targets_rejects_key_columns() {
        let tables: BTreeMap<String, SubsetTable> = [
            table("p", &["id", "name"], &["id"]),
            table("c", &["id", "p_id", "memo"], &["id"]),
        ]
        .into_iter()
        .map(|t| (t.name.clone(), t))
        .collect();
        let edges = vec![edge("c", &["p_id"], "p", &["id"])];
        assert!(
            check_mask_targets(&[(s("p"), s("name")), (s("c"), s("memo"))], &tables, &edges)
                .is_ok()
        );
        assert!(check_mask_targets(&[(s("p"), s("id"))], &tables, &edges).is_err());
        assert!(check_mask_targets(&[(s("c"), s("p_id"))], &tables, &edges).is_err());
        assert!(check_mask_targets(&[(s("c"), s("nope"))], &tables, &edges).is_err());
        assert!(check_mask_targets(&[(s("zzz"), s("a"))], &tables, &edges).is_err());
    }

    #[test]
    fn clamps() {
        assert_eq!(clamp_root_row_limit(None), DEFAULT_ROOT_ROW_LIMIT);
        assert_eq!(clamp_root_row_limit(Some(0)), DEFAULT_ROOT_ROW_LIMIT);
        assert_eq!(clamp_root_row_limit(Some(u64::MAX)), MAX_ROOT_ROW_LIMIT);
        assert_eq!(clamp_child_row_limit(Some(5)), 5);
        assert_eq!(clamp_child_depth(None), 0);
        assert_eq!(clamp_child_depth(Some(99)), MAX_CHILD_DEPTH);
    }

    fn groups_for_cross_test() -> Vec<FkGroup> {
        vec![
            FkGroup {
                constraint: s("fk_local"),
                child: s("orders"),
                child_cols: vec![s("customer_id")],
                parent: s("customers"),
                parent_cols: Some(vec![s("id")]),
            },
            FkGroup {
                constraint: s("fk_other_db"),
                child: s("orders"),
                child_cols: vec![s("region_id")],
                parent: s("regions"),
                parent_cols: Some(vec![s("id")]),
            },
        ]
    }

    #[test]
    fn cross_database_groups_are_dropped_with_a_warning() {
        let mut cross = BTreeSet::new();
        cross.insert((s("orders"), s("fk_other_db")));
        let (kept, warnings) = exclude_cross_database_groups(groups_for_cross_test(), &cross);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].constraint, "fk_local");
        assert_eq!(
            warnings,
            vec![SubsetWarning::UnresolvedForeignKey {
                table: s("orders"),
                constraint: s("fk_other_db"),
            }]
        );
        // 同じ制約名でも別の表のものは外さない。
        let mut other = BTreeSet::new();
        other.insert((s("items"), s("fk_other_db")));
        let (kept, warnings) = exclude_cross_database_groups(groups_for_cross_test(), &other);
        assert_eq!(kept.len(), 2);
        assert!(warnings.is_empty());
    }

    fn ids_after_ordering(rows: Vec<Vec<Value>>) -> Vec<Value> {
        let t = table("emp", &["id", "boss"], &["id"]);
        let edges = vec![edge("emp", &["boss"], "emp", &["id"])];
        order_self_referencing(rows, &t, &edges)
            .iter()
            .map(|r| r[0].clone())
            .collect()
    }

    fn st(x: &str) -> Value {
        Value::String(x.to_string())
    }

    #[test]
    fn self_reference_order_ignores_case_and_trailing_spaces() {
        // 子 (boss='boss') が先に並んでいても、'BOSS' の行が先に出る。
        let rows = vec![vec![st("kid"), st("boss")], vec![st("BOSS"), Value::Null]];
        assert_eq!(ids_after_ordering(rows), vec![st("BOSS"), st("kid")]);
        // 末尾の空白の違い (PAD SPACE 照合)。
        let rows = vec![vec![st("kid"), st("boss ")], vec![st("boss"), Value::Null]];
        assert_eq!(ids_after_ordering(rows), vec![st("boss"), st("kid")]);
        // 完全一致があればそちらを優先する。
        let rows = vec![
            vec![st("kid"), st("Boss")],
            vec![st("boss"), Value::Null],
            vec![st("Boss"), Value::Null],
        ];
        assert_eq!(
            ids_after_ordering(rows),
            vec![st("Boss"), st("kid"), st("boss")]
        );
    }

    #[test]
    fn self_reference_order_loose_match_skips_null_and_handles_composite_keys() {
        // NULL の参照は依存にしない (元の順のまま)。
        let rows = vec![vec![st("a"), Value::Null], vec![st("B"), Value::Null]];
        assert_eq!(ids_after_ordering(rows), vec![st("a"), st("B")]);
        // 複合キー: 全列を緩い一致で比べる。
        let t = SubsetTable {
            name: s("n"),
            columns: vec![s("a"), s("b"), s("pa"), s("pb")],
            column_types: vec![s("varchar"); 4],
            primary_key: vec![s("a"), s("b")],
        };
        let edges = vec![edge("n", &["pa", "pb"], "n", &["a", "b"])];
        let rows = vec![
            vec![st("k"), st("1"), st("ROOT"), st("x")],
            vec![st("root"), st("X"), Value::Null, Value::Null],
        ];
        let out: Vec<Value> = order_self_referencing(rows, &t, &edges)
            .iter()
            .map(|r| r[0].clone())
            .collect();
        assert_eq!(out, vec![st("root"), st("k")]);
    }
}
