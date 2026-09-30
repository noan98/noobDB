//! 自動リフレッシュの差分パッチ (#1257)。
//!
//! 自動リフレッシュは同じ SELECT を一定間隔で全件再実行し、フロントが前回結果との
//! 差分 (`resultDiff.ts`) を取っていた。結果が大きいと「毎 tick 全行を IPC で送る →
//! JSON パース → 全行を PK で突き合わせ」が走り続ける。ここではタブ単位で前回結果の
//! 「PK ハッシュ → 行ハッシュ」を Rust 側に保持し、再実行時は行を送らずに
//! **変化行・追加行の実データ + 変化の無い連続区間の参照 + 削除数** だけのパッチを返す。
//!
//! - 前回結果の各行は位置 (`from`) で参照する。フロントは手元の前回行配列から
//!   `Keep { from, count }` の区間をそのままコピーし、`Rows` の行を差し込むだけで
//!   今回の結果を再構成できる (並び順もこの区間列が保持する)。
//! - 全行が前回と同一なら `unchanged` (パッチ本体は空)。
//! - 整合性: スナップショットは発行時に ID が振られ、フロントは「その ID を付けた行配列」を
//!   まだ持っているときだけ前回 ID を渡す。ID 不一致・列構成の変化・PK 列の範囲外は
//!   パッチにせず従来どおり全行ストリームへフォールバックする。
//! - PK が重複する行は 2 行目以降を「追加行」として実データで送る (再構成は常に正確)。
//!   PK が無い結果では呼び出し側がそもそもこのモードを要求しない。
//!
//! 行の等価判定は 128bit ハッシュ (`stream_batch::hash_values`)。衝突確率は実用上無視できる。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde::Serialize;

use super::stream_batch::hash_values;
use super::types::{Column, Value};

/// スナップショットを保持する最大行数。超える結果は保持せず、毎回全行を送る。
pub const MAX_SNAPSHOT_ROWS: usize = 500_000;
/// 同時に保持するスナップショット (タブ) の最大数。古いものから捨てる。
pub const MAX_SNAPSHOTS: usize = 16;

/// 前回結果のスナップショット。行データ自体は持たない (ハッシュだけ)。
#[derive(Debug)]
pub struct RefreshSnapshot {
    pub id: u64,
    columns: Vec<(String, String)>,
    pk: Vec<usize>,
    /// 結果順の `(PK ハッシュ, 行ハッシュ)`。
    rows: Vec<(u128, u128)>,
    /// PK ハッシュ → 最初に現れた行位置。
    index: HashMap<u128, u32>,
}

impl RefreshSnapshot {
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }
}

fn column_sig(columns: &[Column]) -> Vec<(String, String)> {
    columns
        .iter()
        .map(|c| (c.name.clone(), c.type_name.clone()))
        .collect()
}

/// パッチの 1 区間。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PatchRun {
    /// 前回結果の `from` から `count` 行を、そのままの並びでコピーする。
    Keep { from: u32, count: u32 },
    /// 実データの行。`prev[i]` は `rows[i]` が対応する前回行の位置 (追加行は `null`)。
    Rows {
        prev: Vec<Option<u32>>,
        rows: Vec<Vec<Value>>,
    },
}

/// 今回結果を前回結果からの差分で表したもの。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchPayload {
    pub total_rows: u64,
    /// 全行が前回と同一 (`runs` は空)。
    pub unchanged: bool,
    /// 前回にあって今回に対応が無い行の数。
    pub removed_count: u64,
    pub runs: Vec<PatchRun>,
}

/// `RefreshBuilder::finish` の結果。
#[derive(Debug)]
pub struct RefreshOutcome {
    /// 次回の比較元。保持できない (行数超過) ときは `None`。
    pub snapshot: Option<RefreshSnapshot>,
    /// パッチモードだったときのパッチ。
    pub patch: Option<PatchPayload>,
}

/// ストリーム中の行を 1 行ずつ取り込み、スナップショットとパッチを組み立てる。
pub struct RefreshBuilder {
    prev: Option<Arc<RefreshSnapshot>>,
    pk: Vec<usize>,
    columns: Vec<(String, String)>,
    rows: Vec<(u128, u128)>,
    index: HashMap<u128, u32>,
    overflow: bool,
    // --- パッチモード用 ---
    used: Vec<bool>,
    used_count: usize,
    runs: Vec<PatchRun>,
    keep: Option<(u32, u32)>,
    pending_prev: Vec<Option<u32>>,
    pending_rows: Vec<Vec<Value>>,
    total: u64,
}

impl RefreshBuilder {
    /// `pk` は今回結果の列に対する主キー列の添字。空・範囲外なら `None` (このモードを使わない)。
    /// `prev` が今回の列構成と一致するときだけパッチモードになる。
    pub fn new(
        prev: Option<Arc<RefreshSnapshot>>,
        pk: &[usize],
        columns: &[Column],
    ) -> Option<Self> {
        if pk.is_empty() || pk.iter().any(|&i| i >= columns.len()) {
            return None;
        }
        let sig = column_sig(columns);
        let prev = prev.filter(|p| p.columns == sig && p.pk == pk);
        let used = prev
            .as_ref()
            .map_or_else(Vec::new, |p| vec![false; p.len()]);
        Some(Self {
            prev,
            pk: pk.to_vec(),
            columns: sig,
            rows: Vec::new(),
            index: HashMap::new(),
            overflow: false,
            used,
            used_count: 0,
            runs: Vec::new(),
            keep: None,
            pending_prev: Vec::new(),
            pending_rows: Vec::new(),
            total: 0,
        })
    }

    /// 前回スナップショットと突き合わせるパッチモードか。
    pub fn is_patch(&self) -> bool {
        self.prev.is_some()
    }

    fn flush_keep(&mut self) {
        if let Some((from, count)) = self.keep.take() {
            self.runs.push(PatchRun::Keep { from, count });
        }
    }

    fn flush_rows(&mut self) {
        if !self.pending_rows.is_empty() {
            self.runs.push(PatchRun::Rows {
                prev: std::mem::take(&mut self.pending_prev),
                rows: std::mem::take(&mut self.pending_rows),
            });
        }
    }

    pub fn observe(&mut self, row: &[Value]) {
        let key = hash_values(self.pk.iter().map(|&i| &row[i]));
        let rh = hash_values(row.iter());
        self.total += 1;

        if !self.overflow {
            if self.rows.len() >= MAX_SNAPSHOT_ROWS {
                self.overflow = true;
                self.rows = Vec::new();
                self.index = HashMap::new();
            } else {
                let pos = self.rows.len() as u32;
                self.index.entry(key).or_insert(pos);
                self.rows.push((key, rh));
            }
        }

        let Some(prev) = self.prev.clone() else {
            return;
        };
        let matched = prev
            .index
            .get(&key)
            .copied()
            .filter(|&p| !self.used[p as usize]);
        match matched {
            Some(p) => {
                self.used[p as usize] = true;
                self.used_count += 1;
                if prev.rows[p as usize].1 == rh {
                    // 変化なし: 連続する前回位置なら区間を延ばす。
                    self.flush_rows();
                    match &mut self.keep {
                        Some((from, count)) if *from + *count == p => *count += 1,
                        _ => {
                            self.flush_keep();
                            self.keep = Some((p, 1));
                        }
                    }
                } else {
                    self.flush_keep();
                    self.pending_prev.push(Some(p));
                    self.pending_rows.push(row.to_vec());
                }
            }
            None => {
                self.flush_keep();
                self.pending_prev.push(None);
                self.pending_rows.push(row.to_vec());
            }
        }
    }

    pub fn finish(mut self) -> RefreshOutcome {
        let patch = self.prev.clone().map(|prev| {
            self.flush_keep();
            self.flush_rows();
            let removed = prev.len().saturating_sub(self.used_count) as u64;
            let unchanged = removed == 0
                && self.total as usize == prev.len()
                && match self.runs.as_slice() {
                    [] => true,
                    [PatchRun::Keep { from: 0, count }] => *count as usize == prev.len(),
                    _ => false,
                };
            PatchPayload {
                total_rows: self.total,
                unchanged,
                removed_count: removed,
                runs: if unchanged {
                    Vec::new()
                } else {
                    std::mem::take(&mut self.runs)
                },
            }
        });
        let snapshot = if self.overflow {
            None
        } else {
            Some(RefreshSnapshot {
                id: 0,
                columns: self.columns,
                pk: self.pk,
                rows: self.rows,
                index: self.index,
            })
        };
        RefreshOutcome { snapshot, patch }
    }
}

/// スナップショットの保管庫 (`AppState` が持つ)。キーは「セッション + タブ」。
#[derive(Default)]
pub struct RefreshSnapshotStore {
    map: HashMap<String, Arc<RefreshSnapshot>>,
    order: VecDeque<String>,
    seq: u64,
}

impl RefreshSnapshotStore {
    /// `key` のスナップショットのうち、ID が `id` に一致するものだけを返す。
    pub fn get_matching(&self, key: &str, id: Option<u64>) -> Option<Arc<RefreshSnapshot>> {
        let id = id?;
        self.map.get(key).filter(|s| s.id == id).cloned()
    }

    /// 新しいスナップショットを保管し、ID 付きで返す。上限超過分は古い順に捨てる。
    pub fn put(&mut self, key: &str, mut snap: RefreshSnapshot) -> Arc<RefreshSnapshot> {
        self.seq += 1;
        snap.id = self.seq;
        let arc = Arc::new(snap);
        if self.map.insert(key.to_string(), arc.clone()).is_some() {
            self.order.retain(|k| k != key);
        }
        self.order.push_back(key.to_string());
        while self.order.len() > MAX_SNAPSHOTS {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
        arc
    }

    pub fn remove(&mut self, key: &str) {
        if self.map.remove(key).is_some() {
            self.order.retain(|k| k != key);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<Column> {
        vec![
            Column {
                name: "id".into(),
                type_name: "INT".into(),
            },
            Column {
                name: "v".into(),
                type_name: "TEXT".into(),
            },
        ]
    }

    fn row(id: i64, v: &str) -> Vec<Value> {
        vec![Value::Int(id), Value::String(v.into())]
    }

    fn snapshot_of(rows: &[Vec<Value>]) -> Arc<RefreshSnapshot> {
        let mut b = RefreshBuilder::new(None, &[0], &cols()).expect("builder");
        for r in rows {
            b.observe(r);
        }
        let mut snap = b.finish().snapshot.expect("snapshot");
        snap.id = 1;
        Arc::new(snap)
    }

    /// フロント (`applyRefreshPatch`) と同じ規則でパッチを適用する。
    fn apply(prev: &[Vec<Value>], p: &PatchPayload) -> Vec<Vec<Value>> {
        if p.unchanged {
            return prev.to_vec();
        }
        let mut out = Vec::new();
        for run in &p.runs {
            match run {
                PatchRun::Keep { from, count } => {
                    out.extend_from_slice(&prev[*from as usize..(*from + *count) as usize]);
                }
                PatchRun::Rows { rows, .. } => out.extend(rows.iter().cloned()),
            }
        }
        out
    }

    fn patch_for(prev_rows: &[Vec<Value>], next_rows: &[Vec<Value>]) -> PatchPayload {
        let prev = snapshot_of(prev_rows);
        let mut b = RefreshBuilder::new(Some(prev), &[0], &cols()).expect("builder");
        assert!(b.is_patch());
        for r in next_rows {
            b.observe(r);
        }
        b.finish().patch.expect("patch")
    }

    #[test]
    fn identical_result_is_unchanged() {
        let rows = vec![row(1, "a"), row(2, "b"), row(3, "c")];
        let p = patch_for(&rows, &rows);
        assert!(p.unchanged);
        assert_eq!(p.removed_count, 0);
        assert_eq!(p.total_rows, 3);
        assert!(p.runs.is_empty());
    }

    #[test]
    fn changed_added_removed_rows_reconstruct_exactly() {
        let prev = vec![row(1, "a"), row(2, "b"), row(3, "c"), row(4, "d")];
        // 2 を変更、3 を削除、5 を追加、順序は 4,1,2,5 に入れ替え。
        let next = vec![row(4, "d"), row(1, "a"), row(2, "B"), row(5, "e")];
        let p = patch_for(&prev, &next);
        assert!(!p.unchanged);
        assert_eq!(p.removed_count, 1);
        assert_eq!(apply(&prev, &p), next);
        // 変更行は前回位置付き、追加行は null。
        let mut saw_changed = false;
        let mut saw_added = false;
        for run in &p.runs {
            if let PatchRun::Rows { prev, .. } = run {
                saw_changed |= prev.contains(&Some(1));
                saw_added |= prev.contains(&None);
            }
        }
        assert!(saw_changed && saw_added);
    }

    #[test]
    fn unchanged_rows_collapse_into_runs() {
        let prev: Vec<_> = (0..100).map(|i| row(i, "x")).collect();
        let mut next = prev.clone();
        next[50] = row(50, "y");
        let p = patch_for(&prev, &next);
        assert_eq!(apply(&prev, &p), next);
        // Keep(0..50), Rows(1), Keep(51..100) の 3 区間。
        assert_eq!(p.runs.len(), 3);
        assert_eq!(p.removed_count, 0);
    }

    #[test]
    fn append_only_keeps_prefix_as_one_run() {
        let prev: Vec<_> = (0..10).map(|i| row(i, "x")).collect();
        let mut next = prev.clone();
        next.push(row(10, "new"));
        let p = patch_for(&prev, &next);
        assert!(!p.unchanged);
        assert_eq!(p.runs.len(), 2);
        assert_eq!(apply(&prev, &p), next);
    }

    #[test]
    fn empty_to_empty_is_unchanged_and_shrink_counts_removed() {
        let p = patch_for(&[], &[]);
        assert!(p.unchanged);
        let prev = vec![row(1, "a"), row(2, "b")];
        let p = patch_for(&prev, &[]);
        assert!(!p.unchanged);
        assert_eq!(p.removed_count, 2);
        assert_eq!(p.total_rows, 0);
    }

    #[test]
    fn duplicate_keys_are_sent_as_added_rows() {
        let prev = vec![row(1, "a")];
        let next = vec![row(1, "a"), row(1, "dup")];
        let p = patch_for(&prev, &next);
        assert_eq!(apply(&prev, &p), next);
        assert_eq!(p.removed_count, 0);
    }

    #[test]
    fn column_change_disables_patch_mode() {
        let prev = snapshot_of(&[row(1, "a")]);
        let mut other = cols();
        other[1].type_name = "VARCHAR".into();
        let b = RefreshBuilder::new(Some(prev), &[0], &other).expect("builder");
        assert!(!b.is_patch());
    }

    #[test]
    fn invalid_pk_yields_no_builder() {
        assert!(RefreshBuilder::new(None, &[], &cols()).is_none());
        assert!(RefreshBuilder::new(None, &[5], &cols()).is_none());
    }

    #[test]
    fn store_matches_id_and_evicts_oldest() {
        let mut store = RefreshSnapshotStore::default();
        let snap = |rows: &[Vec<Value>]| Arc::try_unwrap(snapshot_of(rows)).expect("unique");
        let a = store.put("a", snap(&[row(1, "a")]));
        assert!(store.get_matching("a", Some(a.id)).is_some());
        assert!(store.get_matching("a", Some(a.id + 100)).is_none());
        assert!(store.get_matching("a", None).is_none());
        for i in 0..MAX_SNAPSHOTS {
            store.put(&format!("k{i}"), snap(&[]));
        }
        assert_eq!(store.len(), MAX_SNAPSHOTS);
        assert!(store.get_matching("a", Some(a.id)).is_none());
        store.remove("k0");
        assert_eq!(store.len(), MAX_SNAPSHOTS - 1);
    }

    #[test]
    fn serializes_camel_case_runs() {
        let p = PatchPayload {
            total_rows: 2,
            unchanged: false,
            removed_count: 1,
            runs: vec![
                PatchRun::Keep { from: 0, count: 1 },
                PatchRun::Rows {
                    prev: vec![None],
                    rows: vec![vec![Value::Int(9)]],
                },
            ],
        };
        let v = serde_json::to_value(&p).expect("json");
        assert_eq!(v["totalRows"], 2);
        assert_eq!(v["removedCount"], 1);
        assert_eq!(v["runs"][0]["type"], "keep");
        assert_eq!(v["runs"][1]["type"], "rows");
        assert_eq!(v["runs"][1]["prev"][0], serde_json::Value::Null);
    }
}
