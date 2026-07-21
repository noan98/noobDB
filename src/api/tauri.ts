import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as schemas from "./schemas";
import { parseResponse } from "./schemas";

/**
 * A backend error carrying the structured `AppError.kind` discriminant (#683).
 *
 * Tauri rejects a command's promise with whatever the backend `AppError`
 * serializes to. Since #683 that is a `{ kind, message }` object rather than a
 * bare string, so `invoke` below normalizes it into this class. `toString()`
 * intentionally returns just `message` (not `"BackendError: <message>"`) so the
 * many existing `String(e)` call sites keep showing the raw backend text
 * unchanged, while newer code can read `.kind` for reliable classification.
 */
export class BackendError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.name = "BackendError";
    this.kind = kind;
    // Restore the prototype chain so `instanceof BackendError` works even when
    // compiled down to older targets (the standard `extends Error` caveat).
    Object.setPrototypeOf(this, BackendError.prototype);
  }
  override toString(): string {
    return this.message;
  }
}

/**
 * Normalizes whatever a rejected IPC promise carries into a {@link BackendError}.
 * Accepts the structured `{ kind, message }` object (current backend), a bare
 * string (legacy/pre-#683 error surfaces and some mocks), or any other value —
 * so every error path ends up with a consistent shape and a usable `.message`.
 */
export function normalizeBackendError(raw: unknown): BackendError {
  if (raw instanceof BackendError) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (typeof o.kind === "string" && typeof o.message === "string") {
      return new BackendError(o.kind, o.message);
    }
    if (raw instanceof Error) {
      return new BackendError("unknown", raw.message);
    }
  }
  if (typeof raw === "string") {
    return new BackendError("unknown", raw);
  }
  return new BackendError("unknown", String(raw));
}

/** The structured `kind` of a caught error, or `null` when it isn't a
 *  {@link BackendError} (e.g. a plain string from an older surface). Lets UI
 *  code classify errors without re-implementing the normalization. */
export function errorKindOf(e: unknown): string | null {
  return e instanceof BackendError ? e.kind : null;
}

/**
 * Typed wrapper around Tauri's `invoke` that normalizes any rejection into a
 * {@link BackendError} (#683). All IPC calls in this module go through here, so
 * the whole frontend receives errors in one consistent shape.
 */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return rawInvoke<T>(cmd, args).catch((raw: unknown) => {
    throw normalizeBackendError(raw);
  });
}

export type DriverKind = "mysql" | "postgres" | "sqlite";

export type SshAuthMethod = "key" | "agent" | "password";

/**
 * Driver-neutral TLS requirement level, mapped on the backend to each driver's
 * native SSL mode (`PgSslMode` / `MySqlSslMode`). Ordered from least to most
 * strict. `prefer` matches the sqlx default (TLS when offered, no verification).
 */
export type SslMode = "disable" | "prefer" | "require" | "verify_ca" | "verify_full";

/** Non-secret TLS settings shared by the connect request and the saved profile. */
export interface TlsSettings {
  /** TLS requirement level. `null`/omitted keeps the driver default. */
  ssl_mode?: SslMode | null;
  /** CA (root) certificate file path used to verify the server certificate. */
  ssl_root_cert?: string | null;
  /** Client certificate file path for mutual TLS (mTLS). */
  ssl_client_cert?: string | null;
  /** Client private key file path for mutual TLS (mTLS). */
  ssl_client_key?: string | null;
}

/** Non-secret session-initialization settings shared by request and profile. */
export interface SessionInitSettings {
  /**
   * Session-initialization SQL run right after each connection is established
   * (e.g. `SET search_path`, `SET time_zone`, `PRAGMA`). Multiple statements
   * may be separated by `;`. Validated on the backend: only SET / PRAGMA or
   * read-only statements are allowed. `null`/omitted runs nothing.
   */
  init_sql?: string | null;
}

export interface SshProfile {
  host: string;
  port: number;
  user: string;
  auth_method: SshAuthMethod;
  private_key_path: string;
}

export interface ConnectionProfile extends TlsSettings, SessionInitSettings {
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

export interface ConnectRequest extends TlsSettings, SessionInitSettings {
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

export interface SaveProfileRequest extends TlsSettings, SessionInitSettings {
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

/** プロファイルインポート時の ID 衝突解決戦略。 */
export type ProfileImportStrategy = "rename" | "skip" | "overwrite";

/** `importProfiles` の結果要約。 */
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

/** テーブル 1 つのインデックス情報。 */
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
}

/** 非テーブルのスキーマオブジェクト種別。 */
export type SchemaObjectKind =
  | "view"
  | "materialized_view"
  | "procedure"
  | "function"
  | "trigger";

/** 非テーブルのスキーマオブジェクト。 */
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
 * テーブルのサイズ・統計 (サイズダッシュボード #562)。すべてエンジンのカタログ
 * 由来でテーブルスキャンを伴わない。各フィールドはエンジンが報告しないことが
 * あるため `null` 許容 (SQLite は概算行数を持たず、dbstat 非搭載ビルドでは
 * サイズも `null`)。`total_bytes` はエンジンの報告値、無ければドライバが解決
 * できたデータ + インデックスの和。
 */
export interface TableSizeInfo {
  name: string;
  row_estimate: number | null;
  data_bytes: number | null;
  index_bytes: number | null;
  total_bytes: number | null;
}

/** サーバ設定/状態の 1 変数 (サーバ情報パネル #563)。値は常に文字列で表示。 */
export interface ServerVariable {
  name: string;
  value: string;
}

/**
 * 接続中サーバの読み取り専用スナップショット (サーバ情報パネル #563)。
 * バージョン文字列と検索可能な設定変数の一覧。アクティブ接続はプロセスモニタ
 * (`ProcessInfo`) が担うためここには含めない。秘密情報・接続文字列は含まない。
 */
export interface ServerInfo {
  version: string;
  variables: ServerVariable[];
}

/**
 * サーバ側プロセス/接続 1 件 (プロセス監視パネル)。MySQL は processlist、
 * PostgreSQL は pg_stat_activity に対応する。`id` をそのまま `killProcess` に渡す。
 */
export interface ProcessInfo {
  id: number;
  user: string | null;
  host: string | null;
  database: string | null;
  /** 粗い活動状態: MySQL COMMAND (Query/Sleep/…) / PostgreSQL state (active/idle/…)。 */
  command: string | null;
  /** 詳細状態: MySQL STATE / PostgreSQL wait_event。 */
  state: string | null;
  time_secs: number | null;
  query: string | null;
  /**
   * この行が一覧クエリを実行した接続自身 (= 本アプリのプール接続) のとき true。
   * kill するとアプリのセッションが切断されるため、UI は警告を出す。ベスト
   * エフォート: 同じプールの別接続までは判別できない。
   */
  is_self: boolean;
}

/** One trusted SSH host from known_hosts (`host:port` + fingerprint). #682. */
export interface KnownHost {
  host: string;
  port: number;
  fingerprint: string;
}

/**
 * ライブクエリ・インスペクタ (#746) の前提可否。使えない機能には機械可読な
 * 理由コード (`unsupported_driver` / `performance_schema_off` /
 * `statements_consumer_off` / `statements_digest_off` /
 * `pg_stat_statements_missing` / `stats_unreadable`) が付き、UI は有効化手順
 * つきのヘルプ文言にマップして縮退表示する (黙って空にしない)。
 */
export interface QueryStatsSupport {
  live_tail: boolean;
  statements: boolean;
  live_tail_reason: string | null;
  statements_reason: string | null;
}

/**
 * ライブテールの 1 イベント: サーバが観測した実行中/直近ステートメント
 * (#746)。`key` はポーリング横断の重複排除キー。自セッション由来と noobDB
 * 内部クエリはバックエンドで除外済み (同一プールの別物理接続はベストエフォート)。
 */
export interface LiveQuery {
  key: string;
  query: string;
  user: string | null;
  host: string | null;
  database: string | null;
  /** PostgreSQL の application_name。MySQL は null。 */
  application: string | null;
  /** 実行済みは所要時間、実行中はサンプル時点までの経過 (ms)。 */
  duration_ms: number | null;
  /** MySQL ROWS_EXAMINED。PostgreSQL は null。 */
  rows_examined: number | null;
  running: boolean;
  /** クエリ開始時刻 (エポック ms)。PostgreSQL のみ。 */
  started_at_ms: number | null;
}

/**
 * digest (フィンガープリント) 単位の**累積**統計 1 行 (#746)。カウンタは
 * サーバの統計リセット以降の累積値で、「記録開始からの差分」は
 * `components/queryInspector.ts` の純ロジックが 2 スナップショットの引き算で
 * 求める。`max_time_ms` は高水位マークで差分計算できない点に注意。
 */
export interface StatementStat {
  digest: string;
  fingerprint: string;
  database: string | null;
  calls: number;
  total_time_ms: number;
  max_time_ms: number;
  /** MySQL は走査行数 (SUM_ROWS_EXAMINED)、PostgreSQL は返却/影響行数。 */
  rows: number | null;
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

/** Result of comparing a source schema against a target schema. */
export interface SchemaDiff {
  source_driver: DriverKind;
  target_driver: DriverKind;
  tables: TableDiff[];
}

/** What a generated sync statement does. */
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

/** Where a row sits relative to the two tables. */
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
  /** `columns` と同じ並びの型名。BLOB 列を復元して sql_literal の補正に使う (修正3)。 */
  column_types: string[];
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

export type ExportFormat = "csv" | "json" | "ndjson" | "markdown" | "sql";

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
  /**
   * All drivers — reformat the written SQL with the backend formatter for
   * readability. Off by default (backward compatible: output stays as produced
   * by the server / generator). Best-effort; intended for review/version control.
   */
  formatSql?: boolean;
}

/**
 * Source data format for an import. CSV uses the delimiter/quote/header options;
 * JSON (array of objects) and NDJSON (one object per line) key rows by field
 * name and ignore those options. Defaults to "csv" on the backend if omitted.
 */
export type ImportFormat = "csv" | "json" | "ndjson";

/** How the importer handles rows the database rejects (#687). */
export type ImportErrorMode = "abort" | "skip";

export interface ImportOptions {
  /** Source format. Omit/`"csv"` for the classic CSV path. */
  format?: ImportFormat;
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
  /**
   * Row-error handling (#687). `"abort"` (default) rolls the whole import back
   * on the first bad row; `"skip"` drops bad rows and reports them at the end.
   * Omitted → the backend default (`"abort"`).
   */
  errorMode?: ImportErrorMode;
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
  /**
   * Test a connection. `attemptId` (a fresh id per attempt) lets the caller
   * subscribe to `connect-progress:phase` events and cancel via `cancelConnect`;
   * `timeoutSecs` bounds the whole attempt (backend clamps + defaults). #684.
   */
  testConnection: (req: ConnectRequest, attemptId?: string, timeoutSecs?: number) =>
    invoke<string>("test_connection", {
      req,
      attemptId: attemptId ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.stringResponse, r, "test_connection")),
  connect: (req: ConnectRequest, attemptId?: string, timeoutSecs?: number) =>
    invoke<{ session_id: string }>("connect", {
      req,
      attemptId: attemptId ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.connectResult, r, "connect")),
  /** Cancel an in-flight connect / test-connection attempt by its id (#684). */
  cancelConnect: (attemptId: string) =>
    invoke<boolean>("cancel_connect", { attemptId }),
  disconnect: (sessionId: string) =>
    invoke<void>("disconnect", { sessionId }),
  /**
   * 切断されたセッションをその場で張り直す (#712)。同じ `sessionId` のまま SSH
   * トンネルを再構築し、`connect_options` から新しい接続を確立してセッションを
   * 差し替える。id が変わらないため、開いているタブ・グリッド状態はそのまま生きる。
   * 失敗時は旧セッションを壊さずに reject する。
   */
  reconnect: (sessionId: string) => invoke<void>("reconnect", { sessionId }),
  /**
   * 接続のヘルスチェック。生きていれば true、死んでいれば (スリープ復帰や
   * トンネル断) false。セッションが見つからない場合のみ reject する。
   */
  pingSession: (sessionId: string) => invoke<boolean>("ping_session", { sessionId }),
  /**
   * List the SSH known_hosts entries (host:port + fingerprint). Backs the
   * Settings known_hosts panel and the host-key mismatch recovery flow (#682).
   */
  listKnownHosts: () =>
    invoke<KnownHost[]>("list_known_hosts").then((r) =>
      parseResponse(schemas.knownHostArray, r, "list_known_hosts"),
    ),
  /**
   * Forget the known_hosts entry for `host:port`, so the next connection
   * re-trusts the server's (possibly rotated) key via TOFU. Resolves to `true`
   * when an entry was actually removed (#682).
   */
  forgetHostKey: (host: string, port: number) =>
    invoke<boolean>("forget_host_key", { host, port }),
  /**
   * Pin `host:port` to exactly `fingerprint`, replacing any existing entry. The
   * host-key mismatch recovery flow passes the fingerprint the user approved in
   * the dialog, then reconnects — so the reconnect is verified against that
   * pinned key and a different (MITM) key is rejected instead of TOFU-accepted
   * (#682 review follow-up).
   */
  trustHostKey: (host: string, port: number, fingerprint: string) =>
    invoke<void>("trust_host_key", { host, port, fingerprint }),
  /** 明示トランザクションを開始する。 */
  beginTransaction: (sessionId: string, database?: string | null) =>
    invoke<void>("begin_transaction", { sessionId, database: database ?? null }),
  /** 明示トランザクション内で 1 文を実行する。 */
  runInTransaction: (sessionId: string, sql: string) =>
    invoke<QueryResult>("run_in_transaction", { sessionId, sql }).then((r) =>
      parseResponse(schemas.queryResult, r, "run_in_transaction"),
    ),
  /** 明示トランザクションを確定 (commit=true) / 破棄 (false) する。 */
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
  /**
   * Aborts the streaming task registered under `streamId` (query/preview/
   * export/import all share this). `deliveredRows` is how many rows had
   * already reached the frontend before the abort — used to tell a partial
   * result apart from a complete one (#685). `cancelled` is false when the
   * stream had already finished (or never existed), mirroring the old
   * boolean-only contract.
   */
  cancelStream: (streamId: string) =>
    invoke<CancelStreamResult>("cancel_stream", { streamId }).then((r) =>
      parseResponse(schemas.cancelStreamResponse, r, "cancel_stream"),
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
  /** テーブルごとのサイズ・統計を取得する (サイズダッシュボード #562)。 */
  tableSizes: (sessionId: string, database: string) =>
    invoke<TableSizeInfo[]>("table_sizes", { sessionId, database }).then((r) =>
      parseResponse(schemas.tableSizeInfoArray, r, "table_sizes"),
    ),
  /** 接続中サーバの情報 (バージョン + 設定変数) を取得する (サーバ情報パネル #563)。 */
  serverInfo: (sessionId: string) =>
    invoke<ServerInfo>("server_info", { sessionId }).then((r) =>
      parseResponse(schemas.serverInfo, r, "server_info"),
    ),
  /** テーブルのインデックス一覧を取得する。 */
  listIndexes: (sessionId: string, database: string, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { sessionId, database, table }).then((r) =>
      parseResponse(schemas.indexInfoArray, r, "list_indexes"),
    ),
  /** サーバ側プロセス/接続の一覧を取得する (プロセス監視パネル)。SQLite は非対応。 */
  listProcesses: (sessionId: string) =>
    invoke<ProcessInfo[]>("list_processes", { sessionId }).then((r) =>
      parseResponse(schemas.processInfoArray, r, "list_processes"),
    ),
  /** プロセス/接続を強制終了する。read_only セッションはバックエンドで拒否される。 */
  killProcess: (sessionId: string, processId: number) =>
    invoke<void>("kill_process", { sessionId, processId }),
  /** ライブクエリ・インスペクタ (#746) の前提可否プローブ。理由コード付きで縮退情報を返す。 */
  queryStatsSupport: (sessionId: string) =>
    invoke<QueryStatsSupport>("query_stats_support", { sessionId }).then((r) =>
      parseResponse(schemas.queryStatsSupport, r, "query_stats_support"),
    ),
  /** ライブテール 1 サンプル (実行中/直近ステートメント) を取得する。読み取り SELECT のみ。 */
  sampleLiveQueries: (sessionId: string) =>
    invoke<LiveQuery[]>("sample_live_queries", { sessionId }).then((r) =>
      parseResponse(schemas.liveQueryArray, r, "sample_live_queries"),
    ),
  /** digest 単位の累積統計スナップショットを取得する。差分計算はフロント純ロジックが担う。 */
  sampleStatementStats: (sessionId: string) =>
    invoke<StatementStat[]>("sample_statement_stats", { sessionId }).then((r) =>
      parseResponse(schemas.statementStatArray, r, "sample_statement_stats"),
    ),
  /** 非テーブルのスキーマオブジェクト (ビュー/ルーチン/トリガー) を取得する。 */
  listSchemaObjects: (sessionId: string, database: string) =>
    invoke<SchemaObject[]>("list_schema_objects", { sessionId, database }).then((r) =>
      parseResponse(schemas.schemaObjectArray, r, "list_schema_objects"),
    ),
  /** スキーマオブジェクトの定義 (DDL) を取得する。`id` は同名衝突を避ける一意識別子。 */
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
   * 接続プロファイルを **秘密情報抜きで** `path` に JSON 出力する。`ids`
   * 省略時は全件。返り値は書き込んだバイト数。
   */
  exportProfiles: (path: string, ids?: string[]) =>
    invoke<number>("export_profiles", { path, ids: ids ?? null }).then((r) =>
      parseResponse(schemas.numberResponse, r, "export_profiles"),
    ),
  /**
   * `path` の JSON (`exportProfiles` 出力) を取り込む。`strategy` は ID 衝突時の
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
    /** JSON 形式のとき出力に同梱する実行クエリ。null/未指定なら同梱しない。 */
    query?: string | null;
    /** SQL 形式のときの対象テーブル名・ドライバ・バッチサイズ。他形式では無視。 */
    table?: string | null;
    driver?: string | null;
    batchSize?: number | null;
  }) =>
    invoke<number>("export_query_result", {
      path: params.path,
      format: params.format,
      columns: params.columns,
      rows: params.rows,
      query: params.query ?? null,
      table: params.table ?? null,
      driver: params.driver ?? null,
      batchSize: params.batchSize ?? null,
    }).then((r) => parseResponse(schemas.numberResponse, r, "export_query_result")),

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
    }),

  /**
   * Start a streaming, cancelable database dump (#686). Returns once the dump
   * has been kicked off; progress + completion arrive via `dump-stream:*` events
   * (subscribe with {@link listenDumpStream}) keyed by `streamId`. Cancel via
   * {@link api.cancelStream}.
   */
  dumpDatabase: (params: {
    sessionId: string;
    streamId: string;
    database: string;
    path: string;
    options: DumpOptions;
  }) =>
    invoke<void>("dump_database", {
      sessionId: params.sessionId,
      streamId: params.streamId,
      database: params.database,
      path: params.path,
      options: params.options,
    }),

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

  /**
   * ドロップされた `.sql` / `.txt` ファイルの内容を読む。フロントが fs API を
   * 直に叩かずバックエンド経由で読む (capabilities を最小に保つ)。サイズ上限を超える
   * ファイルは reject される。
   */
  readTextFile: (path: string) =>
    invoke<string>("read_text_file", { path }).then((r) =>
      parseResponse(schemas.stringResponse, r, "read_text_file"),
    ),

  /**
   * フロントで生成したバイト列 (チャート/ER 図の PNG・SVG など) を、保存ダイアログで
   * 選んだパスへバックエンド経由で書き出す (capabilities を最小に保つため。#643)。
   * 書き込んだバイト数を返す。
   */
  writeBinaryFile: (path: string, data: Uint8Array) =>
    invoke<number>("write_binary_file", { path, data: Array.from(data) }).then((r) =>
      parseResponse(schemas.numberResponse, r, "write_binary_file"),
    ),
};

/** `cancelStream` の戻り値 (#685)。`cancelled` が `false` のときはストリームが
 *  既に終わっていた (または存在しなかった) ことを意味し、`deliveredRows` は 0。 */
export interface CancelStreamResult {
  cancelled: boolean;
  deliveredRows: number;
}

/** キャンセル成立時に `query-stream:cancelled` / `preview-stream:cancelled` /
 *  `export-stream:cancelled` として届く共通ペイロード (#685)。 */
export interface StreamCancelledEvent {
  streamId: string;
  deliveredRows: number;
}

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
  /** Rows already delivered to the frontend before the run failed (#685). */
  deliveredRows: number;
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
  /** Rows already delivered to the frontend before the run failed (#685). */
  deliveredRows: number;
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

/** One skipped row in a skip-mode import (#687). */
export interface SkippedRowInfo {
  /** 1-based record number among data records. */
  record: number;
  /** Source file line (CSV only; null for JSON/NDJSON). */
  line: number | null;
  reason: string;
}

export interface ImportDoneEvent {
  streamId: string;
  inserted: number;
  elapsedMs: number;
  /** Rows skipped in skip mode (empty in abort mode). #687. */
  skipped: SkippedRowInfo[];
}

export interface ImportErrorEvent {
  streamId: string;
  error: string;
  /** For an abort-mode failure, the pinpointed record number + CSV line (#687). */
  record: number | null;
  line: number | null;
}

// 全件ストリーミングエクスポート。
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
  /** Rows already written to the output file before the run failed (#685).
   *  Informational only — a failed/cancelled export always discards its
   *  partial output file. */
  rows: number;
}
export interface ExportStreamHandlers {
  onProgress?: (event: ExportProgressEvent) => void;
  onDone?: (event: ExportDoneEvent) => void;
  onError?: (event: ExportStreamErrorEvent) => void;
  /** Fired when `cancelStream` claims this export (#685). See
   *  `StreamCancelledEvent` — the frontend's own cancel flow reads
   *  `deliveredRows` off `cancelStream`'s return value instead, since it
   *  detaches its listeners before invoking it; this is for other consumers. */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

export interface DumpProgressEvent {
  streamId: string;
  bytes: number;
  elapsedMs: number;
  /** Processed / total tables for the SQLite path; null for external tools. */
  tables: number | null;
  tablesTotal: number | null;
}
export interface DumpDoneEvent {
  streamId: string;
  bytes: number;
  elapsedMs: number;
}
export interface DumpStreamErrorEvent {
  streamId: string;
  error: string;
}
export interface DumpStreamHandlers {
  onProgress?: (event: DumpProgressEvent) => void;
  onDone?: (event: DumpDoneEvent) => void;
  onError?: (event: DumpStreamErrorEvent) => void;
  /** Fired when `cancelStream` claims this dump (#686). `deliveredRows` carries
   *  bytes written so far. The frontend's own cancel flow reads that off
   *  `cancelStream`'s return value instead. */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

export interface ImportStreamHandlers {
  onStarted?: (event: ImportStartedEvent) => void;
  onProgress?: (event: ImportProgressEvent) => void;
  onDone?: (event: ImportDoneEvent) => void;
  onError?: (event: ImportErrorEvent) => void;
  /** Skip-mode import auto-commits chunks, so a cancel can leave rows persisted;
   *  `deliveredRows` carries the committed count. See `ExportStreamHandlers`
   *  (#685/#687). */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

export interface QueryStreamHandlers {
  onColumns?: (event: QueryStreamColumnsEvent) => void;
  onRows?: (event: QueryStreamRowsEvent) => void;
  onDone?: (event: QueryStreamDoneEvent) => void;
  onError?: (event: QueryStreamErrorEvent) => void;
  /** See `ExportStreamHandlers.onCancelled` (#685). */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

export interface PreviewStreamHandlers {
  onMeta?: (event: PreviewStreamMetaEvent) => void;
  onBeforeRows?: (event: PreviewStreamRowsEvent) => void;
  onAfterRows?: (event: PreviewStreamRowsEvent) => void;
  onDone?: (event: PreviewStreamDoneEvent) => void;
  onError?: (event: PreviewStreamErrorEvent) => void;
  /** See `ExportStreamHandlers.onCancelled` (#685). */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

/**
 * Await a set of `listen()` registrations failure-safe: if any registration
 * rejects, unlisten every one that already resolved before rethrowing, so a
 * partial failure never leaks a live listener. On success, returns a single
 * unlisten function that detaches all of them. The registration promises are
 * passed already-started, so they still register concurrently.
 */
async function registerListeners(
  registrations: Array<Promise<UnlistenFn>>,
): Promise<UnlistenFn> {
  const settled = await Promise.allSettled(registrations);
  const unlisteners: UnlistenFn[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") unlisteners.push(r.value);
  }
  const failure = settled.find((r) => r.status === "rejected");
  if (failure) {
    unlisteners.forEach((un) => un());
    throw (failure as PromiseRejectedResult).reason;
  }
  return () => unlisteners.forEach((un) => un());
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
  return registerListeners([
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
    listen<StreamCancelledEvent>(
      "query-stream:cancelled",
      filter(schemas.streamCancelledEvent, "query-stream:cancelled", handlers.onCancelled),
    ),
  ]);
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
  return registerListeners([
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
    listen<StreamCancelledEvent>(
      "preview-stream:cancelled",
      filter(schemas.streamCancelledEvent, "preview-stream:cancelled", handlers.onCancelled),
    ),
  ]);
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
  return registerListeners([
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
    // Skip-mode import auto-commits each chunk, so a cancel can leave rows
    // persisted; the backend emits `csv-import:cancelled` carrying that count
    // (`deliveredRows`). Subscribe for parity with the other streams (#687).
    listen<StreamCancelledEvent>(
      "csv-import:cancelled",
      filter(schemas.streamCancelledEvent, "csv-import:cancelled", handlers.onCancelled),
    ),
  ]);
}

/** 全件ストリーミングエクスポートの進捗/完了/エラーイベントを購読する。 */
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
  return registerListeners([
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
    listen<StreamCancelledEvent>(
      "export-stream:cancelled",
      filter(schemas.streamCancelledEvent, "export-stream:cancelled", handlers.onCancelled),
    ),
  ]);
}

/** ストリーミングダンプの進捗/完了/エラー/キャンセルイベントを購読する (#686)。 */
export async function listenDumpStream(
  streamId: string,
  handlers: DumpStreamHandlers,
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
  return registerListeners([
    listen<DumpProgressEvent>(
      "dump-stream:progress",
      filter(schemas.dumpProgressEvent, "dump-stream:progress", handlers.onProgress),
    ),
    listen<DumpDoneEvent>(
      "dump-stream:done",
      filter(schemas.dumpDoneEvent, "dump-stream:done", handlers.onDone),
    ),
    listen<DumpStreamErrorEvent>(
      "dump-stream:error",
      filter(schemas.dumpErrorEvent, "dump-stream:error", handlers.onError),
    ),
    listen<StreamCancelledEvent>(
      "dump-stream:cancelled",
      filter(schemas.dumpCancelledEvent, "dump-stream:cancelled", handlers.onCancelled),
    ),
  ]);
}

/** One phase of a connection attempt (#684). `phase` is a stable label:
 *  "preparing" / "tunnel_connecting" / "tunnel_authenticating" / "db_connecting". */
export interface ConnectPhaseEvent {
  attemptId: string;
  phase: string;
}

/**
 * Subscribe to `connect-progress:phase` events for a given connection attempt,
 * filtered by `attemptId`. Lets the UI show which phase a slow connect is in
 * (#684). Returns an unlisten function.
 */
export async function listenConnectProgress(
  attemptId: string,
  onPhase: (phase: string) => void,
): Promise<UnlistenFn> {
  return listen<ConnectPhaseEvent>("connect-progress:phase", (e) => {
    const payload = parseResponse(
      schemas.connectPhaseEvent,
      e.payload,
      "connect-progress:phase",
    );
    if (payload.attemptId === attemptId) onPhase(payload.phase);
  });
}
