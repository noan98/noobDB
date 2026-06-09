import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as schemas from "./schemas";
import { parseResponse } from "./schemas";

export type DriverKind = "mysql" | "postgres" | "sqlite";

export type SshAuthMethod = "key" | "agent" | "password";

export interface SshProfile {
  host: string;
  port: number;
  user: string;
  auth_method: SshAuthMethod;
  private_key_path: string;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  ssh: SshProfile | null;
  group: string | null;
  color: string | null;
  is_production: boolean;
  /**
   * When true (and `is_production` is set), the UI asks for explicit approval
   * before running any non-read-only statement. `read_only` takes precedence.
   */
  confirm_writes: boolean;
  /**
   * When true, sessions opened from this profile reject any SQL that is
   * not strictly read-only (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH).
   */
  read_only: boolean;
  /**
   * When true, statements run on sessions from this profile are not recorded
   * in the query history.
   */
  skip_history: boolean;
  /** Database file path for file-backed drivers (SQLite). */
  file_path: string | null;
  /**
   * Whether a DB password is stored in the OS keyring for this profile. The
   * value itself never reaches the frontend; this flag only drives the masked
   * "password is set" indicator in the connection form. Present only on
   * profiles returned by `list_profiles`.
   */
  has_db_password?: boolean;
  /** Whether an SSH key passphrase is stored in the keyring. See `has_db_password`. */
  has_ssh_passphrase?: boolean;
  /** Whether an SSH password is stored in the keyring. See `has_db_password`. */
  has_ssh_password?: boolean;
}

export interface SshRequest extends SshProfile {
  passphrase?: string;
  password?: string;
}

export interface ConnectRequest {
  profile_id?: string;
  driver: DriverKind;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  ssh: SshRequest | null;
  /** Required for sqlite; ignored otherwise. */
  file_path?: string | null;
  /**
   * When true the resulting session refuses to execute non-read-only SQL.
   * Defaults to false on the backend if omitted.
   */
  read_only?: boolean;
  /** When true, statements on this session are not recorded in history. */
  skip_history?: boolean;
}

export interface SaveProfileRequest {
  id?: string;
  name: string;
  driver: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  ssh: SshProfile | null;
  db_password?: string;
  ssh_passphrase?: string;
  ssh_password?: string;
  group: string | null;
  color: string | null;
  is_production: boolean;
  confirm_writes: boolean;
  read_only: boolean;
  skip_history: boolean;
  /** Required for sqlite; ignored otherwise. */
  file_path?: string | null;
}

/** プロファイルインポート時の ID 衝突解決戦略 (#442)。 */
export type ProfileImportStrategy = "rename" | "skip" | "overwrite";

/** `importProfiles` の結果要約 (#442)。 */
export interface ProfileImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
  invalid: number;
}

export type SnippetScope =
  | { kind: "any" }
  | { kind: "profile"; profile_id: string }
  | { kind: "group"; group: string };

export interface Snippet {
  id: string;
  name: string;
  folder: string | null;
  tags: string[];
  sql: string;
  driver: string | null;
  scope: SnippetScope;
}

export interface SaveSnippetRequest {
  id?: string;
  name: string;
  folder: string | null;
  tags: string[];
  sql: string;
  driver: string | null;
  scope: SnippetScope;
}

export interface HistoryEntry {
  id: number;
  profile_id: string | null;
  driver: string;
  database: string | null;
  sql: string;
  /** Rows returned by a SELECT-shaped statement. `null` for writes. */
  rows: number | null;
  /** Rows affected by a write statement. `null` for SELECTs. */
  rows_affected: number | null;
  elapsed_ms: number | null;
  /** "ok" or "error". */
  status: string;
  error: string | null;
  /** ISO8601 (RFC3339, UTC) timestamp. */
  executed_at: string;
}

export interface Column {
  name: string;
  type_name: string;
}

export type CellValue =
  | null
  | boolean
  | number
  | string;

export interface QueryResult {
  columns: Column[];
  rows: CellValue[][];
  rows_affected: number;
  elapsed_ms: number;
}

export interface PreviewResult {
  target_table: string | null;
  columns: Column[];
  primary_key: string[];
  before_rows: CellValue[][];
  after_rows: CellValue[][];
  rows_affected: number;
  elapsed_ms: number;
  truncated: boolean;
}

export interface TableColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
  /** Referenced table when this column is a foreign key, else `null`. */
  referenced_table: string | null;
  /** Referenced column for the foreign key, when known. */
  referenced_column: string | null;
}

/** One table (or view) and its column names, for whole-schema autocomplete. */
export interface TableSchema {
  name: string;
  columns: string[];
}

/** テーブル 1 つのインデックス情報 (#459)。 */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
}

/** 非テーブルのスキーマオブジェクト種別 (#483)。 */
export type SchemaObjectKind =
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "trigger";

/** 非テーブルのスキーマオブジェクト (#483)。 */
export interface SchemaObject {
  kind: SchemaObjectKind;
  name: string;
  /** 同名衝突を避ける一意識別子 (PostgreSQL の oid 等)。無いドライバ/種別では null。 */
  id: string | null;
}

/**
 * One foreign-key relationship in a database, used to draw ER-diagram edges.
 * One entry per referencing column; the columns of a composite key share a
 * `constraint_name`. `referenced_column` is `null` only when the driver can't
 * resolve the target column.
 */
export interface ForeignKey {
  table: string;
  column: string;
  referenced_table: string;
  referenced_column: string | null;
  constraint_name: string | null;
}

/**
 * Approximate row count for one base table, sourced from the engine's own
 * statistics (no `COUNT(*)` scan). `estimate` is `null` when no cheap estimate
 * is available (SQLite, or stats not gathered yet) and is otherwise an
 * approximate, possibly-stale value.
 */
export interface TableRowEstimate {
  name: string;
  estimate: number | null;
}

/**
 * Where a table or column sits relative to the two schemas in a comparison.
 * `source_only` would be added to the target, `target_only` would be removed,
 * `different` exists on both sides with differing definitions, `same` is
 * identical.
 */
export type DiffStatus = "source_only" | "target_only" | "different" | "same";

/** Difference of a single column between the source and target schemas. */
export interface ColumnDiff {
  name: string;
  status: DiffStatus;
  /** Source-side definition, when the column exists there. */
  source: TableColumnInfo | null;
  /** Target-side definition, when the column exists there. */
  target: TableColumnInfo | null;
  /**
   * For `different`, the attribute names that differ
   * (`data_type` / `nullable` / `default` / `key` / `extra` / `foreign_key`).
   * Empty for every other status.
   */
  changed_fields: string[];
}

/** Difference of a single table between the source and target schemas. */
export interface TableDiff {
  name: string;
  status: DiffStatus;
  /**
   * Column-level diffs. For a one-sided table every column is listed with that
   * same status; for a table present on both sides only the differing columns
   * are listed; for an identical (`same`) table this is empty.
   */
  columns: ColumnDiff[];
}

/** Result of comparing a source schema against a target schema (Issue #245). */
export interface SchemaDiff {
  source_driver: DriverKind;
  target_driver: DriverKind;
  tables: TableDiff[];
}

/** What a generated sync statement does (Issue #245 phase 2). */
export type SyncKind =
  | "create_table"
  | "add_column"
  | "alter_column"
  | "drop_column"
  | "drop_table"
  | "insert_row"
  | "update_row"
  | "delete_row";

/** One reconciling DDL statement that makes the target match the source. */
export interface SyncStatement {
  sql: string;
  table: string;
  kind: SyncKind;
  /** True for `DROP` statements; gated behind the destructive toggle. */
  destructive: boolean;
}

/** Generated reconciliation plan: executable statements plus skipped-case notes. */
export interface SyncPlan {
  statements: SyncStatement[];
  warnings: string[];
}

/** Where a row sits relative to the two tables (Issue #245 phase 3). */
export type RowStatus = "source_only" | "target_only" | "different";

/** One row-level difference paired by primary key. */
export interface RowDiff {
  status: RowStatus;
  /** Primary-key values pairing the two sides. */
  key: CellValue[];
  source: CellValue[] | null;
  target: CellValue[] | null;
  /** For `different`, the non-key columns whose values differ. */
  changed_columns: string[];
}

/** Result of comparing one table's rows across two connections. */
export interface DataDiff {
  target_driver: DriverKind;
  table: string;
  columns: string[];
  primary_key: string[];
  rows: RowDiff[];
  /** True if either side hit the row cap, so the diff is partial. */
  truncated: boolean;
  source_count: number;
  target_count: number;
}

/** Application log contents plus the on-disk file path, for the Settings viewer. */
export interface LogView {
  text: string;
  path: string | null;
}

export type ExportFormat = "csv" | "json";

/** Checkbox-selected `mysqldump` flags for a database dump. */
export interface DumpOptions {
  /** `--single-transaction`: consistent InnoDB snapshot without locking. */
  singleTransaction: boolean;
  /** `--routines`: include stored procedures and functions. */
  routines: boolean;
  /** `--events`: include scheduled events. */
  events: boolean;
  /** Include triggers (off → `--skip-triggers`). */
  triggers: boolean;
  /** Emit `DROP TABLE` before each `CREATE TABLE` (off → `--skip-add-drop-table`). */
  addDropTable: boolean;
  /** Multi-row `INSERT` statements (off → `--skip-extended-insert`). */
  extendedInsert: boolean;
  /** `--complete-insert`: write column names in every `INSERT`. */
  completeInsert: boolean;
  /** `--no-data` (pg `--schema-only`; sqlite skips INSERTs): schema only. */
  noData: boolean;
  /** `--no-create-info` (pg `--data-only`; sqlite skips schema): data only. */
  noCreateInfo: boolean;
  /** PostgreSQL only — `pg_dump --no-owner`. */
  noOwner?: boolean;
  /** PostgreSQL only — `pg_dump --no-privileges`. */
  noPrivileges?: boolean;
  /** PostgreSQL only — `pg_dump -n <schema>`; empty/undefined = all schemas. */
  pgSchema?: string | null;
}

export interface ImportOptions {
  /** Field delimiter — a single character (e.g. ",", "\t", ";"). */
  delimiter: string;
  /** Quote character — a single character. */
  quote: string;
  /** Whether the first record is a header row. */
  hasHeader: boolean;
  /**
   * When set, any field whose raw text equals this token is imported as SQL
   * NULL ("" → empty cells become NULL). `null`/omitted disables NULL mapping.
   */
  nullToken?: string | null;
  /** Encoding label (e.g. "utf-8", "shift_jis", "euc-jp"). */
  encoding: string;
}

export interface ColumnMapping {
  /** Destination table column name. */
  column: string;
  /** Zero-based index of the source field within each CSV record. */
  csvIndex: number;
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  truncated: boolean;
}

export const api = {
  testConnection: (req: ConnectRequest) =>
    invoke<string>("test_connection", { req }).then((r) =>
      parseResponse(schemas.stringResponse, r, "test_connection"),
    ),
  connect: (req: ConnectRequest) =>
    invoke<{ session_id: string }>("connect", { req }).then((r) =>
      parseResponse(schemas.connectResult, r, "connect"),
    ),
  disconnect: (sessionId: string) =>
    invoke<void>("disconnect", { sessionId }),
  /**
   * 接続のヘルスチェック (#485)。生きていれば true、死んでいれば (スリープ復帰や
   * トンネル断) false。セッションが見つからない場合のみ reject する。
   */
  pingSession: (sessionId: string) => invoke<boolean>("ping_session", { sessionId }),
  /** 明示トランザクション (#414) を開始する。 */
  beginTransaction: (sessionId: string, database?: string | null) =>
    invoke<void>("begin_transaction", { sessionId, database: database ?? null }),
  /** 明示トランザクション内で 1 文を実行する (#414)。 */
  runInTransaction: (sessionId: string, sql: string) =>
    invoke<QueryResult>("run_in_transaction", { sessionId, sql }).then((r) =>
      parseResponse(schemas.queryResult, r, "run_in_transaction"),
    ),
  /** 明示トランザクションを確定 (commit=true) / 破棄 (false) する (#414)。 */
  finishTransaction: (sessionId: string, commit: boolean) =>
    invoke<void>("finish_transaction", { sessionId, commit }),

  runQuery: (sessionId: string, sql: string, database?: string | null) =>
    invoke<QueryResult>("run_query", {
      sessionId,
      sql,
      database: database ?? null,
    }).then((r) => parseResponse(schemas.queryResult, r, "run_query")),
  runQueryTransaction: (
    sessionId: string,
    statements: string[],
    database?: string | null,
  ) =>
    invoke<QueryResult>("run_query_transaction", {
      sessionId,
      statements,
      database: database ?? null,
    }).then((r) => parseResponse(schemas.queryResult, r, "run_query_transaction")),
  runQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database?: string | null;
    initialBatch: number;
    chunkSize: number;
    autoLimit?: number | null;
    queryTimeoutSecs?: number | null;
    /**
     * When true, the backend enforces a read-only guard regardless of the
     * session's profile and skips writing the run to query history. Used by the
     * result grid's scheduled auto-refresh (polling) so repeated re-runs neither
     * mutate data nor flood the history.
     */
    autoRefresh?: boolean;
  }) =>
    invoke<void>("run_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database ?? null,
      initialBatch: params.initialBatch,
      chunkSize: params.chunkSize,
      autoLimit: params.autoLimit ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
      autoRefresh: params.autoRefresh ?? false,
    }),
  previewQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database?: string | null;
    rowLimit: number;
    chunkSize: number;
  }) =>
    invoke<void>("preview_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database ?? null,
      rowLimit: params.rowLimit,
      chunkSize: params.chunkSize,
    }),
  cancelStream: (streamId: string) =>
    invoke<boolean>("cancel_stream", { streamId }).then((r) =>
      parseResponse(schemas.booleanResponse, r, "cancel_stream"),
    ),

  listDatabases: (sessionId: string) =>
    invoke<string[]>("list_databases", { sessionId }).then((r) =>
      parseResponse(schemas.stringArray, r, "list_databases"),
    ),
  listTables: (sessionId: string, database: string) =>
    invoke<string[]>("list_tables", { sessionId, database }).then((r) =>
      parseResponse(schemas.stringArray, r, "list_tables"),
    ),
  describeTable: (sessionId: string, database: string, table: string) =>
    invoke<TableColumnInfo[]>("describe_table", { sessionId, database, table }).then(
      (r) => parseResponse(schemas.tableColumnInfoArray, r, "describe_table"),
    ),
  schemaOverview: (sessionId: string, database: string) =>
    invoke<TableSchema[]>("schema_overview", { sessionId, database }).then((r) =>
      parseResponse(schemas.tableSchemaArray, r, "schema_overview"),
    ),
  foreignKeys: (sessionId: string, database: string) =>
    invoke<ForeignKey[]>("foreign_keys", { sessionId, database }).then((r) =>
      parseResponse(schemas.foreignKeyArray, r, "foreign_keys"),
    ),
  tableRowEstimates: (sessionId: string, database: string) =>
    invoke<TableRowEstimate[]>("table_row_estimates", { sessionId, database }).then(
      (r) => parseResponse(schemas.tableRowEstimateArray, r, "table_row_estimates"),
    ),
  /** テーブルのインデックス一覧を取得する (#459)。 */
  listIndexes: (sessionId: string, database: string, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { sessionId, database, table }).then((r) =>
      parseResponse(schemas.indexInfoArray, r, "list_indexes"),
    ),
  /** 非テーブルのスキーマオブジェクト (ビュー/ルーチン/トリガー) を取得する (#483)。 */
  listSchemaObjects: (sessionId: string, database: string) =>
    invoke<SchemaObject[]>("list_schema_objects", { sessionId, database }).then((r) =>
      parseResponse(schemas.schemaObjectArray, r, "list_schema_objects"),
    ),
  /** スキーマオブジェクトの定義 (DDL) を取得する (#483)。`id` は同名衝突を避ける一意識別子。 */
  getObjectDefinition: (
    sessionId: string,
    database: string,
    kind: string,
    name: string,
    id?: string | null,
  ) =>
    invoke<string>("get_object_definition", {
      sessionId,
      database,
      kind,
      name,
      id: id ?? null,
    }),
  compareSchema: (params: {
    sourceSessionId: string;
    sourceDatabase: string;
    targetSessionId: string;
    targetDatabase: string;
  }) =>
    invoke<SchemaDiff>("compare_schema", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
    }).then((r) => parseResponse(schemas.schemaDiff, r, "compare_schema")),
  generateSyncSql: (diff: SchemaDiff, allowDestructive: boolean) =>
    invoke<SyncPlan>("generate_sync_sql", { diff, allowDestructive }).then((r) =>
      parseResponse(schemas.syncPlan, r, "generate_sync_sql"),
    ),
  compareTableData: (params: {
    sourceSessionId: string;
    sourceDatabase: string;
    targetSessionId: string;
    targetDatabase: string;
    table: string;
    limit?: number | null;
  }) =>
    invoke<DataDiff>("compare_table_data", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase,
      targetSessionId: params.targetSessionId,
      targetDatabase: params.targetDatabase,
      table: params.table,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.dataDiff, r, "compare_table_data")),
  generateDataSyncSql: (diff: DataDiff, allowDelete: boolean) =>
    invoke<SyncPlan>("generate_data_sync_sql", { diff, allowDelete }).then((r) =>
      parseResponse(schemas.syncPlan, r, "generate_data_sync_sql"),
    ),
  applySyncSql: (params: {
    sessionId: string;
    database?: string | null;
    statements: string[];
  }) =>
    invoke<number>("apply_sync_sql", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      statements: params.statements,
    }).then((r) => parseResponse(schemas.numberResponse, r, "apply_sync_sql")),

  listProfiles: () =>
    invoke<ConnectionProfile[]>("list_profiles").then((r) =>
      parseResponse(schemas.connectionProfileArray, r, "list_profiles"),
    ),
  saveProfile: (req: SaveProfileRequest) =>
    invoke<ConnectionProfile>("save_profile", { req }).then((r) =>
      parseResponse(schemas.connectionProfile, r, "save_profile"),
    ),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  /**
   * 接続プロファイルを **秘密情報抜きで** `path` に JSON 出力する (#442)。`ids`
   * 省略時は全件。返り値は書き込んだバイト数。
   */
  exportProfiles: (path: string, ids?: string[]) =>
    invoke<number>("export_profiles", { path, ids: ids ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "export_profiles"),
    ),
  /**
   * `path` の JSON (`exportProfiles` 出力) を取り込む (#442)。`strategy` は ID 衝突時の
   * 解決方法。秘密情報は含まれないため、取り込んだプロファイルは接続時に資格情報の
   * 再入力が要る。
   */
  importProfiles: (path: string, strategy: ProfileImportStrategy) =>
    invoke<ProfileImportResult>("import_profiles", { path, strategy }).then((r) =>
      parseResponse(schemas.profileImportResult, r, "import_profiles"),
    ),

  listSnippets: () =>
    invoke<Snippet[]>("list_snippets").then((r) =>
      parseResponse(schemas.snippetArray, r, "list_snippets"),
    ),
  saveSnippet: (req: SaveSnippetRequest) =>
    invoke<Snippet>("save_snippet", { req }).then((r) =>
      parseResponse(schemas.snippet, r, "save_snippet"),
    ),
  deleteSnippet: (id: string) => invoke<void>("delete_snippet", { id }),

  listHistory: (params: {
    profileId?: string | null;
    limit?: number | null;
    search?: string | null;
  } = {}) =>
    invoke<HistoryEntry[]>("list_history", {
      profileId: params.profileId ?? null,
      limit: params.limit ?? null,
      search: params.search ?? null,
    }).then((r) => parseResponse(schemas.historyEntryArray, r, "list_history")),
  clearHistory: (profileId?: string | null) =>
    invoke<number>("clear_history", { profileId: profileId ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "clear_history"),
    ),

  readLogs: () =>
    invoke<LogView>("read_logs").then((r) =>
      parseResponse(schemas.logView, r, "read_logs"),
    ),
  clearLogs: () => invoke<void>("clear_logs"),

  exportQueryResult: (params: {
    path: string;
    format: ExportFormat;
    columns: Column[];
    rows: CellValue[][];
  }) =>
    invoke<number>("export_query_result", {
      path: params.path,
      format: params.format,
      columns: params.columns,
      rows: params.rows,
    }).then((r) => parseResponse(schemas.numberResponse, r, "export_query_result")),

  /**
   * クエリを再実行し、全件をストリーミングで直接ファイルへ書き出す (#494)。結果は
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
    }),

  dumpDatabase: (params: {
    sessionId: string;
    database: string;
    path: string;
    options: DumpOptions;
  }) =>
    invoke<number>("dump_database", {
      sessionId: params.sessionId,
      database: params.database,
      path: params.path,
      options: params.options,
    }).then((r) => parseResponse(schemas.numberResponse, r, "dump_database")),

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
    }),
};

export interface QueryStreamColumnsEvent {
  streamId: string;
  columns: Column[];
}

export interface QueryStreamRowsEvent {
  streamId: string;
  rows: CellValue[][];
}

export interface QueryStreamDoneEvent {
  streamId: string;
  totalRows: number;
  rowsAffected: number;
  elapsedMs: number;
  hasColumns: boolean;
  /** Row cap auto-injected for this run, or null when none was applied. */
  appliedAutoLimit: number | null;
}

export interface QueryStreamErrorEvent {
  streamId: string;
  error: string;
  /** True when the run was aborted by the execution-timeout guard. */
  timedOut: boolean;
  /**
   * True when the failure means the DB connection was lost (server closed it,
   * socket broke, network dropped). The session is no longer usable.
   */
  connectionLost: boolean;
}

export interface PreviewStreamMetaEvent {
  streamId: string;
  targetTable: string | null;
  columns: Column[];
  primaryKey: string[];
  rowsAffected: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface PreviewStreamRowsEvent {
  streamId: string;
  rows: CellValue[][];
}

export interface PreviewStreamDoneEvent {
  streamId: string;
}

export interface PreviewStreamErrorEvent {
  streamId: string;
  error: string;
  /**
   * True when the failure means the DB connection was lost (server closed it,
   * socket broke, network dropped). The session is no longer usable.
   */
  connectionLost: boolean;
}

export interface ImportStartedEvent {
  streamId: string;
  total: number;
}

export interface ImportProgressEvent {
  streamId: string;
  inserted: number;
  total: number;
}

export interface ImportDoneEvent {
  streamId: string;
  inserted: number;
  elapsedMs: number;
}

export interface ImportErrorEvent {
  streamId: string;
  error: string;
}

// 全件ストリーミングエクスポート (#494)。
export interface ExportProgressEvent {
  streamId: string;
  rows: number;
}
export interface ExportDoneEvent {
  streamId: string;
  rows: number;
  bytes: number;
}
export interface ExportStreamErrorEvent {
  streamId: string;
  message: string;
}
export interface ExportStreamHandlers {
  onProgress?: (event: ExportProgressEvent) => void;
  onDone?: (event: ExportDoneEvent) => void;
  onError?: (event: ExportStreamErrorEvent) => void;
}

export interface ImportStreamHandlers {
  onStarted?: (event: ImportStartedEvent) => void;
  onProgress?: (event: ImportProgressEvent) => void;
  onDone?: (event: ImportDoneEvent) => void;
  onError?: (event: ImportErrorEvent) => void;
}

export interface QueryStreamHandlers {
  onColumns?: (event: QueryStreamColumnsEvent) => void;
  onRows?: (event: QueryStreamRowsEvent) => void;
  onDone?: (event: QueryStreamDoneEvent) => void;
  onError?: (event: QueryStreamErrorEvent) => void;
}

export interface PreviewStreamHandlers {
  onMeta?: (event: PreviewStreamMetaEvent) => void;
  onBeforeRows?: (event: PreviewStreamRowsEvent) => void;
  onAfterRows?: (event: PreviewStreamRowsEvent) => void;
  onDone?: (event: PreviewStreamDoneEvent) => void;
  onError?: (event: PreviewStreamErrorEvent) => void;
}

/**
 * Subscribes to all query-stream events for `streamId`. Events for other
 * streams are ignored. Returns a function that detaches every listener.
 */
export async function listenQueryStream(
  streamId: string,
  handlers: QueryStreamHandlers,
): Promise<UnlistenFn> {
  const filter =
    <T extends { streamId: string }>(
      schema: Parameters<typeof parseResponse>[0],
      event: string,
      cb?: (e: T) => void,
    ) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) {
        cb(parseResponse(schema, e.payload, event));
      }
    };
  const unlisteners = await Promise.all([
    listen<QueryStreamColumnsEvent>(
      "query-stream:columns",
      filter(schemas.queryStreamColumnsEvent, "query-stream:columns", handlers.onColumns),
    ),
    listen<QueryStreamRowsEvent>(
      "query-stream:rows",
      filter(schemas.streamRowsEventLite, "query-stream:rows", handlers.onRows),
    ),
    listen<QueryStreamDoneEvent>(
      "query-stream:done",
      filter(schemas.queryStreamDoneEvent, "query-stream:done", handlers.onDone),
    ),
    listen<QueryStreamErrorEvent>(
      "query-stream:error",
      filter(schemas.queryStreamErrorEvent, "query-stream:error", handlers.onError),
    ),
  ]);
  return () => unlisteners.forEach((un) => un());
}

export async function listenPreviewStream(
  streamId: string,
  handlers: PreviewStreamHandlers,
): Promise<UnlistenFn> {
  const filter =
    <T extends { streamId: string }>(
      schema: Parameters<typeof parseResponse>[0],
      event: string,
      cb?: (e: T) => void,
    ) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) {
        cb(parseResponse(schema, e.payload, event));
      }
    };
  const unlisteners = await Promise.all([
    listen<PreviewStreamMetaEvent>(
      "preview-stream:meta",
      filter(schemas.previewStreamMetaEvent, "preview-stream:meta", handlers.onMeta),
    ),
    listen<PreviewStreamRowsEvent>(
      "preview-stream:before-rows",
      filter(schemas.streamRowsEventLite, "preview-stream:before-rows", handlers.onBeforeRows),
    ),
    listen<PreviewStreamRowsEvent>(
      "preview-stream:after-rows",
      filter(schemas.streamRowsEventLite, "preview-stream:after-rows", handlers.onAfterRows),
    ),
    listen<PreviewStreamDoneEvent>(
      "preview-stream:done",
      filter(schemas.previewStreamDoneEvent, "preview-stream:done", handlers.onDone),
    ),
    listen<PreviewStreamErrorEvent>(
      "preview-stream:error",
      filter(schemas.previewStreamErrorEvent, "preview-stream:error", handlers.onError),
    ),
  ]);
  return () => unlisteners.forEach((un) => un());
}

/**
 * Subscribes to all csv-import events for `streamId`. Returns a function that
 * detaches every listener.
 */
export async function listenImportStream(
  streamId: string,
  handlers: ImportStreamHandlers,
): Promise<UnlistenFn> {
  const filter =
    <T extends { streamId: string }>(
      schema: Parameters<typeof parseResponse>[0],
      event: string,
      cb?: (e: T) => void,
    ) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) {
        cb(parseResponse(schema, e.payload, event));
      }
    };
  const unlisteners = await Promise.all([
    listen<ImportStartedEvent>(
      "csv-import:started",
      filter(schemas.importStartedEvent, "csv-import:started", handlers.onStarted),
    ),
    listen<ImportProgressEvent>(
      "csv-import:progress",
      filter(schemas.importProgressEvent, "csv-import:progress", handlers.onProgress),
    ),
    listen<ImportDoneEvent>(
      "csv-import:done",
      filter(schemas.importDoneEvent, "csv-import:done", handlers.onDone),
    ),
    listen<ImportErrorEvent>(
      "csv-import:error",
      filter(schemas.importErrorEvent, "csv-import:error", handlers.onError),
    ),
  ]);
  return () => unlisteners.forEach((un) => un());
}

/** 全件ストリーミングエクスポート (#494) の進捗/完了/エラーイベントを購読する。 */
export async function listenExportStream(
  streamId: string,
  handlers: ExportStreamHandlers,
): Promise<UnlistenFn> {
  const filter =
    <T extends { streamId: string }>(
      schema: Parameters<typeof parseResponse>[0],
      event: string,
      cb?: (e: T) => void,
    ) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) {
        cb(parseResponse(schema, e.payload, event));
      }
    };
  const unlisteners = await Promise.all([
    listen<ExportProgressEvent>(
      "export-stream:progress",
      filter(schemas.exportProgressEvent, "export-stream:progress", handlers.onProgress),
    ),
    listen<ExportDoneEvent>(
      "export-stream:done",
      filter(schemas.exportDoneEvent, "export-stream:done", handlers.onDone),
    ),
    listen<ExportStreamErrorEvent>(
      "export-stream:error",
      filter(schemas.exportStreamErrorEvent, "export-stream:error", handlers.onError),
    ),
  ]);
  return () => unlisteners.forEach((un) => un());
}
