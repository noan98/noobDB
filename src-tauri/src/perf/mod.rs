//! 開発用の軽量パフォーマンス計測基盤 (#1094)。
//!
//! SQL 実行 → Rust 側の結果整形 (デコード) → IPC (`emit`) の各区間を計測し、
//! `tracing` の `noobdb::perf` ターゲットへ 1 行の構造化ログとして出す。
//!
//! ## 設計方針
//!
//! - **既定は無効。** `NOOBDB_PERF_LOG=1` (または `true`、大文字小文字を無視) が
//!   設定されているか、設定画面のトグル (#1622、[`set_ui_enabled`]) が ON のときだけ
//!   計測する。本番ログに計測情報を常時出さない、という Issue #1094 の実装方針そのもの。
//!   環境変数はパッケージ版では使えないので、画面から切り替えられるようにした。
//!   直近の計測値は [`recent_samples`] で取り出して診断タブに表示する (メモリ上のみ・
//!   最大 [`RECENT_SAMPLE_CAPACITY`] 件)。
//! - **計測 OFF 時のオーバーヘッドは真偽値 1 回の読み取りのみ。** [`Span::start`]
//!   は無効時に `Instant::now()` すら呼ばない。[`StreamAccumulator::record_emit`]
//!   も同様に、無効時は渡されたクロージャをそのまま実行するだけで計測コストを
//!   足さない。
//! - **SQL 本文・行/セルのデータは一切ログに含めない。** 記録するのは経過時間・
//!   行数・列数・ペイロードサイズの「概算」のみ (実サイズを得るには二重に
//!   シリアライズする必要がありコストが見合わないため、値の個数からの粗い係数
//!   見積もりに留める — 傾向を掴むためのものであり正確なワイヤサイズではない)。
//! - 既存の呼び出し元 (`commands/query.rs`) への変更はこのモジュールの関数を
//!   数行差し込むだけに留め、実行ロジック自体は変更しない。
//!
//! 代表データセットでのベースライン測定のケース定義とハーネスは [`bench`]
//! サブモジュール (テストからのみ実行) を参照。

pub mod bench;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::db::types::Column;
use crate::db::types::Value;

/// `NOOBDB_PERF_LOG` の値を解釈する。env アクセスから切り離した純関数にして
/// あるのはテストで環境変数を実際に書き換えず (並列テストでの汚染を避けるため)
/// 判定ロジックだけを固定するため。
fn parse_enabled(raw: Option<&str>) -> bool {
    matches!(raw, Some(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

/// 環境変数 `NOOBDB_PERF_LOG` による有効化。起動後は変わらない前提で一度だけ判定して
/// キャッシュする — 呼び出しのたびに `env::var` を読むとホットパス
/// (行バッチの emit 毎など) で無視できないコストになるため。
pub fn env_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| parse_enabled(std::env::var("NOOBDB_PERF_LOG").ok().as_deref()))
}

/// 設定画面のトグルによる有効化 (#1622)。実行中に切り替えられるよう `AtomicBool`。
static UI_ENABLED: AtomicBool = AtomicBool::new(false);

/// 設定画面のトグルを反映する。環境変数が有効なら、これを OFF にしても計測は止まらない
/// (開発者の `NOOBDB_PERF_LOG=1` を設定が上書きしない)。
pub fn set_ui_enabled(enabled: bool) {
    UI_ENABLED.store(enabled, Ordering::Relaxed);
}

/// 画面のトグルの現在値 (環境変数は含まない)。
pub fn ui_enabled() -> bool {
    UI_ENABLED.load(Ordering::Relaxed)
}

/// 計測が有効かどうか (環境変数 または 設定のトグル)。ホットパスから呼ばれるので
/// 環境変数はキャッシュ済みの値、トグルは緩い順序の原子読み取りだけで済ませる。
pub fn perf_enabled() -> bool {
    env_enabled() || UI_ENABLED.load(Ordering::Relaxed)
}

/// 診断タブに出す直近の計測値の最大件数。
pub const RECENT_SAMPLE_CAPACITY: usize = 20;

/// 計測値 1 件 (#1622)。SQL 本文・行データ・接続先は含めない — 経過時間・件数・
/// 概算サイズだけ。フィールド名は構造化ログと揃える。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PerfSample {
    /// 記録時刻 (Unix ミリ秒)。
    pub at_ms: u64,
    /// `"query"` (非ストリーミング実行) / `"stream"` (ストリーミング実行)。
    pub kind: &'static str,
    /// SQL 実行 (+ ドライバ内の行デコード) の所要ミリ秒。
    pub sql_execute_ms: Option<f64>,
    /// emit (シリアライズ + IPC) の積算ミリ秒。ストリーミングのみ。
    pub emit_ms: Option<f64>,
    /// 概算ペイロードバイト数。ストリーミングのみ。
    pub payload_bytes_approx: Option<u64>,
    pub rows: u64,
    pub columns: u64,
}

/// 直近の計測値を固定長で保持するリング。古いものから捨てる。
#[derive(Debug)]
struct SampleRing {
    cap: usize,
    items: VecDeque<PerfSample>,
}

impl SampleRing {
    fn new(cap: usize) -> Self {
        Self {
            cap: cap.max(1),
            items: VecDeque::new(),
        }
    }

    fn push(&mut self, sample: PerfSample) {
        if self.items.len() >= self.cap {
            self.items.pop_front();
        }
        self.items.push_back(sample);
    }

    /// 新しい順。
    fn newest_first(&self) -> Vec<PerfSample> {
        self.items.iter().rev().cloned().collect()
    }

    fn clear(&mut self) {
        self.items.clear();
    }
}

fn ring() -> &'static Mutex<SampleRing> {
    static RING: OnceLock<Mutex<SampleRing>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(SampleRing::new(RECENT_SAMPLE_CAPACITY)))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

fn record_sample(sample: PerfSample) {
    // 他スレッドが panic して毒化していても、計測値の記録は続ける。
    let mut guard = ring().lock().unwrap_or_else(|e| e.into_inner());
    guard.push(sample);
}

/// 直近の計測値 (新しい順)。
pub fn recent_samples() -> Vec<PerfSample> {
    ring()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .newest_first()
}

/// 保持している計測値を捨てる。
pub fn clear_samples() {
    ring().lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// 1 区間の計測。計測 OFF のときは中身が `None` になり、`Instant::now()` を
/// 一切呼ばない。
pub struct Span(Option<Instant>);

impl Span {
    /// 区間の計測を開始する。計測 OFF なら実質 no-op (真偽値 1 回の読み取りのみ)。
    pub fn start() -> Self {
        Span(perf_enabled().then(Instant::now))
    }

    /// 開始からの経過ミリ秒。計測 OFF のとき、または未開始のときは `None`。
    pub fn elapsed_ms(&self) -> Option<f64> {
        self.0.map(|t| t.elapsed().as_secs_f64() * 1000.0)
    }
}

/// ストリーミング実行 1 回 (`run_query_stream`) 分の集計値。SQL 本文・行データは
/// 一切保持しない — `emit` 呼び出しの所要時間・回数と、行/列データから概算した
/// ペイロードサイズのみを `AtomicU64` に積算する (ストリーミングのコールバックは
/// `FnMut` で複数回呼ばれるため)。
#[derive(Debug, Default)]
pub struct StreamAccumulator {
    emit_nanos: AtomicU64,
    emit_calls: AtomicU64,
    payload_bytes_approx: AtomicU64,
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// `app.emit(...)` 呼び出し 1 回分を計測しつつ実行する。計測 OFF のときは
    /// `Instant::now()` を呼ばず、渡されたクロージャをそのまま実行して結果を
    /// 返すだけ (オーバーヘッドを増やさない)。`approx_bytes` はこのバッチの
    /// 概算ペイロードサイズ (呼び出し元が [`approx_columns_bytes`] /
    /// [`approx_rows_bytes`] で算出する)。
    pub fn record_emit<T>(&self, approx_bytes: u64, f: impl FnOnce() -> T) -> T {
        if !perf_enabled() {
            return f();
        }
        let started = Instant::now();
        let result = f();
        let nanos = started.elapsed().as_nanos() as u64;
        self.emit_nanos.fetch_add(nanos, Ordering::Relaxed);
        self.emit_calls.fetch_add(1, Ordering::Relaxed);
        self.payload_bytes_approx
            .fetch_add(approx_bytes, Ordering::Relaxed);
        result
    }

    /// 積算された emit 所要時間 (ミリ秒)。シリアライズ + IPC ディスパッチの
    /// 概算 ("Rust 側の整形" 完了後、フロントに届くまでの区間)。
    pub fn emit_ms(&self) -> f64 {
        self.emit_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    pub fn emit_calls(&self) -> u64 {
        self.emit_calls.load(Ordering::Relaxed)
    }

    /// 概算ペイロードバイト数の合計 (実シリアライズ結果ではなく粗い見積もり)。
    pub fn payload_bytes_approx(&self) -> u64 {
        self.payload_bytes_approx.load(Ordering::Relaxed)
    }
}

/// 列メタデータ 1 バッチの概算バイト数。列名 + 型名の文字列長に JSON の
/// キー/区切り文字のオーバーヘッド分として列あたり固定 24 バイトを足した粗い
/// 見積もり。
pub fn approx_columns_bytes(columns: &[Column]) -> u64 {
    columns
        .iter()
        .map(|c| (c.name.len() + c.type_name.len() + 24) as u64)
        .sum()
}

/// 行データ 1 バッチの概算バイト数。値 1 個あたり平均 12 バイト程度という
/// 粗い係数で見積もる (数値・短い文字列が混在する結果セットを念頭にした概算)。
/// 実際のシリアライズは行わない — 正確なワイヤサイズではなく、クエリ間の相対的な
/// 重さを比較するためのシグナル。
pub fn approx_rows_bytes(rows: &[Vec<Value>]) -> u64 {
    let value_count: u64 = rows.iter().map(|r| r.len() as u64).sum();
    value_count * 12
}

/// 非ストリーミング実行 (`run_query` / `run_query_transaction` 等) の計測ログを
/// 1 行出す。計測 OFF なら何もしない。SQL 本文は含めない。
pub fn log_query_execute(
    session_id: &str,
    sql_execute_ms: Option<f64>,
    rows: usize,
    columns: usize,
) {
    if !perf_enabled() {
        return;
    }
    record_sample(PerfSample {
        at_ms: now_ms(),
        kind: "query",
        sql_execute_ms,
        emit_ms: None,
        payload_bytes_approx: None,
        rows: rows as u64,
        columns: columns as u64,
    });
    tracing::debug!(
        target: "noobdb::perf",
        session_id = %session_id,
        phase = "sql_execute",
        sql_execute_ms,
        rows,
        columns,
        "perf: run_query"
    );
}

/// ストリーミング実行 (`run_query_stream`) の計測ログを 1 行出す。計測 OFF なら
/// 何もしない。SQL 本文・行データは含めない。
///
/// - `sql_execute_ms`: 既存の `QueryResult.elapsed_ms` (SQL 実行 + Rust 側の
///   行デコードを合わせた時間。ドライバ内部で計測済みの値をそのまま転記する —
///   5 ドライバ全てに新たな計測点を追加すると変更範囲が広がるため、既存の値を
///   再利用する形にとどめた)。
/// - `emit_ms` / `emit_calls` / `payload_bytes_approx`: [`StreamAccumulator`]
///   が集計した、シリアライズ + IPC emit の概算値。
#[allow(clippy::too_many_arguments)]
pub fn log_query_stream(
    session_id: &str,
    stream_id: &str,
    sql_execute_ms: u64,
    emit_ms: f64,
    emit_calls: u64,
    payload_bytes_approx: u64,
    rows: u64,
    columns: usize,
) {
    if !perf_enabled() {
        return;
    }
    record_sample(PerfSample {
        at_ms: now_ms(),
        kind: "stream",
        sql_execute_ms: Some(sql_execute_ms as f64),
        emit_ms: Some(emit_ms),
        payload_bytes_approx: Some(payload_bytes_approx),
        rows,
        columns: columns as u64,
    });
    tracing::debug!(
        target: "noobdb::perf",
        session_id = %session_id,
        stream_id = %stream_id,
        phase = "query_stream",
        sql_execute_ms,
        emit_ms,
        emit_calls,
        payload_bytes_approx,
        rows,
        columns,
        "perf: run_query_stream"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_enabled_accepts_1_and_true_case_insensitively() {
        assert!(parse_enabled(Some("1")));
        assert!(parse_enabled(Some("true")));
        assert!(parse_enabled(Some("TRUE")));
        assert!(parse_enabled(Some("True")));
    }

    #[test]
    fn parse_enabled_rejects_everything_else() {
        assert!(!parse_enabled(None));
        assert!(!parse_enabled(Some("")));
        assert!(!parse_enabled(Some("0")));
        assert!(!parse_enabled(Some("false")));
        assert!(!parse_enabled(Some("yes")));
    }

    #[test]
    fn span_elapsed_ms_is_none_when_perf_logging_is_disabled() {
        // CI / 通常の開発環境では NOOBDB_PERF_LOG は未設定 (計測 OFF) を前提とする。
        // 手元で明示的に有効化しているセッションではこのテストの前提が崩れるため
        // スキップする (env を書き換えて他の並列テストを汚染したくない)。
        if std::env::var("NOOBDB_PERF_LOG").is_ok() {
            return;
        }
        let span = Span::start();
        assert!(span.elapsed_ms().is_none());
    }

    #[test]
    fn record_emit_always_runs_the_closure_and_returns_its_value() {
        let acc = StreamAccumulator::new();
        let mut called = false;
        let value = acc.record_emit(123, || {
            called = true;
            42
        });
        assert!(called);
        assert_eq!(value, 42);
        // 計測 OFF (既定) では積算値も増えない。
        if !perf_enabled() {
            assert_eq!(acc.emit_calls(), 0);
            assert_eq!(acc.payload_bytes_approx(), 0);
        }
    }

    #[test]
    fn approx_columns_bytes_scales_with_column_count() {
        let one = vec![Column {
            name: "id".into(),
            type_name: "INTEGER".into(),
        }];
        let two = vec![
            Column {
                name: "id".into(),
                type_name: "INTEGER".into(),
            },
            Column {
                name: "name".into(),
                type_name: "TEXT".into(),
            },
        ];
        assert!(approx_columns_bytes(&one) > 0);
        assert!(approx_columns_bytes(&two) > approx_columns_bytes(&one));
        assert_eq!(approx_columns_bytes(&[]), 0);
    }

    #[test]
    fn approx_rows_bytes_scales_with_value_count() {
        let rows = vec![
            vec![Value::Int(1), Value::Null],
            vec![Value::Int(2), Value::Null],
        ];
        assert_eq!(approx_rows_bytes(&rows), 4 * 12);
        assert_eq!(approx_rows_bytes(&[]), 0);
    }

    fn sample(rows: u64) -> PerfSample {
        PerfSample {
            at_ms: rows,
            kind: "query",
            sql_execute_ms: Some(1.0),
            emit_ms: None,
            payload_bytes_approx: None,
            rows,
            columns: 1,
        }
    }

    #[test]
    fn sample_ring_keeps_only_the_newest_samples_newest_first() {
        let mut ring = SampleRing::new(3);
        for n in 1..=5 {
            ring.push(sample(n));
        }
        let got: Vec<u64> = ring.newest_first().iter().map(|s| s.rows).collect();
        assert_eq!(got, vec![5, 4, 3]);
        ring.clear();
        assert!(ring.newest_first().is_empty());
    }

    #[test]
    fn sample_ring_capacity_is_at_least_one() {
        let mut ring = SampleRing::new(0);
        ring.push(sample(1));
        ring.push(sample(2));
        assert_eq!(ring.newest_first().len(), 1);
        assert_eq!(ring.newest_first()[0].rows, 2);
    }

    #[test]
    fn sample_serializes_without_any_sql_or_row_data_fields() {
        let json = serde_json::to_value(sample(7)).expect("serialize");
        let keys: Vec<&str> = json
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        for k in [
            "at_ms",
            "kind",
            "sql_execute_ms",
            "emit_ms",
            "payload_bytes_approx",
            "rows",
            "columns",
        ] {
            assert!(keys.contains(&k), "missing {k}");
        }
        assert_eq!(keys.len(), 7, "{keys:?}");
    }
}
