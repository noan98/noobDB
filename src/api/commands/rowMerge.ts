// `src-tauri/src/commands/row_merge.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import type { RowMergeOutcome, RowMergePreview, RowMergeRequest } from "../tauri";

export const rowMergeCommands = {
  /**
   * 重複レコードのマージ (#2303) のプレビュー。残す行・重複行を DB から読み直し、子テーブルごとの
   * 付け替え件数・子側の一意キーの衝突・実行する SQL を返す。読み取りのみ (read_only 接続でも動く)。
   */
  previewRowMerge: (params: {
    sessionId: string;
    database: string;
    table: string;
    request: RowMergeRequest;
    rowCap?: number | null;
  }) =>
    invoke<RowMergePreview>("preview_row_merge", {
      sessionId: params.sessionId,
      database: params.database,
      table: params.table,
      request: params.request,
      rowCap: params.rowCap ?? null,
    }),

  /**
   * 重複レコードのマージを実行する (#2303)。子の付け替え → 重複行の DELETE → 残す行の UPDATE を
   * 1 トランザクション (all-or-nothing) で行う。read_only 接続はバックエンドが拒否する。
   * `options.capture` を指定するとフライトレコーダーへ記録し、Undo できる。
   */
  applyRowMerge: (params: {
    sessionId: string;
    database: string;
    table: string;
    request: RowMergeRequest;
    capture?: { rowCap?: number | null; retentionDays?: number | null } | null;
  }) =>
    invoke<RowMergeOutcome>("apply_row_merge", {
      sessionId: params.sessionId,
      database: params.database,
      table: params.table,
      request: params.request,
      options: params.capture
        ? {
            capture: {
              row_cap: params.capture.rowCap ?? null,
              retention_days: params.capture.retentionDays ?? null,
            },
          }
        : null,
    }),
};
