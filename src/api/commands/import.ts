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
  ImportDryRunResult,
  ImportTemplate,
  SheetImportSpec,
  SkippedExportFormat,
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
  saveImportSkippedRows: (
    path: string,
    recordTemplate: string,
    lineTemplate: string,
    format?: SkippedExportFormat,
  ) =>
    invoke<number>("save_import_skipped_rows", {
      path,
      recordTemplate,
      lineTemplate,
      format: format ?? null,
    }).then((r) => parseResponse(schemas.numberResponse, r, "save_import_skipped_rows")),

  /**
   * 取り込みの事前検証 (dry run、#1623)。本番と同じ解釈で全行をロールバック付きの
   * トランザクションへ流し、DB が拒否する行の件数と先頭一部を返す。何も書き込まない
   * (読み取り専用接続でも実行できる)。`createTable` を渡したときは DB を試さず、
   * ファイルのパースと主キーの検証だけを行う (`dbChecked: false`)。
   */
  importDryRun: (params: {
    sessionId: string;
    database?: string | null;
    table: string;
    path: string;
    options: ImportOptions;
    mapping: ColumnMapping[];
    createTable?: NewTableColumn[] | null;
  }) =>
    invoke<ImportDryRunResult>("import_dry_run", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      table: params.table,
      path: params.path,
      options: params.options,
      mapping: params.mapping,
      createTable: params.createTable ?? null,
    }).then((r) => parseResponse(schemas.importDryRunResult, r, "import_dry_run")),

  /**
   * xlsx の複数シートを、シートごとに別のテーブルへ順に取り込む (#1623)。進捗・完了は
   * {@link importCsv} と同じ `csv-import:*` イベント (`started` はシートごとに届き、`done` は
   * 全体で 1 回で `sheets` にシートごとの件数が入る)。各シートは単独の取り込みと同じ
   * トランザクション単位で、失敗したシートより前のシートは取り込み済みのまま残る。
   */
  importXlsxSheets: (params: {
    sessionId: string;
    streamId: string;
    database?: string | null;
    path: string;
    options: ImportOptions;
    sheets: SheetImportSpec[];
    batchSize?: number;
  }) =>
    invoke<void>("import_xlsx_sheets", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database ?? null,
      path: params.path,
      options: params.options,
      sheets: params.sheets,
      batchSize: params.batchSize ?? null,
    }),

  /** 保存済みの取り込みマッピング (#1623)。`table` 省略でそのデータベースの全テーブル分。 */
  listImportTemplates: (profileId: string, database?: string | null, table?: string | null) =>
    invoke<ImportTemplate[]>("list_import_templates", {
      profileId,
      database: database ?? null,
      table: table ?? null,
    }).then((r) => parseResponse(schemas.importTemplateArray, r, "list_import_templates")),

  /** 取り込みマッピングを保存する (#1623)。同じ接続・データベース・テーブルは置き換わる。 */
  saveImportTemplate: (template: ImportTemplate) =>
    invoke<ImportTemplate>("save_import_template", { template }).then((r) =>
      parseResponse(schemas.importTemplate, r, "save_import_template"),
    ),

  deleteImportTemplate: (id: string) => invoke<void>("delete_import_template", { id }),
};
