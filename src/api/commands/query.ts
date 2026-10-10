// `src-tauri/src/commands/query.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import { queryStreamChannels, previewStreamChannels } from "../streamChannels";
import type { TxIsolation } from "../../txOptions";
import type { QueryResult, CancelStreamResult } from "../tauri";

export const queryCommands = {
  /** 明示トランザクションを開始する。`options` は分離レベル / READ ONLY (MySQL / PostgreSQL のみ、省略でサーバ既定, #1166)。 */
  beginTransaction: (
    sessionId: string,
    database?: string | null,
    options?: { isolation?: TxIsolation | null; readOnly?: boolean },
  ) =>
    invoke<void>("begin_transaction", {
      sessionId,
      database: database ?? null,
      isolation: options?.isolation ?? null,
      readOnly: options?.readOnly ?? null,
    }),
  /** 明示トランザクション内で 1 文を実行する。 */
  runInTransaction: (sessionId: string, sql: string) =>
    invoke<QueryResult>("run_in_transaction", { sessionId, sql }).then((r) =>
      parseResponse(schemas.queryResultLite, r, "run_in_transaction"),
    ),
  /** 明示トランザクションを確定 (commit=true) / 破棄 (false) する。 */
  finishTransaction: (sessionId: string, commit: boolean) =>
    invoke<void>("finish_transaction", { sessionId, commit }),

  // 明示トランザクション内の SAVEPOINT (#1418)。名前は英数字と _ のみ。
  createSavepoint: (sessionId: string, name: string) =>
    invoke<void>("create_savepoint", { sessionId, name }),

  rollbackToSavepoint: (sessionId: string, name: string) =>
    invoke<void>("rollback_to_savepoint", { sessionId, name }),

  releaseSavepoint: (sessionId: string, name: string) =>
    invoke<void>("release_savepoint", { sessionId, name }),
  /**
   * 読み取り専用セッションの「緊急クエリ実行モード」を切り替える。有効な間は
   * バックエンドの read-only ガードが SQL 実行経路 (run_query / トランザクション /
   * ストリーミング) に限り書き込み文を通す。CSV インポート・同期適用・KILL の
   * read-only 拒否は変わらない。有効化の合意 (接続先名のタイプ確認) はフロントの
   * ダイアログが担う UI レベルの安全網で、フラグは切断・再接続で必ずオフに戻る。
   * 読み書き可能なセッションでの有効化は InvalidInput で reject される。
   */
  setEmergencyMode: (sessionId: string, enabled: boolean) =>
    invoke<void>("set_emergency_mode", { sessionId, enabled }),

  runQuery: (sessionId: string, sql: string, database?: string | null) =>
    invoke<QueryResult>("run_query", {
      sessionId,
      sql,
      database: database ?? null,
    }).then((r) => parseResponse(schemas.queryResultLite, r, "run_query")),
  /**
   * スマート値ピッカー (#1067) の候補取得。FK 参照先の DISTINCT 値や ENUM /
   * CHECK 許可値を引く裏方クエリで、バックエンドがセッションの read_only に
   * 関係なく読み取り専用の文だけを通し、`rowCap` 件 (上限 1000) で打ち切り、
   * `queryTimeoutSecs` (0 / null はタイムアウトなし) で全体を中断する。
   * クエリ履歴・結果キャッシュには載らない。
   */
  runLookupQuery: (params: {
    sessionId: string;
    sql: string;
    database?: string | null;
    queryTimeoutSecs?: number | null;
    rowCap?: number | null;
  }) =>
    invoke<QueryResult>("run_lookup_query", {
      sessionId: params.sessionId,
      sql: params.sql,
      database: params.database ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
      rowCap: params.rowCap ?? null,
    }).then((r) => parseResponse(schemas.queryResultLite, r, "run_lookup_query")),
  runQueryTransaction: (
    sessionId: string,
    statements: string[],
    database?: string | null,
  ) =>
    invoke<QueryResult>("run_query_transaction", {
      sessionId,
      statements,
      database: database ?? null,
    }).then((r) => parseResponse(schemas.queryResultLite, r, "run_query_transaction")),
  runQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database?: string | null;
    initialBatch: number;
    chunkSize: number;
    autoLimit?: number | null;
    queryTimeoutSecs?: number | null;
    /**
     * When true, the backend enforces a read-only guard regardless of the
     * session's profile and skips writing the run to query history. Used by the
     * result grid's scheduled auto-refresh (polling) so repeated re-runs neither
     * mutate data nor flood the history.
     */
    autoRefresh?: boolean;
    /**
     * When true, the backend enforces a read-only guard regardless of the
     * session's profile. Used by cross-environment broadcast execution
     * (#738), which fans one statement out to several sessions at once and
     * must never let it write to any of them. EXPLAIN の実測モード
     * (EXPLAIN ANALYZE, #1164) も、SQL を実際に実行するためこれを立てる。
     */
    forceReadOnly?: boolean;
    /**
     * DML フライトレコーダ (#735)。true かつ単文の INSERT/UPDATE/DELETE の
     * ときだけ、通常のストリーミング実行の代わりにバックエンドが
     * `capture_write` 経由で before/after イメージの記録を試みつつ実行する。
     * 送られるメッセージの形は変わらないため、この関数の呼び出し側
     * (`onDone`/`onError` 購読) は変更不要。
     */
    capture?: boolean;
    /** 1 回の書き込みで退避する対象行数の上限。 */
    captureRowCap?: number | null;
    /** 退避した before/after イメージの保持期間 (日数)。 */
    captureRetentionDays?: number | null;
    /**
     * 自動リフレッシュの差分パッチ (#1257)。`autoRefresh` のときだけ有効。バックエンドが
     * `key` のタブの前回結果 (PK ハッシュ → 行ハッシュ) を保持し、`prevSnapshotId` が
     * 手元の行配列に紐づく ID と一致すれば、行の代わりに `patch` メッセージ (変化行・
     * 追加行・削除数) だけを返す。`pkIndices` はグリッドの行識別列の添字。
     */
    refreshDiff?: { key: string; pkIndices: number[]; prevSnapshotId: number | null } | null;
    /**
     * 結果ハンドル (#1264)。true のとき、バックエンドが全行を合計メモリ上限の範囲で保持し、
     * `done` メッセージの `resultId` で返す (保持できなければ null)。ソート・フィルタ・
     * 検索・エクスポートを行を往復させずに行える。
     */
    retainResult?: boolean;
  }) => {
    // #1096: `run_query_stream` は結果を Tauri Channel (`onEvent`) で送る。
    // チャンネルは呼び出し側が先に `listenQueryStream(streamId, handlers)` を
    // await していれば `queryStreamChannels` に登録済みのはず — 呼び出し順が
    // 守られていない場合は取りこぼしを静かに許すより早期に落とす。
    const channel = queryStreamChannels.get(params.streamId);
    if (!channel) {
      throw new Error(
        `runQueryStream: listenQueryStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
      );
    }
    return invoke<void>("run_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database ?? null,
      initialBatch: params.initialBatch,
      chunkSize: params.chunkSize,
      autoLimit: params.autoLimit ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
      autoRefresh: params.autoRefresh ?? false,
      forceReadOnly: params.forceReadOnly ?? false,
      capture: params.capture ?? false,
      captureRowCap: params.captureRowCap ?? null,
      captureRetentionDays: params.captureRetentionDays ?? null,
      refreshDiff: params.refreshDiff ?? null,
      retainResult: params.retainResult ?? false,
      onEvent: channel,
    });
  },
  previewQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database?: string | null;
    rowLimit: number;
    chunkSize: number;
    /**
     * ドライラン (INSERT/UPDATE/DELETE をトランザクション内で実行してロールバック)
     * にも `runQueryStream` と同じ全体タイムアウトを課す。未指定/0 はタイムアウト
     * なし。ロック待ちで詰まる UPDATE をプレビューすると、これが無いと接続と行
     * ロックを無期限に握り続ける (読み取り専用セッションからでも到達できる経路)。
     */
    queryTimeoutSecs?: number | null;
  }) => {
    // #1096: `preview_query_stream` も同様に Channel 経由。
    const channel = previewStreamChannels.get(params.streamId);
    if (!channel) {
      throw new Error(
        `previewQueryStream: listenPreviewStream(streamId) must be awaited before invoking (streamId="${params.streamId}")`,
      );
    }
    return invoke<void>("preview_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database ?? null,
      rowLimit: params.rowLimit,
      chunkSize: params.chunkSize,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
      onEvent: channel,
    });
  },
  /**
   * Aborts the streaming task registered under `streamId` (query/preview/
   * export/import all share this). `deliveredRows` is how many rows had
   * already reached the frontend before the abort — used to tell a partial
   * result apart from a complete one (#685). `cancelled` is false when the
   * stream had already finished (or never existed), mirroring the old
   * boolean-only contract.
   */
  cancelStream: (streamId: string) =>
    invoke<CancelStreamResult>("cancel_stream", { streamId }).then((r) =>
      parseResponse(schemas.cancelStreamResponse, r, "cancel_stream"),
    ),
};
