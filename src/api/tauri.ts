import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type DriverKind = "mysql" | "postgres" | "sqlite";

export interface SshProfile {
  host: string;
  port: number;
  user: string;
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
   * When true, sessions opened from this profile reject any SQL that is
   * not strictly read-only (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH).
   */
  read_only: boolean;
  /** Database file path for file-backed drivers (SQLite). */
  file_path: string | null;
}

export interface SshRequest extends SshProfile {
  passphrase?: string;
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
  group: string | null;
  color: string | null;
  is_production: boolean;
  read_only: boolean;
  /** Required for sqlite; ignored otherwise. */
  file_path?: string | null;
}

export interface SessionInfo {
  id: string;
  profile_id: string | null;
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
}

export type ExportFormat = "csv" | "json";

export const api = {
  testConnection: (req: ConnectRequest) =>
    invoke<string>("test_connection", { req }),
  connect: (req: ConnectRequest) =>
    invoke<{ session_id: string }>("connect", { req }),
  disconnect: (sessionId: string) =>
    invoke<void>("disconnect", { sessionId }),
  listSessions: () => invoke<SessionInfo[]>("list_sessions"),

  runQuery: (sessionId: string, sql: string, database?: string | null) =>
    invoke<QueryResult>("run_query", { sessionId, sql, database: database ?? null }),
  previewQuery: (sessionId: string, sql: string, database?: string | null) =>
    invoke<PreviewResult>("preview_query", { sessionId, sql, database: database ?? null }),

  runQueryStream: (params: {
    sessionId: string;
    streamId: string;
    sql: string;
    database?: string | null;
    initialBatch: number;
    chunkSize: number;
  }) =>
    invoke<void>("run_query_stream", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      sql: params.sql,
      database: params.database ?? null,
      initialBatch: params.initialBatch,
      chunkSize: params.chunkSize,
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
    invoke<boolean>("cancel_stream", { streamId }),

  listDatabases: (sessionId: string) =>
    invoke<string[]>("list_databases", { sessionId }),
  listTables: (sessionId: string, database: string) =>
    invoke<string[]>("list_tables", { sessionId, database }),
  describeTable: (sessionId: string, database: string, table: string) =>
    invoke<TableColumnInfo[]>("describe_table", { sessionId, database, table }),

  listProfiles: () => invoke<ConnectionProfile[]>("list_profiles"),
  saveProfile: (req: SaveProfileRequest) =>
    invoke<ConnectionProfile>("save_profile", { req }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),

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
}

export interface QueryStreamErrorEvent {
  streamId: string;
  error: string;
}

export interface PreviewStreamMetaEvent {
  streamId: string;
  targetTable: string | null;
  columns: Column[];
  primaryKey: string[];
  rowsAffected: number;
  elapsedMs: number;
  truncated: boolean;
  beforeTotal: number;
  afterTotal: number;
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
    <T extends { streamId: string }>(cb?: (e: T) => void) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) cb(e.payload);
    };
  const unlisteners = await Promise.all([
    listen<QueryStreamColumnsEvent>("query-stream:columns", filter(handlers.onColumns)),
    listen<QueryStreamRowsEvent>("query-stream:rows", filter(handlers.onRows)),
    listen<QueryStreamDoneEvent>("query-stream:done", filter(handlers.onDone)),
    listen<QueryStreamErrorEvent>("query-stream:error", filter(handlers.onError)),
  ]);
  return () => unlisteners.forEach((un) => un());
}

export async function listenPreviewStream(
  streamId: string,
  handlers: PreviewStreamHandlers,
): Promise<UnlistenFn> {
  const filter =
    <T extends { streamId: string }>(cb?: (e: T) => void) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) cb(e.payload);
    };
  const unlisteners = await Promise.all([
    listen<PreviewStreamMetaEvent>("preview-stream:meta", filter(handlers.onMeta)),
    listen<PreviewStreamRowsEvent>("preview-stream:before-rows", filter(handlers.onBeforeRows)),
    listen<PreviewStreamRowsEvent>("preview-stream:after-rows", filter(handlers.onAfterRows)),
    listen<PreviewStreamDoneEvent>("preview-stream:done", filter(handlers.onDone)),
    listen<PreviewStreamErrorEvent>("preview-stream:error", filter(handlers.onError)),
  ]);
  return () => unlisteners.forEach((un) => un());
}
