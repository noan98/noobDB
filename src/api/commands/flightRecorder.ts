// `src-tauri/src/commands/flight_recorder.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  ExportPlanOutcome,
  UndoBatchPreviewResponse,
  UndoOutcome,
  UndoPreviewResponse,
  WriteCaptureSummary,
} from "../tauri";

export const flightRecorderCommands = {
  // DML フライトレコーダ (#735)。書き込みの記録は `runQueryStream({ capture: true })`
  // に一本化されているため、非ストリーム版の `run_captured_write` /
  // `precheck_captured_write` ラッパは持たない (#907 で削除)。

  listFlightRecords: (profileId?: string | null, limit?: number | null) =>
    invoke<WriteCaptureSummary[]>("list_flight_records", {
      profileId: profileId ?? null,
      limit: limit ?? null,
    }).then((r) => parseResponse(schemas.writeCaptureSummaryArray, r, "list_flight_records")),

  /** 記録を消す。ピン留めした記録 (#1626) は `includePinned` が true のときだけ消す。 */
  clearFlightRecords: (profileId?: string | null, includePinned?: boolean) =>
    invoke<number>("clear_flight_records", {
      profileId: profileId ?? null,
      includePinned: includePinned ?? false,
    }).then((r) => parseResponse(schemas.numberResponse, r, "clear_flight_records")),

  /** 記録のピン留めを切り替える (#1626)。ピン留めした記録は自動削除の対象外。 */
  pinFlightRecord: (id: number, pinned: boolean) => invoke<void>("pin_flight_record", { id, pinned }),

  /** バッチ (#1626) 全体の取り消し / やり直し計画を、適用せずに返す。 */
  previewFlightBatch: (sessionId: string, batchId: string, redo: boolean) =>
    invoke<UndoBatchPreviewResponse>("preview_flight_batch", { sessionId, batchId, redo }).then((r) =>
      parseResponse(schemas.undoBatchPreviewResponse, r, "preview_flight_batch"),
    ),

  /**
   * バッチ (#1626) を丸ごと取り消す / やり直す。全記録の逆 SQL を 1 トランザクションで適用する。
   * 衝突があり `force` が false のときは何も適用せず衝突を返す。
   */
  applyFlightBatch: (sessionId: string, batchId: string, force: boolean, redo: boolean) =>
    invoke<UndoOutcome>("apply_flight_batch", { sessionId, batchId, force, redo }).then((r) =>
      parseResponse(schemas.undoOutcome, r, "apply_flight_batch"),
    ),

  /** 取り消し / やり直しの SQL を `.sql` ファイルへ書き出す (#1626)。適用はしない。`id` か `batchId` のどちらか。 */
  exportFlightPlanSql: (params: {
    sessionId: string;
    id?: number | null;
    batchId?: string | null;
    redo: boolean;
    force: boolean;
    path: string;
  }) =>
    invoke<ExportPlanOutcome>("export_flight_plan_sql", {
      sessionId: params.sessionId,
      id: params.id ?? null,
      batchId: params.batchId ?? null,
      redo: params.redo,
      force: params.force,
      path: params.path,
    }).then((r) => parseResponse(schemas.exportPlanOutcome, r, "export_flight_plan_sql")),

  /** 記録を CSV / NDJSON で書き出す (#1626)。`ids` 省略で `profileId` (省略は全接続) の最新分。書き出した件数を返す。 */
  exportFlightRecords: (params: {
    path: string;
    format: "csv" | "ndjson";
    ids?: number[] | null;
    profileId?: string | null;
    limit?: number | null;
  }) =>
    invoke<number>("export_flight_records", {
      path: params.path,
      format: params.format,
      ids: params.ids ?? null,
      profileId: params.profileId ?? null,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.numberResponse, r, "export_flight_records")),

  /** 巻き戻しの逆 SQL・競合を副作用なしで確認する (適用前のレビュー用)。 */
  previewUndo: (sessionId: string, id: number) =>
    invoke<UndoPreviewResponse>("preview_undo", { sessionId, id }).then((r) =>
      parseResponse(schemas.undoPreviewResponse, r, "preview_undo"),
    ),

  /**
   * 巻き戻しの逆 SQL を適用する。競合があり `force` が false のときは何も
   * 適用せず競合一覧を返す (`applied: false`) — 呼び出し側は競合を提示して
   * `force: true` で再呼び出しするか、諦めるかをユーザに選ばせる。既存の
   * `run_query_transaction` 経路 (all-or-nothing・read-only ガード・履歴記録)
   * をそのまま通る。
   */
  undoFlightRecord: (sessionId: string, id: number, force: boolean) =>
    invoke<UndoOutcome>("undo_flight_record", { sessionId, id, force }).then((r) =>
      parseResponse(schemas.undoOutcome, r, "undo_flight_record"),
    ),

  /** Redo (#1536) の SQL・競合を副作用なしで確認する。取り消し済みの記録だけが対象。 */
  previewRedo: (sessionId: string, id: number) =>
    invoke<UndoPreviewResponse>("preview_redo", { sessionId, id }).then((r) =>
      parseResponse(schemas.undoPreviewResponse, r, "preview_redo"),
    ),

  /**
   * 取り消し済みの書き込みをやり直す (Redo, #1536)。衝突検出・`force`・read-only ガード・
   * 履歴記録は `undoFlightRecord` と同じ経路を通る。
   */
  redoFlightRecord: (sessionId: string, id: number, force: boolean) =>
    invoke<UndoOutcome>("redo_flight_record", { sessionId, id, force }).then((r) =>
      parseResponse(schemas.undoOutcome, r, "redo_flight_record"),
    ),
};
