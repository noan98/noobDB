//! 環境横断ブロードキャスト (#738) の結果比較 (#1257)。
//!
//! これまでフロントが各環境の全行を受け取り、`broadcastCompare.ts` と `ResultGrid` の
//! 二か所で `resultDiff.ts` を回していた。ここでは基準環境と対象環境の結果を Rust で
//! 突き合わせ、**差分サマリと (上限付きの) 変化セル位置だけ**を返す。
//!
//! - 列構成 (列数 > 0・列名・順序) が一致しなければ比較不能 (`mode: none`)。
//! - `pk_indices` が非空なら PK ペアリング (`mode: pk`)。キー署名は
//!   `data_diff::key_signature` をそのまま使う (整数 `1` と文字列 `"1"` は別のキー)。
//!   セルの等価は `resultDiff.ts::valuesEqual` と同じ (NULL 同士は等しく、それ以外は
//!   文字列化して比較)。`compute_data_diff` ではなく自前のペアリングにしているのは、
//!   あちらが変更列を**列名**で返す (重複する列名を区別できない) うえ、対象行の
//!   位置を返さない (グリッドのハイライトに必要) ため。
//! - 空なら行全体の多重集合比較 (`mode: hash`)。追加/欠落の件数だけを返す。
//! - 両側とも先頭 `max_rows` 行で打ち切って比較する (`truncated`)。

use std::borrow::Cow;
use std::collections::HashMap;

use serde::Serialize;

use super::data_diff::key_signature;
use super::types::{Column, Value};

/// 比較する最大行数 (フロントの `MAX_BROADCAST_COMPARE_ROWS` と同じ意味・値)。
pub const MAX_BROADCAST_COMPARE_ROWS: usize = 5000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiffMode {
    Pk,
    Hash,
    None,
}

/// 変化セルを持つ対象行 1 件 (対象の行配列上の位置と、変化した列の位置)。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedRow {
    pub row: u32,
    pub cols: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastDiff {
    pub comparable: bool,
    pub mode: DiffMode,
    /// `mode == pk` のときの変化セル (疎表現)。
    pub changed_cells: Vec<ChangedRow>,
    pub changed_cell_count: u64,
    /// 対象にだけ存在する行の位置。
    pub added_row_indices: Vec<u32>,
    /// 基準にだけ存在した行の件数。
    pub removed_count: u64,
    pub truncated: bool,
    pub has_diff: bool,
}

impl BroadcastDiff {
    fn incomparable() -> Self {
        Self {
            comparable: false,
            mode: DiffMode::None,
            changed_cells: Vec::new(),
            changed_cell_count: 0,
            added_row_indices: Vec::new(),
            removed_count: 0,
            truncated: false,
            has_diff: false,
        }
    }
}

/// セル値の文字列表現 (JS の `String(v)` と等価な同一性を持つ)。NULL は `None`。
/// 非有限の浮動小数は JSON で `null` になる (= フロントでは NULL) ので `None`。
fn cell_text(v: &Value) -> Option<Cow<'_, str>> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(Cow::Borrowed(if *b { "true" } else { "false" })),
        Value::Int(i) => Some(Cow::Owned(i.to_string())),
        Value::UInt(u) => Some(Cow::Owned(u.to_string())),
        Value::Float(f) if !f.is_finite() => None,
        Value::Float(f) => Some(if *f == 0.0 {
            Cow::Borrowed("0")
        } else {
            Cow::Owned(f.to_string())
        }),
        Value::String(s) | Value::Bytes(s) => Some(Cow::Borrowed(s.as_str())),
    }
}

fn cells_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    let ta = a.and_then(cell_text);
    let tb = b.and_then(cell_text);
    ta == tb
}

fn same_columns(a: &[Column], b: &[Column]) -> bool {
    !a.is_empty() && a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.name == y.name)
}

/// 行全体を多重集合比較用の 1 つの文字列キーへ畳み込む (長さ接頭辞で曖昧さを排除)。
fn row_key(row: &[Value], col_count: usize) -> String {
    let mut out = String::new();
    for i in 0..col_count {
        match row.get(i).and_then(cell_text) {
            None => out.push_str("n;"),
            Some(t) => {
                out.push_str(&t.len().to_string());
                out.push(':');
                out.push_str(&t);
            }
        }
    }
    out
}

/// 表の主キー列名 → ユーザ指定の単一キー列名の順で、基準の列から列位置を解決する。
/// 名前が 1 つでも見つからなければその候補は無効 (フロントの `resolvePkIndices` /
/// `resolveKeyIndicesByName` と同じ保守的な失敗モード)。どちらも解決できなければ空。
pub fn resolve_key_indices(
    columns: &[Column],
    table_pk: &[String],
    user_key: Option<&str>,
) -> Vec<usize> {
    let resolve = |names: &[&str]| -> Vec<usize> {
        if names.is_empty() {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(names.len());
        for n in names {
            match columns.iter().position(|c| c.name == *n) {
                Some(i) => out.push(i),
                None => return Vec::new(),
            }
        }
        out
    };
    let from_table = resolve(&table_pk.iter().map(String::as_str).collect::<Vec<_>>());
    if !from_table.is_empty() {
        return from_table;
    }
    match user_key {
        Some(k) if !k.is_empty() => resolve(&[k]),
        _ => Vec::new(),
    }
}

/// 比較する片側の環境の結果。`total` は打ち切り前の総行数。
#[derive(Debug, Clone, Copy)]
pub struct EnvSide<'a> {
    pub columns: &'a [Column],
    pub rows: &'a [Vec<Value>],
    pub total: u64,
}

/// 基準 `baseline` と対象 `target` を比較する。
pub fn compare_environments(
    baseline: EnvSide<'_>,
    target: EnvSide<'_>,
    pk_indices: &[usize],
    max_rows: usize,
) -> BroadcastDiff {
    if !same_columns(baseline.columns, target.columns) {
        return BroadcastDiff::incomparable();
    }
    let col_count = baseline.columns.len();
    let truncated = baseline.total > max_rows as u64
        || target.total > max_rows as u64
        || baseline.rows.len() > max_rows
        || target.rows.len() > max_rows;
    let base = &baseline.rows[..baseline.rows.len().min(max_rows)];
    let targ = &target.rows[..target.rows.len().min(max_rows)];

    if !pk_indices.is_empty() && pk_indices.iter().all(|&i| i < col_count) {
        let key_of = |row: &[Value]| -> String {
            key_signature(
                &pk_indices
                    .iter()
                    .map(|&i| row.get(i).cloned().unwrap_or(Value::Null))
                    .collect::<Vec<_>>(),
            )
        };
        // 重複キーは後勝ち (`diffResultRows` と同じ)。
        let mut base_by_key: HashMap<String, usize> = HashMap::with_capacity(base.len());
        for (i, row) in base.iter().enumerate() {
            base_by_key.insert(key_of(row), i);
        }
        let mut matched = vec![false; base.len()];
        let mut changed_cells = Vec::new();
        let mut changed_cell_count = 0u64;
        let mut added = Vec::new();
        for (ti, trow) in targ.iter().enumerate() {
            match base_by_key.get(&key_of(trow)) {
                None => added.push(ti as u32),
                Some(&bi) => {
                    matched[bi] = true;
                    let brow = &base[bi];
                    let cols: Vec<u32> = (0..col_count)
                        .filter(|&c| !cells_equal(brow.get(c), trow.get(c)))
                        .map(|c| c as u32)
                        .collect();
                    if !cols.is_empty() {
                        changed_cell_count += cols.len() as u64;
                        changed_cells.push(ChangedRow {
                            row: ti as u32,
                            cols,
                        });
                    }
                }
            }
        }
        let removed = matched.iter().filter(|m| !**m).count() as u64;
        let has_diff = changed_cell_count > 0 || !added.is_empty() || removed > 0;
        return BroadcastDiff {
            comparable: true,
            mode: DiffMode::Pk,
            changed_cells,
            changed_cell_count,
            added_row_indices: added,
            removed_count: removed,
            truncated,
            has_diff,
        };
    }

    // PK が無いので行全体の多重集合比較に降格する。
    let mut remaining: HashMap<String, u32> = HashMap::with_capacity(base.len());
    for row in base {
        *remaining.entry(row_key(row, col_count)).or_insert(0) += 1;
    }
    let mut added = Vec::new();
    for (ti, trow) in targ.iter().enumerate() {
        match remaining.get_mut(&row_key(trow, col_count)) {
            Some(n) if *n > 0 => *n -= 1,
            _ => added.push(ti as u32),
        }
    }
    let removed: u64 = remaining.values().map(|&n| u64::from(n)).sum();
    let has_diff = !added.is_empty() || removed > 0;
    BroadcastDiff {
        comparable: true,
        mode: DiffMode::Hash,
        changed_cells: Vec::new(),
        changed_cell_count: 0,
        added_row_indices: added,
        removed_count: removed,
        truncated,
        has_diff,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols(names: &[&str]) -> Vec<Column> {
        names
            .iter()
            .map(|n| Column {
                name: (*n).into(),
                type_name: "TEXT".into(),
            })
            .collect()
    }

    fn r(id: i64, v: &str) -> Vec<Value> {
        vec![Value::Int(id), Value::String(v.into())]
    }

    fn side<'a>(columns: &'a [Column], rows: &'a [Vec<Value>]) -> EnvSide<'a> {
        EnvSide {
            columns,
            rows,
            total: rows.len() as u64,
        }
    }

    fn cmp(base: &[Vec<Value>], targ: &[Vec<Value>], pk: &[usize], max: usize) -> BroadcastDiff {
        let c = cols(&["id", "v"]);
        compare_environments(side(&c, base), side(&c, targ), pk, max)
    }

    #[test]
    fn pk_mode_reports_changed_added_removed() {
        let base = vec![r(1, "a"), r(2, "b"), r(3, "c")];
        let targ = vec![r(1, "a"), r(2, "B"), r(4, "d")];
        let d = cmp(&base, &targ, &[0], MAX_BROADCAST_COMPARE_ROWS);
        assert!(d.comparable && d.has_diff);
        assert_eq!(d.mode, DiffMode::Pk);
        assert_eq!(
            d.changed_cells,
            vec![ChangedRow {
                row: 1,
                cols: vec![1]
            }]
        );
        assert_eq!(d.changed_cell_count, 1);
        assert_eq!(d.added_row_indices, vec![2]);
        assert_eq!(d.removed_count, 1);
        assert!(!d.truncated);
    }

    #[test]
    fn identical_results_have_no_diff() {
        let base = vec![r(1, "a"), r(2, "b")];
        let d = cmp(&base, &base, &[0], 10);
        assert!(d.comparable && !d.has_diff);
        let d = cmp(&base, &base, &[], 10);
        assert!(d.comparable && !d.has_diff);
        assert_eq!(d.mode, DiffMode::Hash);
    }

    #[test]
    fn null_and_type_crossing_equality_follows_result_diff() {
        // NULL 同士は等しい。数値 1 と文字列 "1" は文字列化して等しい。
        let base = vec![
            vec![Value::Int(1), Value::Null],
            vec![Value::Int(2), Value::Int(1)],
        ];
        let targ = vec![
            vec![Value::Int(1), Value::Null],
            vec![Value::Int(2), Value::String("1".into())],
        ];
        let d = cmp(&base, &targ, &[0], 10);
        assert!(!d.has_diff);
        // NULL と空文字は別物。
        let targ = vec![vec![Value::Int(1), Value::String(String::new())]];
        let d = cmp(&[vec![Value::Int(1), Value::Null]], &targ, &[0], 10);
        assert_eq!(d.changed_cell_count, 1);
    }

    #[test]
    fn hash_mode_is_a_multiset_comparison() {
        let base = vec![r(1, "a"), r(1, "a"), r(2, "b")];
        let targ = vec![r(1, "a"), r(3, "c"), r(2, "b"), r(2, "b")];
        let d = cmp(&base, &targ, &[], 10);
        assert_eq!(d.mode, DiffMode::Hash);
        // 基準の (1,a) が 1 つ余り、対象の (3,c) と 2 つ目の (2,b) が追加。
        assert_eq!(d.removed_count, 1);
        assert_eq!(d.added_row_indices, vec![1, 3]);
        assert!(d.changed_cells.is_empty());
    }

    #[test]
    fn column_mismatch_is_incomparable() {
        let a = cols(&["id", "v"]);
        let b = cols(&["id", "w"]);
        let d = compare_environments(side(&a, &[]), side(&b, &[]), &[0], 10);
        assert!(!d.comparable && !d.has_diff);
        assert_eq!(d.mode, DiffMode::None);
        let d = compare_environments(side(&[], &[]), side(&[], &[]), &[], 10);
        assert!(!d.comparable);
    }

    #[test]
    fn rows_beyond_the_cap_are_truncated_and_flagged() {
        let base: Vec<_> = (0..20).map(|i| r(i, "x")).collect();
        let mut targ = base.clone();
        targ[15] = r(15, "changed");
        // 上限 10 行だと 15 行目の変更は見えないが、打ち切りは通知する。
        let c = cols(&["id", "v"]);
        let d = compare_environments(
            EnvSide {
                columns: &c,
                rows: &base[..10],
                total: 20,
            },
            EnvSide {
                columns: &c,
                rows: &targ[..10],
                total: 20,
            },
            &[0],
            10,
        );
        assert!(d.truncated && !d.has_diff);
    }

    #[test]
    fn key_resolution_prefers_table_pk_then_user_key() {
        let c = cols(&["id", "v"]);
        assert_eq!(resolve_key_indices(&c, &["id".into()], Some("v")), vec![0]);
        assert_eq!(resolve_key_indices(&c, &[], Some("v")), vec![1]);
        // 表の PK が結果に無ければユーザ指定へ、それも無ければ空。
        assert_eq!(resolve_key_indices(&c, &["zz".into()], Some("v")), vec![1]);
        assert!(resolve_key_indices(&c, &["zz".into()], None).is_empty());
        assert!(resolve_key_indices(&c, &[], Some("nope")).is_empty());
        assert!(resolve_key_indices(&c, &[], Some("")).is_empty());
    }

    #[test]
    fn float_and_int_with_same_text_are_equal() {
        let base = vec![vec![Value::Int(1), Value::Float(2.0)]];
        let targ = vec![vec![Value::Int(1), Value::Int(2)]];
        let d = cmp(&base, &targ, &[0], 10);
        assert!(!d.has_diff);
    }

    #[test]
    fn composite_primary_key_pairs_rows() {
        let c = cols(&["tenant", "id", "value"]);
        let row3 = |t: i64, id: &str, v: &str| {
            vec![
                Value::Int(t),
                Value::String(id.into()),
                Value::String(v.into()),
            ]
        };
        let base = vec![row3(1, "x", "old"), row3(1, "y", "keep")];
        let targ = vec![row3(1, "x", "new"), row3(1, "y", "keep")];
        let d = compare_environments(side(&c, &base), side(&c, &targ), &[0, 1], 10);
        assert_eq!(d.mode, DiffMode::Pk);
        assert_eq!(
            d.changed_cells,
            vec![ChangedRow {
                row: 0,
                cols: vec![2]
            }]
        );
    }

    #[test]
    fn empty_sides_in_hash_mode() {
        let c = cols(&["id", "v"]);
        let some = vec![r(1, "a"), r(2, "b")];
        let d = compare_environments(side(&c, &[]), side(&c, &[]), &[], 10);
        assert_eq!(d.mode, DiffMode::Hash);
        assert!(!d.has_diff && !d.truncated);
        // 基準が空なら対象の全行が追加、対象が空なら基準の全行が欠落。
        let d = compare_environments(side(&c, &[]), side(&c, &some), &[], 10);
        assert_eq!(d.added_row_indices, vec![0, 1]);
        assert_eq!(d.removed_count, 0);
        let d = compare_environments(side(&c, &some), side(&c, &[]), &[], 10);
        assert_eq!(d.removed_count, 2);
        assert!(d.added_row_indices.is_empty());
    }

    #[test]
    fn changed_non_key_cell_is_remove_plus_add_in_hash_mode() {
        let d = cmp(&[r(1, "a")], &[r(1, "b")], &[], 10);
        assert_eq!(d.mode, DiffMode::Hash);
        assert_eq!(d.added_row_indices, vec![0]);
        assert_eq!(d.removed_count, 1);
    }

    #[test]
    fn number_and_numeric_string_are_equal_in_hash_mode() {
        let base = vec![vec![Value::Int(1), Value::String("100".into())]];
        let targ = vec![vec![Value::Int(1), Value::Int(100)]];
        assert!(!cmp(&base, &targ, &[], 10).has_diff);
    }

    #[test]
    fn composite_keys_distinguish_int_from_string() {
        // 整数 1 と文字列 "1" は別のキー (key_signature のタグ付き表現)。
        let base = vec![vec![Value::Int(1), Value::String("a".into())]];
        let targ = vec![vec![Value::String("1".into()), Value::String("a".into())]];
        let d = cmp(&base, &targ, &[0], 10);
        assert_eq!(d.added_row_indices, vec![0]);
        assert_eq!(d.removed_count, 1);
    }

    #[test]
    fn serializes_camel_case() {
        let d = cmp(&[r(1, "a")], &[r(1, "b")], &[0], 10);
        let v = serde_json::to_value(&d).expect("json");
        assert_eq!(v["mode"], "pk");
        assert_eq!(v["changedCellCount"], 1);
        assert_eq!(v["changedCells"][0]["row"], 0);
        assert_eq!(v["hasDiff"], true);
    }
}
