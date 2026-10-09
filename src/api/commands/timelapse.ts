// `src-tauri/src/commands/timelapse.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  TableWatch,
  TimelapseWatchOutcome,
  TimelapseCaptureOutcome,
  TimelapseGenerationDiff,
} from "../tauri";

export const timelapseCommands = {

  // --- テーブル・タイムラプス (#739) ---
  // スナップショットはアプリデータディレクトリ配下のローカル専用ストア
  // (`table_timelapse.sqlite`) にのみ保存される。取得は読み取り専用の単一 SELECT で、
  // クエリ履歴には記録されない。

  /**
   * テーブルをウォッチ登録し初回スナップショットを取る。PK の無いテーブルは
   * エラー。行数上限を超えるテーブルは `allowPartial` が false なら登録せず
   * `over_limit: true` を返す (UI が同意を取ってから `true` で再呼び出しする)。
   */
  timelapseWatchTable: (params: {
    sessionId: string;
    database: string;
    table: string;
    allowPartial: boolean;
    maxGenerations?: number | null;
  }) =>
    invoke<TimelapseWatchOutcome>("timelapse_watch_table", {
      sessionId: params.sessionId,
      database: params.database,
      table: params.table,
      allowPartial: params.allowPartial,
      maxGenerations: params.maxGenerations ?? null,
    }).then((r) => parseResponse(schemas.timelapseWatchOutcome, r, "timelapse_watch_table")),

  /** セッションのプロファイルのアクティブなウォッチを全件取得する (接続時 / 手動更新)。 */
  timelapseCapture: (sessionId: string, maxGenerations?: number | null) =>
    invoke<TimelapseCaptureOutcome[]>("timelapse_capture", {
      sessionId,
      maxGenerations: maxGenerations ?? null,
    }).then((r) => parseResponse(schemas.timelapseCaptureOutcomeArray, r, "timelapse_capture")),

  timelapseListWatches: (profileId: string) =>
    invoke<TableWatch[]>("timelapse_list_watches", { profileId }).then((r) =>
      parseResponse(schemas.tableWatchArray, r, "timelapse_list_watches"),
    ),

  /** 同じウォッチの 2 世代の行差分 (古い方 → 新しい方)。セッション不要。 */
  timelapseDiffGenerations: (fromId: number, toId: number) =>
    invoke<TimelapseGenerationDiff>("timelapse_diff_generations", { fromId, toId }).then((r) =>
      parseResponse(schemas.timelapseGenerationDiff, r, "timelapse_diff_generations"),
    ),

  /** ウォッチ解除。`deleteData` なら保存済み世代も削除する。 */
  timelapseUnwatch: (watchId: number, deleteData: boolean) =>
    invoke<void>("timelapse_unwatch", { watchId, deleteData }),

  /** 全ウォッチ・全世代を削除する (設定画面の一括削除)。削除した世代数を返す。 */
  timelapseClearAll: () =>
    invoke<number>("timelapse_clear_all").then((r) =>
      parseResponse(schemas.numberResponse, r, "timelapse_clear_all"),
    ),
};
