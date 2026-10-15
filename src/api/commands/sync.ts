// `src-tauri/src/commands/sync.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { CellValue, SchemaDiff, SyncPlan } from "../tauri";

/** `generateDataSyncSql` の行の絞り込み (#1625)。 */
export interface DataSyncSelection {
  kinds?: Array<"source_only" | "target_only" | "different"> | null;
  onlyKeys?: CellValue[][] | null;
}

export const syncCommands = {
  generateSyncSql: (diff: SchemaDiff, allowDestructive: boolean) =>
    invoke<SyncPlan>("generate_sync_sql", { diff, allowDestructive }).then((r) =>
      parseResponse(schemas.syncPlan, r, "generate_sync_sql"),
    ),
  /**
   * データ差分から INSERT / UPDATE / DELETE を描画する。差分そのものは送らず、
   * `compareTableData` / `sandboxTableDiff` が返した `diffId` (バックエンド保持, #1259) を
   * 渡す。`skipKeys` は描画前に除く行の主キー (サンドボックスの競合「スキップ」解決)。
   * `selection` は描画する行の絞り込み (#1625): `kinds` は含める行の種別、`onlyKeys` は
   * 含める行の主キー (null なら全行、空配列なら 0 行)。
   * 保持期限切れ・破棄済みの ID はエラー (比較のやり直しを促す)。
   */
  generateDataSyncSql: (
    diffId: string,
    allowDelete: boolean,
    skipKeys?: CellValue[][] | null,
    selection?: DataSyncSelection | null,
  ) =>
    invoke<SyncPlan>("generate_data_sync_sql", {
      diffId,
      allowDelete,
      skipKeys: skipKeys && skipKeys.length > 0 ? skipKeys : null,
      kinds: selection?.kinds ?? null,
      // 空配列は「1 行も選ばない」の意味なのでそのまま送る (null は全行)。
      onlyKeys: selection?.onlyKeys ?? null,
    }).then((r) => parseResponse(schemas.syncPlan, r, "generate_data_sync_sql")),
  /** バックエンドが保持している `DataDiff` を破棄する (比較のやり直し・画面を閉じたとき)。 */
  releaseDataDiffs: (diffIds: string[]) => invoke<void>("release_data_diffs", { diffIds }),
  applySyncSql: (params: { sessionId: string; database?: string | null; statements: string[] }) =>
    invoke<number>("apply_sync_sql", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      statements: params.statements,
    }).then((r) => parseResponse(schemas.numberResponse, r, "apply_sync_sql")),
};
