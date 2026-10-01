//! 上限付きの「結果ハンドル」ストア (#1264)。
//!
//! Epic #1093 では「大量結果をバックエンドに保持しない」方針だったが、数十万行以上の結果を
//! グリッドでソート・フィルタ・検索・エクスポートするたびに行を JS ⇄ Rust で往復させるのが
//! 最大のボトルネックだった。そこでストリーミングで流した行を、**合計メモリ上限付きで**
//! Rust 側にも保持し、フロントは `result_id` だけを持って操作を依頼する。
//!
//! - **上限**: 値の概算サイズ ([`approx_row_bytes`]) の合計が [`ResultStore`] の上限
//!   (既定 [`DEFAULT_RESULT_STORE_BYTES`]) を超えないよう、超えるなら**最も使われていない
//!   (LRU) 結果から破棄**する。1 つで上限を超える結果は保持しない (ハンドルなし)。
//! - **ハンドルなし**: 保持できなかった結果 (上限超過・小さすぎる結果・エラー/キャンセル) は
//!   `result_id` を持たず、フロントは従来どおり JS から行を送る経路にフォールバックする。
//!   LRU で後から破棄された場合も、操作は [`RESULT_GONE`] を含むエラー / `null` を返し、
//!   フロントはハンドルを捨てて JS 経路へ戻る。
//! - **破棄**: `release_result` (タブを閉じる・同じタブで再実行)、セッション切断
//!   ([`ResultStore::release_session`])、LRU。アプリ終了でも当然消える (メモリのみ)。
//! - **構築中の一時コスト**: ストリーム中は [`ResultBuilder`] が行を複製して溜める
//!   (上限を超えた時点で即座に捨てる)。同時実行ストリームが多いと、上限 × 並列数までは
//!   一時的に超えうる。確定 (`insert`) 時に LRU で合計上限へ収める。

use std::collections::HashMap;
use std::sync::Arc;

use super::types::Value;

/// 既定の合計メモリ上限 (256 MiB)。
pub const DEFAULT_RESULT_STORE_BYTES: usize = 256 * 1024 * 1024;

/// これより行数の少ない結果はハンドルを作らない。小さい結果は JS から送っても十分速く、
/// 保持するメモリと複製コストに見合わない。
pub const MIN_RETAIN_ROWS: usize = 5_000;

/// ハンドルが見つからない (破棄済み / 上限で追い出された) ときのエラーメッセージ接頭辞。
/// フロント (`resultHandle.ts::isResultGoneError`) がこの文字列でフォールバックを判断する。
pub const RESULT_GONE: &str = "result handle gone";

/// 値 1 つの概算バイト数 (enum 本体 + ヒープ上の文字列)。
pub fn approx_value_bytes(v: &Value) -> usize {
    let heap = match v {
        Value::String(s) | Value::Bytes(s) => s.len(),
        _ => 0,
    };
    std::mem::size_of::<Value>() + heap
}

/// 行 1 つの概算バイト数 (Vec 本体 + 各値)。
pub fn approx_row_bytes(row: &[Value]) -> usize {
    std::mem::size_of::<Vec<Value>>() + row.iter().map(approx_value_bytes).sum::<usize>()
}

/// ストリーム中に行を溜める。合計が `limit` を超えたら行を捨てて以後は何もしない。
#[derive(Debug)]
pub struct ResultBuilder {
    rows: Vec<Vec<Value>>,
    bytes: usize,
    limit: usize,
    overflow: bool,
}

impl ResultBuilder {
    pub fn new(limit: usize) -> Self {
        Self {
            rows: Vec::new(),
            bytes: 0,
            limit,
            overflow: false,
        }
    }

    /// バッチを複製して積む。上限を超えたらそれまでの行も解放する。
    pub fn push_batch(&mut self, batch: &[Vec<Value>]) {
        if self.overflow {
            return;
        }
        for row in batch {
            self.bytes = self.bytes.saturating_add(approx_row_bytes(row));
            if self.bytes > self.limit {
                self.overflow = true;
                self.rows = Vec::new();
                return;
            }
        }
        self.rows.extend_from_slice(batch);
    }

    /// 上限超過・`MIN_RETAIN_ROWS` 未満なら `None`。
    pub fn finish(self) -> Option<(Vec<Vec<Value>>, usize)> {
        if self.overflow || self.rows.len() < MIN_RETAIN_ROWS {
            None
        } else {
            Some((self.rows, self.bytes))
        }
    }
}

#[derive(Debug)]
struct Entry {
    session_id: String,
    col_count: usize,
    rows: Arc<Vec<Vec<Value>>>,
    bytes: usize,
    last_used: u64,
}

/// 取り出した結果。`Arc` なのでロックを離してから重い計算ができる。
#[derive(Debug, Clone)]
pub struct StoredResult {
    pub col_count: usize,
    pub rows: Arc<Vec<Vec<Value>>>,
}

#[derive(Debug)]
pub struct ResultStore {
    limit: usize,
    used: usize,
    tick: u64,
    entries: HashMap<String, Entry>,
}

impl Default for ResultStore {
    fn default() -> Self {
        Self::new(DEFAULT_RESULT_STORE_BYTES)
    }
}

impl ResultStore {
    pub fn new(limit: usize) -> Self {
        Self {
            limit,
            used: 0,
            tick: 0,
            entries: HashMap::new(),
        }
    }

    /// 合計メモリ上限 (バイト)。
    pub fn limit(&self) -> usize {
        self.limit
    }

    /// 現在保持している概算バイト数の合計。
    pub fn used_bytes(&self) -> usize {
        self.used
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    /// 結果を登録する。同じ `id` があれば置き換える。合計が上限を超えるなら LRU で古い
    /// ものを破棄して収め、1 つで上限を超えるなら登録せず `false`。
    pub fn insert(
        &mut self,
        id: String,
        session_id: String,
        col_count: usize,
        rows: Vec<Vec<Value>>,
        bytes: usize,
    ) -> bool {
        self.release(&id);
        if bytes > self.limit {
            return false;
        }
        while self.used.saturating_add(bytes) > self.limit {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.last_used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.release(&oldest);
        }
        self.tick += 1;
        self.used += bytes;
        self.entries.insert(
            id,
            Entry {
                session_id,
                col_count,
                rows: Arc::new(rows),
                bytes,
                last_used: self.tick,
            },
        );
        true
    }

    /// 取り出して LRU を更新する。無ければ `None`。
    pub fn get(&mut self, id: &str) -> Option<StoredResult> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(id).map(|e| {
            e.last_used = tick;
            StoredResult {
                col_count: e.col_count,
                rows: e.rows.clone(),
            }
        })
    }

    pub fn release(&mut self, id: &str) -> bool {
        match self.entries.remove(id) {
            Some(e) => {
                self.used = self.used.saturating_sub(e.bytes);
                true
            }
            None => false,
        }
    }

    /// セッション切断時: そのセッションの結果をすべて破棄する。
    pub fn release_session(&mut self, session_id: &str) -> usize {
        let ids: Vec<String> = self
            .entries
            .iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(k, _)| k.clone())
            .collect();
        for id in &ids {
            self.release(id);
        }
        ids.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(n: usize, width: usize) -> Vec<Vec<Value>> {
        (0..n)
            .map(|i| (0..width).map(|_| Value::Int(i as i64)).collect())
            .collect()
    }

    fn bytes_of(rows: &[Vec<Value>]) -> usize {
        rows.iter().map(|r| approx_row_bytes(r)).sum()
    }

    #[test]
    fn builder_keeps_large_results_and_drops_small_ones() {
        let mut b = ResultBuilder::new(usize::MAX);
        b.push_batch(&rows(MIN_RETAIN_ROWS, 2));
        let (kept, bytes) = b.finish().expect("retained");
        assert_eq!(kept.len(), MIN_RETAIN_ROWS);
        assert_eq!(bytes, bytes_of(&kept));

        let mut small = ResultBuilder::new(usize::MAX);
        small.push_batch(&rows(MIN_RETAIN_ROWS - 1, 2));
        assert!(small.finish().is_none());
    }

    #[test]
    fn builder_gives_up_once_the_limit_is_exceeded() {
        let batch = rows(MIN_RETAIN_ROWS, 2);
        let total = bytes_of(&batch);
        // 1 バッチ目は収まるが 2 バッチ目で超える。
        let mut b = ResultBuilder::new(total + total / 2);
        b.push_batch(&batch);
        b.push_batch(&batch);
        assert!(b.overflow);
        assert!(b.rows.is_empty(), "超過後は行を解放する");
        assert!(b.finish().is_none());
    }

    #[test]
    fn store_evicts_least_recently_used_to_stay_under_the_limit() {
        let r = rows(10, 1);
        let b = bytes_of(&r);
        let mut store = ResultStore::new(b * 2 + b / 2);
        assert!(store.insert("a".into(), "s".into(), 1, r.clone(), b));
        assert!(store.insert("b".into(), "s".into(), 1, r.clone(), b));
        // a を使って b を最古にする。
        assert!(store.get("a").is_some());
        assert!(store.insert("c".into(), "s".into(), 1, r.clone(), b));
        assert!(store.contains("a"));
        assert!(!store.contains("b"), "最も使われていない b が追い出される");
        assert!(store.contains("c"));
        assert!(store.used_bytes() <= store.limit());
        assert_eq!(store.len(), 2);
    }

    #[test]
    fn store_refuses_a_single_result_over_the_limit() {
        let r = rows(10, 1);
        let b = bytes_of(&r);
        let mut store = ResultStore::new(b - 1);
        assert!(!store.insert("a".into(), "s".into(), 1, r, b));
        assert!(store.is_empty());
        assert_eq!(store.used_bytes(), 0);
    }

    #[test]
    fn replacing_and_releasing_keep_the_byte_accounting_exact() {
        let r = rows(10, 1);
        let b = bytes_of(&r);
        let mut store = ResultStore::new(b * 10);
        store.insert("a".into(), "s1".into(), 1, r.clone(), b);
        store.insert("a".into(), "s1".into(), 1, r.clone(), b);
        assert_eq!(store.used_bytes(), b, "同じ id の置き換えで二重計上しない");
        store.insert("b".into(), "s2".into(), 1, r, b);
        assert_eq!(store.release_session("s1"), 1);
        assert!(!store.contains("a"));
        assert_eq!(store.used_bytes(), b);
        assert!(store.release("b"));
        assert!(!store.release("b"));
        assert_eq!(store.used_bytes(), 0);
    }
}
