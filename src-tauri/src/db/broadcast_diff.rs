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

use super::data_diff::{key_signature, DataDiff, RowDiff, RowStatus};
use super::types::{float_text, Column, Value};
use super::DriverKind;
use crate::error::{AppError, Result};

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
    /// 基準にだけ存在した行の位置 (基準の行配列上)。件数は `removed_count`。
    pub removed_row_indices: Vec<u32>,
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
            removed_row_indices: Vec::new(),
            truncated: false,
            has_diff: false,
        }
    }
}

/// セル値の文字列表現 (JS の `String(v)` と等価な同一性を持つ)。NULL は `None`。
/// 非有限の浮動小数は IPC で文字列 (`NaN` 等) になる (#1597) ので文字列として比べる。
fn cell_text(v: &Value) -> Option<Cow<'_, str>> {
    match v {
        Value::Null => None,
        Value::Bool(b) => Some(Cow::Borrowed(if *b { "true" } else { "false" })),
        Value::Int(i) => Some(Cow::Owned(i.to_string())),
        Value::UInt(u) => Some(Cow::Owned(u.to_string())),
        Value::Float(f) if !f.is_finite() => Some(Cow::Owned(float_text(*f))),
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
            // 同名の列が複数あるキーは曖昧なので解決失敗 (hash モードへ降格)。
            if columns.iter().filter(|c| c.name == *n).count() != 1 {
                return Vec::new();
            }
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

/// 値が違う列の位置。
fn differing_cols(brow: &[Value], trow: &[Value], col_count: usize) -> Vec<usize> {
    (0..col_count)
        .filter(|&c| !cells_equal(brow.get(c), trow.get(c)))
        .collect()
}

/// PK ペアリングの結果 (すべて行配列上の位置)。
struct PkPairing {
    /// (基準の位置, 対象の位置)。対象の出現順。
    pairs: Vec<(usize, usize)>,
    /// 対象にだけある行。
    added: Vec<usize>,
    /// 基準にだけある行。
    removed: Vec<usize>,
}

/// キーで基準と対象の行を対にする。重複キーは多重集合として扱い、同じキーの基準行を
/// 出現順に持って、対象の同じキーの行が先頭から順に消費する (同一結果なら差分なし)。
fn pair_by_key(base: &[Vec<Value>], targ: &[Vec<Value>], pk_indices: &[usize]) -> PkPairing {
    let key_of = |row: &[Value]| -> String {
        key_signature(
            &pk_indices
                .iter()
                .map(|&i| row.get(i).cloned().unwrap_or(Value::Null))
                .collect::<Vec<_>>(),
        )
    };
    let mut base_by_key: HashMap<String, std::collections::VecDeque<usize>> =
        HashMap::with_capacity(base.len());
    for (i, row) in base.iter().enumerate() {
        base_by_key.entry(key_of(row)).or_default().push_back(i);
    }
    let mut matched = vec![false; base.len()];
    let mut pairs = Vec::new();
    let mut added = Vec::new();
    for (ti, trow) in targ.iter().enumerate() {
        match base_by_key
            .get_mut(&key_of(trow))
            .and_then(|q| q.pop_front())
        {
            None => added.push(ti),
            Some(bi) => {
                matched[bi] = true;
                pairs.push((bi, ti));
            }
        }
    }
    let removed = matched
        .iter()
        .enumerate()
        .filter(|(_, m)| !**m)
        .map(|(i, _)| i)
        .collect();
    PkPairing {
        pairs,
        added,
        removed,
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
        let pairing = pair_by_key(base, targ, pk_indices);
        let mut changed_cells = Vec::new();
        let mut changed_cell_count = 0u64;
        for &(bi, ti) in &pairing.pairs {
            let cols = differing_cols(&base[bi], &targ[ti], col_count);
            if !cols.is_empty() {
                changed_cell_count += cols.len() as u64;
                changed_cells.push(ChangedRow {
                    row: ti as u32,
                    cols: cols.into_iter().map(|c| c as u32).collect(),
                });
            }
        }
        let added: Vec<u32> = pairing.added.iter().map(|&i| i as u32).collect();
        let removed_row_indices: Vec<u32> = pairing.removed.iter().map(|&i| i as u32).collect();
        let removed = removed_row_indices.len() as u64;
        let has_diff = changed_cell_count > 0 || !added.is_empty() || removed > 0;
        return BroadcastDiff {
            comparable: true,
            mode: DiffMode::Pk,
            changed_cells,
            changed_cell_count,
            added_row_indices: added,
            removed_count: removed,
            removed_row_indices,
            truncated,
            has_diff,
        };
    }

    // PK が無いので行全体の多重集合比較に降格する。
    let mut remaining: HashMap<String, Vec<u32>> = HashMap::with_capacity(base.len());
    for (bi, row) in base.iter().enumerate() {
        remaining
            .entry(row_key(row, col_count))
            .or_default()
            .push(bi as u32);
    }
    let mut added = Vec::new();
    for (ti, trow) in targ.iter().enumerate() {
        match remaining.get_mut(&row_key(trow, col_count)) {
            Some(q) if !q.is_empty() => {
                q.remove(0);
            }
            _ => added.push(ti as u32),
        }
    }
    let mut removed_row_indices: Vec<u32> = remaining.into_values().flatten().collect();
    removed_row_indices.sort_unstable();
    let removed = removed_row_indices.len() as u64;
    let has_diff = !added.is_empty() || removed > 0;
    BroadcastDiff {
        comparable: true,
        mode: DiffMode::Hash,
        changed_cells: Vec::new(),
        changed_cell_count: 0,
        added_row_indices: added,
        removed_count: removed,
        removed_row_indices,
        truncated,
        has_diff,
    }
}

/// 基準に合わせる同期用の `DataDiff` (#1625)。`source` が基準、`target` が比較した環境で、
/// 環境を基準に揃える INSERT / UPDATE / DELETE の元になる。
///
/// - キーが解決できるとき (PK モード): 基準にだけある行は `SourceOnly` (INSERT)、環境に
///   だけある行は `TargetOnly` (DELETE)、値が違う行は `Different` (UPDATE)。
/// - キーが無いとき (ハッシュモード): 行を特定できないので UPDATE / DELETE は作れない。
///   基準にだけある行の INSERT だけを返し、環境の余分な行は警告に回す。
/// - どちらかが 5,000 行で打ち切られているときは、窓のずれで存在する行を欠落や
///   余剰と誤判定しうるのでエラーにする。
///
/// 重複キーの行は `key_unreliable` を立てる (UPDATE / DELETE が複数行に波及しない
/// ように、生成側 `generate_data_sync_sql` が INSERT 以外を出さない)。
pub fn build_sync_diff(
    driver: DriverKind,
    table: &str,
    baseline: EnvSide<'_>,
    target: EnvSide<'_>,
    key_columns: &[String],
) -> Result<(DataDiff, Vec<String>)> {
    if !same_columns(baseline.columns, target.columns) {
        return Err(AppError::InvalidInput(
            "the column layouts of the two environments differ; cannot build sync SQL".into(),
        ));
    }
    let cap = MAX_BROADCAST_COMPARE_ROWS as u64;
    if baseline.total > cap
        || target.total > cap
        || baseline.rows.len() as u64 != baseline.total.min(cap)
        || target.rows.len() as u64 != target.total.min(cap)
    {
        return Err(AppError::InvalidInput(
            "the results were truncated; sync SQL needs a complete comparison".into(),
        ));
    }
    let col_count = baseline.columns.len();
    let columns: Vec<String> = baseline.columns.iter().map(|c| c.name.clone()).collect();
    let column_types: Vec<String> = baseline
        .columns
        .iter()
        .map(|c| c.type_name.clone())
        .collect();
    let pk = resolve_key_indices(baseline.columns, key_columns, None);
    let (base, targ) = (baseline.rows, target.rows);
    let mut rows: Vec<RowDiff> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let key_names: Vec<String> = pk.iter().map(|&i| columns[i].clone()).collect();

    if pk.is_empty() {
        let mut remaining: HashMap<String, Vec<usize>> = HashMap::new();
        for (ti, trow) in targ.iter().enumerate() {
            remaining
                .entry(row_key(trow, col_count))
                .or_default()
                .push(ti);
        }
        let mut extra_in_target = false;
        for row in base {
            match remaining.get_mut(&row_key(row, col_count)) {
                Some(q) if !q.is_empty() => {
                    q.remove(0);
                }
                _ => rows.push(RowDiff {
                    status: RowStatus::SourceOnly,
                    key: Vec::new(),
                    source: Some(row.clone()),
                    target: None,
                    changed_columns: Vec::new(),
                    key_unreliable: false,
                }),
            }
        }
        for q in remaining.values() {
            if !q.is_empty() {
                extra_in_target = true;
            }
        }
        warnings.push(
            "主キー (キー列) が特定できないため、基準にだけある行の INSERT だけを生成しています。\
             値が違う行の UPDATE と、環境にだけある行の DELETE は行を特定できないので作れません。"
                .to_string(),
        );
        if extra_in_target {
            warnings.push(
                "環境には基準に無い行があります。キー列を指定すると DELETE / UPDATE を生成できます。"
                    .to_string(),
            );
        }
    } else {
        let pairing = pair_by_key(base, targ, &pk);
        let key_of = |row: &[Value]| -> Vec<Value> {
            pk.iter()
                .map(|&i| row.get(i).cloned().unwrap_or(Value::Null))
                .collect()
        };
        // 基準・対象のどちらかで重複しているキー (同じ行が両側に 1 つずつあるのは通常)。
        let mut per_side: HashMap<String, (usize, usize)> = HashMap::new();
        for row in base {
            per_side.entry(key_signature(&key_of(row))).or_default().0 += 1;
        }
        for row in targ {
            per_side.entry(key_signature(&key_of(row))).or_default().1 += 1;
        }
        let dup = |key: &[Value]| -> bool {
            per_side
                .get(&key_signature(key))
                .is_some_and(|&(b, t)| b > 1 || t > 1)
        };
        for &bi in &pairing.removed {
            let key = key_of(&base[bi]);
            rows.push(RowDiff {
                status: RowStatus::SourceOnly,
                key_unreliable: dup(&key),
                key,
                source: Some(base[bi].clone()),
                target: None,
                changed_columns: Vec::new(),
            });
        }
        for &(bi, ti) in &pairing.pairs {
            let cols = differing_cols(&base[bi], &targ[ti], col_count);
            let changed: Vec<String> = cols
                .into_iter()
                .filter(|c| !pk.contains(c))
                .map(|c| columns[c].clone())
                .collect();
            if changed.is_empty() {
                continue;
            }
            let key = key_of(&base[bi]);
            rows.push(RowDiff {
                status: RowStatus::Different,
                key_unreliable: dup(&key),
                key,
                source: Some(base[bi].clone()),
                target: Some(targ[ti].clone()),
                changed_columns: changed,
            });
        }
        for &ti in &pairing.added {
            let key = key_of(&targ[ti]);
            rows.push(RowDiff {
                status: RowStatus::TargetOnly,
                key_unreliable: dup(&key),
                key,
                source: None,
                target: Some(targ[ti].clone()),
                changed_columns: Vec::new(),
            });
        }
    }

    Ok((
        DataDiff {
            target_driver: driver,
            table: table.to_string(),
            columns,
            primary_key: key_names,
            column_types,
            rows,
            truncated: false,
            source_count: base.len(),
            target_count: targ.len(),
            generated_columns: Vec::new(),
        },
        warnings,
    ))
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
    fn ambiguous_key_name_is_not_resolved() {
        let c = cols(&["id", "name", "id"]);
        assert!(resolve_key_indices(&c, &["id".to_string()], None).is_empty());
        assert!(resolve_key_indices(&c, &[], Some("id")).is_empty());
        assert_eq!(resolve_key_indices(&c, &[], Some("name")), vec![1]);
    }

    #[test]
    fn pk_mode_duplicate_keys_are_paired_as_multiset() {
        // キー列に非一意の列 (id) を選んだ同一結果は差分なし。
        let dup = vec![r(1, "a"), r(1, "b")];
        let d = cmp(&dup, &dup, &[0], MAX_BROADCAST_COMPARE_ROWS);
        assert_eq!(d.mode, DiffMode::Pk);
        assert!(!d.has_diff, "{d:?}");
        assert_eq!(d.removed_count, 0);
        assert!(d.changed_cells.is_empty());
        // 対象の方が重複が多ければ余りは added、少なければ removed。
        let more = vec![r(1, "a"), r(1, "b"), r(1, "c")];
        let d = cmp(&dup, &more, &[0], MAX_BROADCAST_COMPARE_ROWS);
        assert_eq!(d.added_row_indices, vec![2]);
        let d = cmp(&more, &dup, &[0], MAX_BROADCAST_COMPARE_ROWS);
        assert_eq!(d.removed_count, 1);
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

    fn key_cols() -> Vec<String> {
        vec!["id".to_string()]
    }

    fn sync_plan(
        base: &[Vec<Value>],
        targ: &[Vec<Value>],
        keys: &[String],
    ) -> crate::db::sync::SyncPlan {
        let c = cols(&["id", "v"]);
        let (diff, warnings) = build_sync_diff(
            DriverKind::Postgres,
            "t",
            side(&c, base),
            side(&c, targ),
            keys,
        )
        .unwrap();
        let mut plan = crate::db::data_diff::generate_data_sync_sql(&diff, true);
        plan.warnings.extend(warnings);
        plan
    }

    #[test]
    fn sync_diff_aligns_the_environment_to_the_baseline() {
        let base = vec![r(1, "a"), r(2, "b"), r(3, "c")];
        let targ = vec![r(1, "a"), r(2, "B"), r(4, "d")];
        let plan = sync_plan(&base, &targ, &key_cols());
        let sqls: Vec<&str> = plan.statements.iter().map(|s| s.sql.as_str()).collect();
        assert_eq!(sqls.len(), 3, "{sqls:?}");
        assert!(sqls
            .iter()
            .any(|s| s.starts_with("INSERT") && s.contains("'c'")));
        assert!(sqls
            .iter()
            .any(|s| s.starts_with("UPDATE") && s.contains("'b'")));
        assert!(sqls
            .iter()
            .any(|s| s.starts_with("DELETE") && s.contains('4')));
    }

    #[test]
    fn sync_diff_is_empty_for_identical_results() {
        let base = vec![r(1, "a")];
        let plan = sync_plan(&base, &base, &key_cols());
        assert!(plan.statements.is_empty());
    }

    #[test]
    fn sync_diff_without_key_only_inserts_missing_rows() {
        let base = vec![r(1, "a"), r(2, "b")];
        let targ = vec![r(1, "a"), r(9, "z")];
        let plan = sync_plan(&base, &targ, &[]);
        assert_eq!(plan.statements.len(), 1);
        assert!(plan.statements[0].sql.starts_with("INSERT"));
        assert!(plan.warnings.len() >= 2, "{:?}", plan.warnings);
    }

    #[test]
    fn sync_diff_never_updates_or_deletes_duplicate_keys() {
        let base = vec![r(1, "a"), r(1, "b")];
        let targ = vec![r(1, "a"), r(1, "X")];
        let plan = sync_plan(&base, &targ, &key_cols());
        assert!(
            plan.statements.iter().all(|s| s.sql.starts_with("INSERT")),
            "{:?}",
            plan.statements
        );
    }

    #[test]
    fn sync_diff_rejects_truncated_or_mismatched_results() {
        let c = cols(&["id", "v"]);
        let rows = vec![r(1, "a")];
        let truncated = EnvSide {
            columns: &c,
            rows: &rows,
            total: MAX_BROADCAST_COMPARE_ROWS as u64 + 1,
        };
        assert!(build_sync_diff(
            DriverKind::Mysql,
            "t",
            truncated,
            side(&c, &rows),
            &key_cols()
        )
        .is_err());
        let other = cols(&["id", "w"]);
        assert!(build_sync_diff(
            DriverKind::Mysql,
            "t",
            side(&c, &rows),
            side(&other, &rows),
            &key_cols()
        )
        .is_err());
    }

    #[test]
    fn removed_row_indices_point_into_the_baseline() {
        let base = vec![r(1, "a"), r(2, "b"), r(3, "c")];
        let targ = vec![r(2, "b")];
        let d = cmp(&base, &targ, &[0], MAX_BROADCAST_COMPARE_ROWS);
        assert_eq!(d.removed_row_indices, vec![0, 2]);
        let h = cmp(&base, &targ, &[], MAX_BROADCAST_COMPARE_ROWS);
        assert_eq!(h.mode, DiffMode::Hash);
        assert_eq!(h.removed_row_indices, vec![0, 2]);
    }
}
