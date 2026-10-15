// `src-tauri/src/commands/broadcast.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { CellValue, Column, SyncPlan } from "../tauri";
import { broadcastChannels } from "../streamChannels";

export const broadcastCommands = {
  /**
   * 環境横断ブロードキャスト (#738, #1257): 同じ読み取りクエリを基準 + 対象セッションへ
   * 並行実行し、環境ごとの結果 (上限 5,000 行) と基準との差分サマリを `listenBroadcast`
   * の Channel で返す。読み取り専用はバックエンドが強制する。各環境は
   * `broadcastEnvStreamId(runId, sessionId)` で `cancelStream` できる。
   */
  broadcastCompare: (params: {
    runId: string;
    sql: string;
    baselineSessionId: string;
    targetSessionIds: string[];
    autoLimit?: number | null;
    queryTimeoutSecs?: number | null;
    /** 表の主キー列名 (テーブル閲覧タブ由来のとき)。 */
    tablePkColumns: string[];
    /** 結果列からユーザが選んだキー列名 (表の主キーが解決できないとき)。 */
    userKeyColumn?: string | null;
  }) => {
    const channel = broadcastChannels.get(params.runId);
    if (!channel) {
      throw new Error(
        `broadcastCompare: listenBroadcast(runId) must be awaited before invoking (runId="${params.runId}")`,
      );
    }
    return invoke<void>("broadcast_compare", {
      runId: params.runId,
      sql: params.sql,
      baselineSessionId: params.baselineSessionId,
      targetSessionIds: params.targetSessionIds,
      autoLimit: params.autoLimit ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
      tablePkColumns: params.tablePkColumns,
      userKeyColumn: params.userKeyColumn ?? null,
      onEvent: channel,
    });
  },
  /**
   * 比較した環境を基準に揃える INSERT / UPDATE / DELETE を描画する (#1625)。DB には触れず
   * 実行もしない (プレビュー用)。行は `broadcastCompare` で受け取った両環境の結果。結果が
   * 上限で打ち切られていればエラー。`keyColumns` が空なら基準にだけある行の INSERT のみ。
   */
  broadcastSyncSql: (params: {
    driver: string;
    table: string;
    columns: Column[];
    baselineRows: CellValue[][];
    baselineTotal: number;
    targetRows: CellValue[][];
    targetTotal: number;
    keyColumns: string[];
    allowDelete: boolean;
  }) =>
    invoke<SyncPlan>("broadcast_sync_sql", params).then((r) =>
      parseResponse(schemas.syncPlan, r, "broadcast_sync_sql"),
    ),
};
