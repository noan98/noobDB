// `src-tauri/src/commands/import.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  DriverKind,
  ImportOptions,
  NewTableColumn,
  ColumnMapping,
  CsvPreview,
} from "../tauri";

export const importCommands = {

  parseCsvPreview: (path: string, options: ImportOptions) =>
    invoke<CsvPreview>("parse_csv_preview", { path, options }).then((r) =>
      parseResponse(schemas.csvPreview, r, "parse_csv_preview"),
    ),
  importCsv: (params: {
    sessionId: string;
    streamId: string;
    database?: string | null;
    table: string;
    path: string;
    options: ImportOptions;
    mapping: ColumnMapping[];
    batchSize?: number;
    /**
     * 指定すると、取り込み前にこの列定義で `table` を新規作成する (#985)。
     * `mapping` の `column` はすべてここに含まれている必要がある。
     */
    createTable?: NewTableColumn[] | null;
  }) =>
    invoke<void>("import_csv", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database ?? null,
      table: params.table,
      path: params.path,
      options: params.options,
      mapping: params.mapping,
      batchSize: params.batchSize ?? null,
      createTable: params.createTable ?? null,
    }),

  /**
   * 新規テーブル作成付きインポート (#985) で実行される `CREATE TABLE` を返す。
   * 実行時と同じバックエンドの生成関数を通すので、プレビュー = 実際の DDL。
   * 名前が空・重複列名・長さ超過などは reject される。
   */
  previewCreateTableDdl: (driver: DriverKind, table: string, columns: NewTableColumn[]) =>
    invoke<string>("preview_create_table_ddl", { driver, table, columns }).then((r) =>
      parseResponse(schemas.stringResponse, r, "preview_create_table_ddl"),
    ),

  /**
   * 直近の取り込み (skip モード) でスキップされた全行を、一覧テキストにして返す
   * (#1258、コピー用)。全件は Rust 側が保持しているので、完了イベントに載る先頭
   * 一部より多く取れる。`recordTemplate` / `lineTemplate` は `{record}` `{line}`
   * `{reason}` を含む表示用テンプレート (i18n 文言をそのまま渡す)。
   */
  getImportSkippedText: (recordTemplate: string, lineTemplate: string) =>
    invoke<string>("get_import_skipped_text", { recordTemplate, lineTemplate }).then((r) =>
      parseResponse(schemas.stringResponse, r, "get_import_skipped_text"),
    ),

  /**
   * 直近の取り込みでスキップされた全行を `path` へテキストで書き出す (#1258)。
   * 書き出した行数を返す。保持している行が無ければ reject される。
   */
  saveImportSkippedRows: (path: string, recordTemplate: string, lineTemplate: string) =>
    invoke<number>("save_import_skipped_rows", { path, recordTemplate, lineTemplate }).then((r) =>
      parseResponse(schemas.numberResponse, r, "save_import_skipped_rows"),
    ),
};
