// `src-tauri/src/commands/result.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ExportColumnMask } from "../../components/exportMasking";
import type { HandleSortFilterRequest } from "../../components/gridSortFilter";
import type {
  Column,
  CellValue,
  ExportFormat,
  ResultFindOutput,
  ResultColumnStats,
} from "../tauri";

export const resultCommands = {

  /**
   * 結果ハンドル (#1264): ソート・列フィルタ・全体フィルタを適用した**表示順の行インデックス**
   * (元の行位置) を返す。意味論は `ResultGrid` の JS 実装と同じ (ただし文字列の照合順序は
   * `Intl.Collator` の近似)。`null` はハンドルが無い (破棄済み) — JS 経路へ戻る。
   */
  resultSortFilter: (params: { resultId: string } & HandleSortFilterRequest) =>
    invoke<number[] | null>("result_sort_filter", {
      resultId: params.resultId,
      sort: params.sort,
      filters: params.filters,
      global: params.global,
    }).then((r) => parseResponse(schemas.resultSortFilterResponse, r, "result_sort_filter")),

  /**
   * 結果ハンドル (#1264): 結果内検索 (正規表現なし)。ヒットは行優先で最大 `limit` 件 +
   * 総数・打ち切りの有無。`null` はハンドルが無い。
   */
  resultFind: (params: {
    resultId: string;
    query: string;
    options: { caseSensitive: boolean; wholeCell: boolean };
    limit: number;
  }) =>
    invoke<ResultFindOutput | null>("result_find", {
      resultId: params.resultId,
      query: params.query,
      options: params.options,
      limit: params.limit,
    }).then((r) => parseResponse(schemas.resultFindResponse, r, "result_find")),

  /** 結果ハンドル (#1264): 列クイック統計。`null` はハンドルが無い。 */
  resultColumnStats: (resultId: string, col: number) =>
    invoke<ResultColumnStats | null>("result_column_stats", { resultId, col }).then((r) =>
      parseResponse(schemas.resultColumnStatsResponse, r, "result_column_stats"),
    ),

  /** 結果ハンドル (#1264) を破棄する。存在しない ID でも成功 (冪等)。 */
  releaseResult: (resultId: string) => invoke<void>("release_result", { resultId }),

  /**
   * エクスポート内容をテキストで生成する (全文コピー・マスク付きプレビュー用, #1264)。
   * ファイル出力と同じバックエンドの書式ライタを通るため、書式・マスキングはファイルと
   * バイト一致する。`resultId` 指定時は `rows` を使わない。xlsx は不可。
   */
  renderExportText: (params: {
    format: ExportFormat;
    columns: Column[];
    rows?: CellValue[][];
    resultId?: string | null;
    query?: string | null;
    table?: string | null;
    driver?: string | null;
    batchSize?: number | null;
    masks?: ExportColumnMask[] | null;
  }) =>
    invoke<string>("render_export_text", {
      req: {
        format: params.format,
        columns: params.columns,
        rows: params.rows ?? [],
        resultId: params.resultId ?? null,
        query: params.query ?? null,
        table: params.table ?? null,
        driver: params.driver ?? null,
        batchSize: params.batchSize ?? null,
        masks: params.masks && params.masks.length > 0 ? params.masks : null,
      },
    }).then((r) => parseResponse(schemas.stringResponse, r, "render_export_text")),
};
