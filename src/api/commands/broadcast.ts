// `src-tauri/src/commands/broadcast.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
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
};
