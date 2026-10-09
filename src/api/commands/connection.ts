// `src-tauri/src/commands/connection.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ConnectRequest, HealthProbeItem } from "../tauri";

export const connectionCommands = {
  /**
   * Test a connection. `attemptId` (a fresh id per attempt) lets the caller
   * subscribe to `connect-progress:phase` events and cancel via `cancelConnect`;
   * `timeoutSecs` bounds the whole attempt (backend clamps + defaults). #684.
   */
  testConnection: (req: ConnectRequest, attemptId?: string, timeoutSecs?: number) =>
    invoke<string>("test_connection", {
      req,
      attemptId: attemptId ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.stringResponse, r, "test_connection")),
  connect: (req: ConnectRequest, attemptId?: string, timeoutSecs?: number) =>
    invoke<{ session_id: string }>("connect", {
      req,
      attemptId: attemptId ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.connectResult, r, "connect")),
  /** Cancel an in-flight connect / test-connection attempt by its id (#684). */
  cancelConnect: (attemptId: string) =>
    invoke<boolean>("cancel_connect", { attemptId }),
  disconnect: (sessionId: string) =>
    invoke<void>("disconnect", { sessionId }),
  /**
   * 切断されたセッションをその場で張り直す (#712)。同じ `sessionId` のまま SSH
   * トンネルを再構築し、`connect_options` から新しい接続を確立してセッションを
   * 差し替える。id が変わらないため、開いているタブ・グリッド状態はそのまま生きる。
   * 失敗時は旧セッションを壊さずに reject する。
   */
  reconnect: (sessionId: string) => invoke<void>("reconnect", { sessionId }),
  /**
   * 接続のヘルスチェック。生きていれば true、死んでいれば (スリープ復帰や
   * トンネル断) false。セッションが見つからない場合のみ reject する。
   */
  pingSession: (sessionId: string) => invoke<boolean>("ping_session", { sessionId }),
  /**
   * 接続ヘルスダッシュボード (#1068 / #1259) 用に、全セッションの生死・往復レイテンシ・
   * バージョン・接続数を 1 回の IPC でまとめて取得する。Rust 側が並列に問い合わせ、
   * 各セッションを `timeoutMs` で打ち切る (問い合わせ自体も止まる)。バージョンは
   * セッション単位でキャッシュされ、`refreshVersion` で取り直す。読み取り専用。
   */
  healthProbeAll: (sessionIds: string[], timeoutMs: number, refreshVersion = false) =>
    invoke<HealthProbeItem[]>("health_probe_all", { sessionIds, timeoutMs, refreshVersion }).then(
      (r) => parseResponse(schemas.healthProbeItemArray, r, "health_probe_all"),
    ),
};
