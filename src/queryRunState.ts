/**
 * クエリ実行のローディング状態 (#657) が共有する純ロジック。副作用なし
 * (DOM / タイマー / Tauri に触れない) なので Vitest で単体テストできる。App の
 * ストリーミング購読が抱える個別フラグ (`streaming` / `queryError` /
 * `partialResult` など) を、離散的な実行フェーズ (idle / connecting / streaming /
 * done / error / canceled) に集約し、UI 側 (バナー・Motion) がフェーズ 1 つで
 * 分岐できるようにする。経過時間の mm:ss 整形と受信行数の積算もここに置く。
 */

/**
 * クエリ実行の離散フェーズ。同時にはどれか 1 つ。
 * - `idle`: 未実行 (結果なし)。
 * - `connecting`: 接続確立中 (最初のイベント到着前)。
 * - `streaming`: 実行中／行が流入している。
 * - `done`: 正常終了して結果がある。
 * - `error`: 失敗した。
 * - `canceled`: キャンセル／タイムアウトで打ち切られた (部分結果を含みうる)。
 */
export type QueryPhase = "idle" | "connecting" | "streaming" | "done" | "error" | "canceled";

export interface QueryPhaseInput {
  /** 接続確立中 (ストリーム開始前)。 */
  connecting?: boolean;
  /** ストリーミング実行中。 */
  streaming?: boolean;
  /** 直近の実行がエラーで終わった。 */
  error?: boolean;
  /** キャンセル／タイムアウトで打ち切られた (部分結果あり)。 */
  canceled?: boolean;
  /** 表示できる結果を保持している。 */
  hasResult?: boolean;
}

/**
 * 個別フラグから実行フェーズを導出する。優先順位は
 * error > connecting > streaming > canceled > done > idle。
 * エラーは古い結果が残っていても最優先で示し (ユーザが読んでいる失敗を隠さない)、
 * 実行中 (connecting/streaming) はその次、打ち切り (canceled) は結果の有無に
 * 関わらず done より優先して「途中で止まった」ことを示す。
 */
export function deriveQueryPhase(input: QueryPhaseInput): QueryPhase {
  if (input.error) return "error";
  if (input.connecting) return "connecting";
  if (input.streaming) return "streaming";
  if (input.canceled) return "canceled";
  if (input.hasResult) return "done";
  return "idle";
}

/**
 * 経過ミリ秒を `mm:ss` (1 時間以上は `h:mm:ss`) に整形する。負値・NaN は
 * `00:00` に丸める。ライブな経過時間表示 (00:01, 00:02…) に使う。
 */
export function formatElapsed(ms: number): string {
  const totalSec = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * 受信済み行数にバッチ長を積算する。負値は 0 として扱い、常に非負を返す。
 * ストリーミングの各バッチ到着時に累計行数を更新するのに使う。
 */
export function accumulateRowCount(previous: number, batchLength: number): number {
  const prev = Number.isFinite(previous) ? Math.max(0, previous) : 0;
  const add = Number.isFinite(batchLength) ? Math.max(0, batchLength) : 0;
  return prev + add;
}
