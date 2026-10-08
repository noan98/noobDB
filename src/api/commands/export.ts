// `src-tauri/src/commands/export.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ExportColumnMask } from "../../components/exportMasking";
import type { Column, CellValue, ExportFormat, ExportResult } from "../tauri";

export const exportCommands = {

  exportQueryResult: (params: {
    path: string;
    format: ExportFormat;
    columns: Column[];
    rows: CellValue[][];
    /** JSON 形式のとき出力に同梱する実行クエリ。null/未指定なら同梱しない。 */
    query?: string | null;
    /** SQL 形式のときの対象テーブル名・ドライバ・バッチサイズ。他形式では無視。 */
    table?: string | null;
    driver?: string | null;
    batchSize?: number | null;
    /** 列単位のマスキングルール (#733)。未指定 / 空ならマスクしない。 */
    masks?: ExportColumnMask[] | null;
    /**
     * 結果ハンドル (#1264)。指定時は `rows` を使わず (空配列でよい)、バックエンドが保持する
     * 行を書き出す。破棄済みなら `isResultGoneError` のエラーになるので rows 付きで再試行する。
     */
    resultId?: string | null;
  }) =>
    invoke<ExportResult>("export_query_result", {
      path: params.path,
      format: params.format,
      columns: params.columns,
      rows: params.rows,
      query: params.query ?? null,
      table: params.table ?? null,
      driver: params.driver ?? null,
      batchSize: params.batchSize ?? null,
      masks: params.masks && params.masks.length > 0 ? params.masks : null,
      resultId: params.resultId ?? null,
    }).then((r) => parseResponse(schemas.exportResult, r, "export_query_result")),

  /**
   * 行へエクスポート用マスキング (#733) を適用して返す (プレビュー / 全文コピー用)。
   * 仮名化 (`hash`) の秘密ソルトは keyring にありフロントへ出さないため、変換は
   * 実際の書き出しと同じバックエンドの純関数で行う。ファイル・DB には触れない。
   */
  maskExportRows: (params: {
    columns: Column[];
    rows: CellValue[][];
    masks: ExportColumnMask[];
    /** 結果ハンドル (#1264)。指定時は `rows` を使わず、バックエンド保持の行へ適用する。 */
    resultId?: string | null;
  }) =>
    invoke<CellValue[][]>("mask_export_rows", {
      columns: params.columns,
      rows: params.rows,
      masks: params.masks,
      resultId: params.resultId ?? null,
    }).then((r) => parseResponse(schemas.cellRowsLite, r, "mask_export_rows")),

  /**
   * クエリを再実行し、全件をストリーミングで直接ファイルへ書き出す。結果は
   * `export-stream:*` イベントで通知され、`cancelStream` で中断できる。SELECT 系のみ。
   */
  exportQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database: string | null;
    format: ExportFormat;
    path: string;
    initialBatch: number;
    chunkSize: number;
    queryTimeoutSecs: number | null;
    /** SQL 形式のときの対象テーブル名・バッチサイズ。ドライバはセッションから取る。 */
    table?: string | null;
    batchSize?: number | null;
    /** 列単位のマスキングルール (#733)。未指定 / 空ならマスクしない。 */
    masks?: ExportColumnMask[] | null;
  }) =>
    invoke<void>("export_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database,
      format: params.format,
      path: params.path,
      initialBatch: params.initialBatch,
      chunkSize: params.chunkSize,
      queryTimeoutSecs: params.queryTimeoutSecs,
      table: params.table ?? null,
      batchSize: params.batchSize ?? null,
      masks: params.masks && params.masks.length > 0 ? params.masks : null,
    }),
};
