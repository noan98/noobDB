/**
 * 開発用の軽量パフォーマンス計測 (#1094)。
 *
 * クエリ送信 → 最初の行を受信 (Time to First Row) → `query-stream:done` 受信 →
 * Result Grid のコミット (Time to Interactive 相当) までを、ブラウザ標準の
 * Performance API (`performance.mark` / `performance.measure`) を使って計測する。
 *
 * ## 設計方針
 *
 * - **既定で無効。** `localStorage.setItem("noobdb.perf.enabled", "1")` を実行して
 *   リロードしたときだけ計測する (devtools コンソールから手軽に切り替えられる)。
 *   本番ビルドでも常時オフ — 明示的に opt-in したセッションでしか計測しない。
 * - **計測 OFF 時のオーバーヘッドは `isPerfEnabled()` の 1 回のチェックのみ。**
 *   `performance.now()` / `mark` / `measure` はいずれも呼ばない。
 * - **SQL 本文・行/セルの実データは一切保持・ログしない。** 記録するのは
 *   経過時間・行数・列数のみ。
 * - Rust 側の `elapsed_ms` (SQL 実行 + デコード) をそのまま受け取って記録するだけで、
 *   フロント側で SQL を再実行したり追加の IPC を発行したりはしない。
 *
 * `App.tsx` / `ResultGrid.tsx` からはこのモジュールの数関数を呼ぶだけに留め、
 * 計測ロジック本体はここに閉じる (#1094 の競合回避方針)。
 */

const STORAGE_KEY = "noobdb.perf.enabled";
const RECENT_LIMIT = 50;
/** この時間 (ms) を超えて `markQueryDone` すら来ない計測はゾンビとみなして捨てる
 * (エラー終了やタブ破棄で `markGridCommit` が呼ばれないケースのメモリリーク防止)。 */
const STALE_MS = 60_000;

/** 1 クエリぶんの計測結果。SQL 本文・行/セルの値は含まない。 */
export interface QueryPerfMetric {
  streamId: string;
  /** クエリ開始時刻 (`Date.now()`)。個人情報ではないが、時系列に並べるためのもの。 */
  startedAt: number;
  /** クエリ開始 → 最初の行バッチ受信までの時間 (ms)。行が 0 件などで一度も
   * `markFirstRow` が呼ばれなかった場合は `null`。 */
  ttfrMs: number | null;
  /** クエリ開始 → `query-stream:done` 受信までの時間 (ms、フロント視点)。 */
  totalMs: number;
  /** バックエンドが報告した `elapsed_ms` (SQL 実行 + Rust 側デコード)。
   * `totalMs` との差がおおよそ IPC 転送 + フロント処理のオーバーヘッド。 */
  backendElapsedMs: number;
  /** `query-stream:done` 受信 → Result Grid のコミットまでの時間 (ms)。 */
  gridCommitMs: number;
  /** クエリ開始 → Result Grid のコミットまでの合計時間 (ms、Time to Interactive 相当)。 */
  ttiMs: number;
  rows: number;
  columns: number;
}

interface InFlightQuery {
  streamId: string;
  startPerfNow: number;
  startedAtEpochMs: number;
  firstRowPerfNow: number | null;
  donePerfNow: number | null;
  backendElapsedMs: number | null;
  rows: number | null;
  columns: number | null;
}

const inFlight = new Map<string, InFlightQuery>();
/** `markGridCommit` がどのクエリに対応するか分からない (ResultGrid はどの
 * streamId のクエリを描画しているか知らない) ため、直近で `markQueryDone` された
 * streamId を「グリッドコミット待ち」として憶えておく。複数タブを高速に切り替える
 * ような稀なケースでは取り違えうるが、開発用のベースライン計測としては十分。 */
let pendingGridCommitStreamId: string | null = null;
const recentMetrics: QueryPerfMetric[] = [];

function readStorageFlag(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // プライベートウィンドウ等で localStorage が例外を投げる環境がある。
    return false;
  }
}

/** 計測が有効かどうか。呼び出しごとに `localStorage` を読むが、呼び出し箇所は
 * クエリ 1 回につき数回 (行ごとではない) なのでホットパスへの影響はない。
 * @public テストから直接検証するためエクスポートしている。 */
export function isPerfEnabled(): boolean {
  return readStorageFlag();
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function markName(streamId: string, phase: string): string {
  return `noobdb:query:${streamId}:${phase}`;
}

function safeMark(name: string): void {
  try {
    performance.mark?.(name);
  } catch {
    // 一部の埋め込み WebView / テスト環境では mark が使えないことがある。
    // 計測が 1 件欠けるだけで機能には影響しないため黙って無視する。
  }
}

function safeMeasure(name: string, startMark: string, endMark: string): void {
  try {
    performance.measure?.(name, startMark, endMark);
  } catch {
    // 対応する mark が無い等 (mark 自体が safeMark で失敗した場合を含む)。
  }
}

function pruneStale(nowPerf: number): void {
  for (const [id, entry] of inFlight) {
    if (nowPerf - entry.startPerfNow > STALE_MS) inFlight.delete(id);
  }
}

/** クエリ送信直後 (IPC 発行前後) に 1 回呼ぶ。`streamId` はクエリ実行ごとに
 * ユニークな既存の ID (`newStreamId` で生成済みのもの) を使う。 */
export function markQueryStart(streamId: string): void {
  if (!isPerfEnabled()) return;
  const startPerfNow = nowMs();
  pruneStale(startPerfNow);
  inFlight.set(streamId, {
    streamId,
    startPerfNow,
    startedAtEpochMs: Date.now(),
    firstRowPerfNow: null,
    donePerfNow: null,
    backendElapsedMs: null,
    rows: null,
    columns: null,
  });
  safeMark(markName(streamId, "start"));
}

/** 最初の行バッチを受信したタイミングで呼ぶ (Time to First Row)。同じ
 * `streamId` に対して 2 回目以降の呼び出しは無視される。 */
export function markFirstRow(streamId: string): void {
  if (!isPerfEnabled()) return;
  const entry = inFlight.get(streamId);
  if (!entry || entry.firstRowPerfNow !== null) return;
  entry.firstRowPerfNow = nowMs();
  safeMark(markName(streamId, "first-row"));
  safeMeasure(markName(streamId, "ttfr"), markName(streamId, "start"), markName(streamId, "first-row"));
}

/** `query-stream:done` (または非ストリーミング応答) を受信したタイミングで呼ぶ。
 * `elapsedMs` はバックエンドが返した `elapsed_ms` (SQL 実行 + デコード時間)。 */
export function markQueryDone(
  streamId: string,
  info: { rows: number; columns: number; elapsedMs: number },
): void {
  if (!isPerfEnabled()) return;
  const entry = inFlight.get(streamId);
  if (!entry) return;
  entry.donePerfNow = nowMs();
  entry.backendElapsedMs = info.elapsedMs;
  entry.rows = info.rows;
  entry.columns = info.columns;
  safeMark(markName(streamId, "done"));
  safeMeasure(markName(streamId, "total"), markName(streamId, "start"), markName(streamId, "done"));
  pendingGridCommitStreamId = streamId;
}

/** Result Grid が新しい結果セットをコミット (描画) したタイミングで呼ぶ。
 * どの `streamId` のクエリに対応するかは `markQueryDone` が最後に設定した
 * ものを使う (ResultGrid はクエリの streamId を知らないため)。件数以外の
 * 行データは受け取らない。 */
export function markGridCommit(rowCount: number): void {
  if (!isPerfEnabled()) return;
  const streamId = pendingGridCommitStreamId;
  if (!streamId) return;
  const entry = inFlight.get(streamId);
  if (!entry || entry.donePerfNow === null) return;
  // 同じクエリに対する 2 回目以降のコミット (再レンダー) は集計対象にしない。
  inFlight.delete(streamId);
  pendingGridCommitStreamId = null;

  const gridPerfNow = nowMs();
  safeMark(markName(streamId, "grid-commit"));
  safeMeasure(markName(streamId, "grid-render"), markName(streamId, "done"), markName(streamId, "grid-commit"));
  safeMeasure(markName(streamId, "tti"), markName(streamId, "start"), markName(streamId, "grid-commit"));

  const metric: QueryPerfMetric = {
    streamId,
    startedAt: entry.startedAtEpochMs,
    ttfrMs: entry.firstRowPerfNow !== null ? entry.firstRowPerfNow - entry.startPerfNow : null,
    totalMs: entry.donePerfNow - entry.startPerfNow,
    backendElapsedMs: entry.backendElapsedMs ?? 0,
    gridCommitMs: gridPerfNow - entry.donePerfNow,
    ttiMs: gridPerfNow - entry.startPerfNow,
    rows: rowCount,
    columns: entry.columns ?? 0,
  };
  recentMetrics.push(metric);
  if (recentMetrics.length > RECENT_LIMIT) recentMetrics.shift();
  // SQL 本文・セルデータは含まない (件数と経過時間のみ)。
  // eslint-disable-next-line no-console
  console.debug("[noobdb:perf]", metric);
}

/** 直近の計測結果 (最大 `RECENT_LIMIT` 件) のスナップショット。ベースライン記録の
 * 手動確認や、将来のデバッグ用オーバーレイから読む用途を想定している。
 * @public テストから直接検証するためエクスポートしている。 */
export function getRecentMetrics(): readonly QueryPerfMetric[] {
  return recentMetrics.slice();
}

/** テスト・手動リセット用。進行中の計測と直近ログを両方クリアする。
 * @public テストから直接呼ぶためエクスポートしている。 */
export function clearPerfState(): void {
  inFlight.clear();
  pendingGridCommitStreamId = null;
  recentMetrics.length = 0;
}
