/**
 * 接続ドロップからの自動再接続の純ロジック (#600)。
 *
 * 実際の再接続 (バックエンドへの `connect` 呼び出し・SSH トンネル張り直し) は
 * `App.tsx` のオーケストレータが行うが、「いつ再接続を試みるか」「リトライ間隔を
 * どう伸ばすか」という判断はここに副作用なしで切り出し、`reconnect.test.ts` で
 * 単体テストできるようにする。バックオフ schedule とガード判定をここで一元管理する
 * ことで、UI からタイミング依存のロジックを排除する。
 */

/**
 * ライブ接続の状態。`connected` は通常稼働、`reconnecting` は自動再接続ループの
 * 実行中 (この間クエリは明示エラーにする)、`disconnected` はリトライ上限に達して
 * 復旧を諦めた状態 (手動再接続 UI に切り替える)。
 */
export type ConnectionStatus = "connected" | "reconnecting" | "disconnected";

/** 最初のリトライまでの待機 (ms)。以降は 2 倍ずつ伸ばし `MAX` で頭打ちにする。 */
export const RECONNECT_BASE_DELAY_MS = 1_000;
/** バックオフの上限 (ms)。サーバ復旧待ちでも待ち時間が際限なく伸びないようにする。 */
export const RECONNECT_MAX_DELAY_MS = 30_000;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/**
 * リトライ `attempt` 回目 (0 始まり) の待機時間 (ms) を指数バックオフで返す。
 * `base * 2**attempt` を `max` で頭打ちにする。負の `attempt` は 0 として扱い、
 * 常に `base..=max` の範囲に収める。ジッタは加えず決定的にして、呼び出し側
 * (とテスト) が schedule を予測できるようにする。
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? RECONNECT_BASE_DELAY_MS;
  const max = opts.maxMs ?? RECONNECT_MAX_DELAY_MS;
  const n = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  // 2**n は n が大きいと Infinity になりうるので、先に max で頭打ちにしてから比較。
  const scaled = n >= 31 ? Number.POSITIVE_INFINITY : base * 2 ** n;
  return Math.min(max, scaled);
}

/**
 * 与えた最大リトライ回数ぶんの待機時間 (ms) の配列。プレビュー表示やテストで
 * バックオフの形を一覧するために使う。`maxRetries <= 0` なら空配列。
 */
export function reconnectSchedule(maxRetries: number, opts: BackoffOptions = {}): number[] {
  const count = Number.isFinite(maxRetries) && maxRetries > 0 ? Math.floor(maxRetries) : 0;
  return Array.from({ length: count }, (_, i) => backoffDelayMs(i, opts));
}

export interface ShouldReconnectInput {
  /** 設定で自動再接続が有効か。 */
  enabled: boolean;
  /** 明示トランザクションの実行中か。中断時は暗黙コミット/不整合を避けるため再接続しない。 */
  inTransaction: boolean;
  /** これから行うリトライの試行回数 (0 始まり)。 */
  attempt: number;
  /** 設定上の最大リトライ回数。 */
  maxRetries: number;
}

/**
 * いま自動再接続を開始/継続してよいかを判定する。設定で有効かつトランザクション
 * 中でなく、まだリトライ上限に達していないときだけ `true`。トランザクション中の
 * 断はここで明確に弾き、呼び出し側は明示エラーへ倒す (受け入れ条件)。
 */
export function shouldAutoReconnect(input: ShouldReconnectInput): boolean {
  const { enabled, inTransaction, attempt, maxRetries } = input;
  if (!enabled || inTransaction) return false;
  if (!Number.isFinite(attempt) || !Number.isFinite(maxRetries)) return false;
  return attempt >= 0 && attempt < maxRetries;
}
