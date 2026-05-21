import { invoke } from "@tauri-apps/api/core";

export type DriverKind = "mysql";

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
};
