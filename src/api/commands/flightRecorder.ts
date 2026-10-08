// `src-tauri/src/commands/flight_recorder.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { WriteCaptureSummary, UndoPreviewResponse, UndoOutcome } from "../tauri";

export const flightRecorderCommands = {

  // DML フライトレコーダ (#735)。書き込みの記録は `runQueryStream({ capture: true })`
  // に一本化されているため、非ストリーム版の `run_captured_write` /
  // `precheck_captured_write` ラッパは持たない (#907 で削除)。

  listFlightRecords: (profileId?: string | null, limit?: number | null) =>
    invoke<WriteCaptureSummary[]>("list_flight_records", {
      profileId: profileId ?? null,
      limit: limit ?? null,
    }).then((r) => parseResponse(schemas.writeCaptureSummaryArray, r, "list_flight_records")),

  clearFlightRecords: (profileId?: string | null) =>
    invoke<number>("clear_flight_records", { profileId: profileId ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "clear_flight_records"),
    ),

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
};
