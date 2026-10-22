import { Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as schemas from "./schemas";
import { parseResponse } from "./schemas";
import {
  aiStreamChannels,
  batchStreamChannels,
  broadcastChannels,
  dataSearchChannels,
  previewStreamChannels,
  queryStreamChannels,
  whereUsedChannels,
} from "./streamChannels";
import { connectionCommands } from "./commands/connection";
import { localCommands } from "./commands/local";
import { sshCommands } from "./commands/ssh";
import { queryCommands } from "./commands/query";
import { bulkWriteCommands } from "./commands/bulkWrite";
import { broadcastCommands } from "./commands/broadcast";
import { schemaCommands } from "./commands/schema";
import { tableOpenCommands } from "./commands/tableOpen";
import { schemaTreeCommands } from "./commands/schemaTree";
import { serverCommands } from "./commands/server";
import { advisorCommands } from "./commands/advisor";
import { processCommands } from "./commands/process";
import { inspectorCommands } from "./commands/inspector";
import { profileCommands } from "./commands/profile";
import { searchCommands } from "./commands/search";
import { diffCommands } from "./commands/diff";
import { syncCommands } from "./commands/sync";
import { privilegesCommands } from "./commands/privileges";
import { sandboxCommands } from "./commands/sandbox";
import { profilesCommands } from "./commands/profiles";
import { profileBackupCommands } from "./commands/profileBackup";
import { snippetsCommands } from "./commands/snippets";
import { assertionsCommands } from "./commands/assertions";
import { historyCommands } from "./commands/history";
import { logsCommands } from "./commands/logs";
import { exportCommands } from "./commands/export";
import { resultCommands } from "./commands/result";
import { dumpCommands } from "./commands/dump";
import { dumpToolsCommands } from "./commands/dumpTools";
import { importCommands } from "./commands/import";
import { importTemplatesCommands } from "./commands/importTemplates";
import { scriptCommands } from "./commands/script";
import { transferCommands } from "./commands/transfer";
import { fileCommands } from "./commands/file";
import { windowCommands } from "./commands/window";
import { cellBlobCommands } from "./commands/cellBlob";
import { flightRecorderCommands } from "./commands/flightRecorder";
import { timelapseCommands } from "./commands/timelapse";
import { schemaDriftCommands } from "./commands/schemaDrift";
import { planWatchCommands } from "./commands/planWatch";
import { tasksCommands } from "./commands/tasks";
import { aiCommands } from "./commands/ai";

// エラー正規化は `./invoke.ts` に置く。既存の呼び出し側 (`from "../api/tauri"`) を
// 変えないためにここから再エクスポートする。
export { BackendError, errorKindOf, normalizeBackendError } from "./invoke";
import type { MatchMode } from "../components/dataSearch";

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

/**
 * AWS RDS / Aurora IAM database authentication settings (#734). Non-secret:
 * only the region and the AWS profile *name* are stored — the AWS access keys
 * are read by the backend from the environment / `~/.aws/credentials` at
 * connect time and never saved by noobDB (neither in profiles.json nor in the
 * keyring). The backend generates a fresh 15-minute RDS auth token per new
 * physical connection and forces TLS (`require` or stricter).
 */
export interface AwsIamConfig {
  /** AWS region (e.g. `ap-northeast-1`). Empty = infer from the RDS endpoint name / `AWS_REGION`. */
  region: string;
  /** Profile name in `~/.aws/credentials` / `~/.aws/config`. `null` = AWS default resolution. */
  profile?: string | null;
}

/** Auth method selector shared by the connect request and the saved profile. */
export interface AwsIamSettings {
  /** `null`/omitted = classic password auth; set = AWS IAM auth (MySQL / PostgreSQL only). */
  aws_iam?: AwsIamConfig | null;
}

/**
 * AWS Systems Manager (SSM) Session Manager port-forwarding settings (#1683) —
 * an alternative to the SSH tunnel, mutually exclusive with `ssh` (the backend
 * rejects both). All fields are non-secret: authentication is resolved by the AWS
 * CLI (`aws ssm start-session`), which must be on PATH together with the Session
 * Manager plugin.
 */
export interface SsmConfig {
  /** Bastion EC2 instance ID (`i-0123456789abcdef0`) or managed node ID (`mi-...`). Required. */
  target: string;
  /** AWS region. Empty = infer from the RDS endpoint name, then `AWS_REGION` / `AWS_DEFAULT_REGION`. */
  region: string;
  /** AWS CLI `--profile` name. `null`/omitted = AWS default resolution. */
  profile?: string | null;
}

/** SSM port-forwarding selector shared by the connect request and the saved profile. */
export interface SsmSettings {
  /** `null`/omitted = no SSM; set = connect through SSM port forwarding (not for SQLite). */
  ssm?: SsmConfig | null;
}

/**
 * The bastion/jump hop of a 2-hop SSH tunnel (#708). Structurally the same
 * shape as {@link SshProfile} minus its own `jump` — chains are capped at one
 * bastion hop (2 SSH hops total) for now.
 */
export interface SshJumpProfile {
  host: string;
  port: number;
  user: string;
  auth_method: SshAuthMethod;
  private_key_path: string;
}

export interface SshProfile {
  host: string;
  port: number;
  user: string;
  auth_method: SshAuthMethod;
  private_key_path: string;
  /**
   * Optional bastion/jump hop dialed *before* this one (#708 multi-hop
   * tunnel, ProxyJump-equivalent). `null`/omitted for a direct (single-hop)
   * tunnel, including every profile saved before this field existed.
   */
  jump?: SshJumpProfile | null;
  /**
   * Fixed local listen port of the tunnel (#1630). `null`/omitted/0 = let the OS
   * pick a free port (the previous behavior).
   */
  local_port?: number | null;
}

export interface ConnectionProfile extends TlsSettings, SessionInitSettings, AwsIamSettings, SsmSettings {
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
   * Whether a DB password is stored in the OS keyring for this profile. This
   * flag drives the masked "password is set" indicator in the connection form.
   * The value itself is never carried by the profile payload — reading it takes
   * an explicit `revealProfileSecret` call (#938). Present only on profiles
   * returned by `list_profiles`.
   */
  has_db_password?: boolean;
  /** Whether an SSH key passphrase is stored in the keyring. See `has_db_password`. */
  has_ssh_passphrase?: boolean;
  /** Whether an SSH password is stored in the keyring. See `has_db_password`. */
  has_ssh_password?: boolean;
  /** Whether a jump/bastion hop passphrase is stored (#708). */
  has_ssh_jump_passphrase?: boolean;
  /** Whether a jump/bastion hop password is stored (#708). */
  has_ssh_jump_password?: boolean;
}

/**
 * Which stored secret `revealProfileSecret` should read (#938). The literals
 * match the `has_*` flags above one-for-one, and the backend maps them to the
 * keyring entry names (`ssh_jump_*` live under a `_hop0` suffix, see #708).
 */
export type ProfileSecretKind =
  | "db_password"
  | "ssh_passphrase"
  | "ssh_password"
  | "ssh_jump_passphrase"
  | "ssh_jump_password";

/** The bastion/jump hop of a connect request, carrying its own credentials. */
export interface SshJumpRequest extends SshJumpProfile {
  passphrase?: string;
  password?: string;
}

export interface SshRequest extends Omit<SshProfile, "jump"> {
  passphrase?: string;
  password?: string;
  jump?: SshJumpRequest | null;
}

/**
 * What `resolveSshConfigHost` can prefill from a `~/.ssh/config` `Host` alias
 * (#708). `jump_*` fields are only present when the alias's `ProxyJump`
 * directive could be parsed into a `host[:port]`.
 */
export interface ResolvedSshAlias {
  host_name: string | null;
  port: number | null;
  user: string | null;
  identity_file: string | null;
  jump_host: string | null;
  jump_port: number | null;
  jump_user: string | null;
}

export interface ConnectRequest extends TlsSettings, SessionInitSettings, AwsIamSettings, SsmSettings {
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

export interface SaveProfileRequest extends TlsSettings, SessionInitSettings, AwsIamSettings, SsmSettings {
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
  /** Jump/bastion hop secrets (#708); same `undefined`/empty-clears semantics. */
  ssh_jump_passphrase?: string;
  ssh_jump_password?: string;
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

/** `importProfilesEncrypted` の結果要約 (#710)。`secrets` は keyring へ書き戻した件数。 */
export interface EncryptedProfileImportResult extends ProfileImportResult {
  secrets: number;
}

/** `exportProfilesEncrypted` の結果要約 (#710)。件数のみで秘密の値は含まない。 */
export interface EncryptedProfileExportResult {
  profiles: number;
  secrets: number;
  bytes: number;
  /** 書き出し直後に読み直して復号・件数を確認済み (#1624)。成功応答では常に true。 */
  verified: boolean;
  /** 世代管理で削除した古い世代の数 (#1624)。 */
  generations_pruned: number;
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

/** データ品質アサーション (#742) の `row_count` 比較演算子。 */
export type RowCountOp = "gt" | "gte" | "lt" | "lte" | "eq" | "between";

/**
 * データ品質アサーションのルール本体 (#742)。Rust の `AssertionRule`
 * (`#[serde(tag = "kind")]`) のミラーで、フィールド名は snake_case のまま。
 * 値 (`values` / `min` / `max`) は入力された文字列のまま保持し、リテラル化は
 * 実行時にバックエンドがドライバ別に行う。
 */
export type AssertionRule =
  | { kind: "not_null"; column: string }
  | { kind: "unique"; columns: string[] }
  | { kind: "accepted_values"; column: string; values: string[] }
  | { kind: "range"; column: string; min: string | null; max: string | null }
  | {
      kind: "referential";
      columns: string[];
      ref_schema: string | null;
      ref_table: string;
      ref_columns: string[];
    }
  | { kind: "row_count"; op: RowCountOp; value: number; max: number | null }
  /** 違反行を返す読み取り専用 SELECT。0 行なら pass (#1477)。 */
  | { kind: "custom_sql"; sql: string };

/** 保存済みのデータ品質アサーション (#742)。 */
export interface Assertion {
  id: string;
  name: string;
  scope: SnippetScope;
  schema: string | null;
  table: string;
  rule: AssertionRule;
}

export interface SaveAssertionRequest {
  /** 未指定/空なら新規採番。 */
  id?: string;
  name: string;
  scope: SnippetScope;
  schema: string | null;
  table: string;
  rule: AssertionRule;
}

/** ルールから生成した読み取り専用 SQL (#742)。 */
export interface AssertionSql {
  /** 件数 (違反件数、row_count は総行数) を返す集計クエリ。 */
  check_sql: string;
  /** 違反行を表示するクエリ (fail から新規タブで開く)。 */
  violations_sql: string;
}

/** 1 件の検証結果 (#742)。 */
export interface AssertionOutcome extends AssertionSql {
  id: string;
  passed: boolean;
  /** row_count は総行数、それ以外は違反件数。 */
  observed: number;
  elapsed_ms: number;
  /** 前回の結果 (初回は null)。観測値の履歴 (#1621) から引く。 */
  previous: AssertionPrevious | null;
}

/** 前回のアサーション実行結果 (#1621)。 */
export interface AssertionPrevious {
  /** 実行時刻 (UTC, RFC 3339)。 */
  at: string;
  observed: number;
  passed: boolean;
}

/** `accepted_values` の候補 (列の DISTINCT 値、#1621)。 */
export interface AcceptedValuesCandidates {
  values: string[];
  /** 種類が多すぎて打ち切ったか。 */
  truncated: boolean;
}

/** アサーション取り込みで読めなかった要素 (#1621)。 */
export interface AssertionImportRejection {
  index: number;
  name: string | null;
  error: string;
}

/** `SnippetImportPreview.conflicts` の 1 件 (#1490)。既存と ID が衝突する要素。 */
export interface SnippetConflict {
  id: string;
  existing_name: string;
  incoming_name: string;
}

/** `preview_import_snippets` の結果 (#1490)。書き込まずに適用前の確認へ使う。 */
export interface SnippetImportPreview {
  total: number;
  new_count: number;
  conflict_count: number;
  /** 全接続スコープへ付け替える件数 (戦略別。衝突する要素の扱いで変わる)。 */
  scope_reset_by_strategy: { rename: number; skip: number; overwrite: number };
  /** ファイル内で ID が重複している件数 (既存との衝突とは別)。 */
  duplicate_in_file_count: number;
  /** 衝突する要素の先頭数件 (「上書き」で置き換わる先の表示用)。 */
  conflicts: SnippetConflict[];
  rejected: AssertionImportRejection[];
}

/** `import_snippets` の結果 (#1490)。 */
export interface SnippetImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
  scope_reset: number;
  rejected: AssertionImportRejection[];
}

/** `import_assertions` の結果 (#1621)。 */
export interface ImportAssertionsResult {
  imported: Assertion[];
  skipped_duplicates: number;
  rejected: AssertionImportRejection[];
}

export interface HistoryEntry {
  id: number;
  profile_id: string | null;
  driver: string;
  database: string | null;
  /** 一覧用の SQL 要約 (空白を畳んだ先頭 N 文字、超過は `…`)。全文は `getHistorySql` (#1256)。 */
  sql_preview: string;
  /** SQL 全文の文字数。 */
  sql_len: number;
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

/** #735 DML フライトレコーダの書き込み種別。`db::WriteKind` の wire 表現。 */
export type WriteKind = "insert" | "update" | "delete" | "other";

/** `list_flight_records` の 1 件。行データ本体は含まない一覧用サマリ。 */
export interface WriteCaptureSummary {
  id: number;
  profile_id: string | null;
  driver: string;
  database: string | null;
  table: string;
  kind: WriteKind;
  sql: string;
  rows_affected: number;
  captured_at: string;
  undone: boolean;
  /** ピン留め済み (#1626)。自動削除 (件数・期間・容量) の対象外。 */
  pinned: boolean;
  /** 同じ複数文スクリプト / UPSERT の記録に共通の id (#1626)。単発の記録は null。 */
  batch_id: string | null;
}

/** Undo プレビュー/適用で検出される 1 行の競合。 */
export interface UndoConflict {
  key: CellValue[];
  expected: CellValue[] | null;
  current: CellValue[] | null;
}

export interface UndoPreviewResponse {
  statements: string[];
  conflicts: UndoConflict[];
  warnings: string[];
}

/** バッチ単位の取り消し / やり直しのプレビュー (#1626)。 */
export interface UndoBatchPreviewResponse extends UndoPreviewResponse {
  /** 計画に含めた記録の id (適用順)。 */
  recordIds: number[];
}

/** 取り消し計画の `.sql` 書き出し結果 (#1626)。 */
export interface ExportPlanOutcome {
  statements: number;
  conflicts: number;
}

export interface UndoOutcome {
  applied: boolean;
  rowsAffected: number;
  conflicts: UndoConflict[];
  warnings: string[];
}

export interface Column {
  name: string;
  type_name: string;
}

export type CellValue = null | boolean | number | string;

/** サーバの通知・警告の重大度 (#1165)。`db::types::ServerMessageSeverity` の wire 表現。 */
export type ServerMessageSeverity = "error" | "warning" | "notice" | "info";

/**
 * サーバが文の実行中に返した通知・警告 1 件 (#1165)。PostgreSQL の NOTICE /
 * WARNING、MySQL の `SHOW WARNINGS`。SQLite は常に無い。
 */
export interface ServerMessage {
  severity: ServerMessageSeverity;
  text: string;
}

export interface QueryResult {
  columns: Column[];
  rows: CellValue[][];
  rows_affected: number;
  elapsed_ms: number;
  /** サーバの通知・警告 (#1165)。無い / 古いバックエンドでは省略。 */
  server_messages?: ServerMessage[];
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
  /**
   * 列コメント (#1002)。MySQL `COLUMN_COMMENT` / PostgreSQL `col_description`。
   * 無い・SQLite は `null`。古いバックエンドは送らないので省略可能 (後方互換)。
   */
  comment?: string | null;
}

/** One table (or view) and its column names, for whole-schema autocomplete. */
export interface TableSchema {
  name: string;
  columns: string[];
}

/**
 * Row identity strategy for inline editing when a table has no usable
 * primary key (#849). `strategy` is one of `"primary_key"` / `"unique_key"` / `"rowid"` /
 * `"ctid"` / `"all_columns"` / `"none"` — see the backend's
 * `db::types::TableRowIdentity` doc for what each means and when the
 * driver reports it. `hidden_column` is the pseudo-column name
 * (`"rowid"` / `"ctid"`) to append to a browse `SELECT` for the
 * `"rowid"`/`"ctid"` strategies, `null` otherwise.
 */
export interface TableRowIdentity {
  strategy: string;
  hidden_column: string | null;
  /** `"unique_key"` のときの UNIQUE NOT NULL キー列 (#1776)。他の戦略では空配列。 */
  key_columns?: string[];
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
export type SchemaObjectKind = "view" | "materialized_view" | "procedure" | "function" | "trigger";

/** 非テーブルのスキーマオブジェクト。 */
export interface SchemaObject {
  kind: SchemaObjectKind;
  name: string;
  /** 同名衝突を避ける一意識別子 (PostgreSQL の oid 等)。無いドライバ/種別では null。 */
  id: string | null;
}

/** グローバルオブジェクト検索 (#1261) の検索範囲。 */
export type ObjectSearchScope = { kind: "current"; database: string } | { kind: "all" };

/** グローバルオブジェクト検索のヒット 1 件。テーブルそのものか、テーブル内のカラムか。 */
export interface ObjectSearchHit {
  kind: "table" | "column" | "view" | "routine" | "trigger";
  database: string;
  /** テーブル・カラムのヒットではテーブル名。ビュー / ルーチン / トリガーではオブジェクト名。 */
  table: string;
  /** `kind === "column"` のときだけ設定。 */
  column?: string;
  /** `kind` が view / routine / trigger のときの `SchemaObject.kind` (定義を開くのに使う)。 */
  object_kind?: string;
  /** `SchemaObject.id` (PostgreSQL の oid など)。 */
  object_id?: string;
  /** `kind === "table"` のときの推定行数 (索引構築時の概算。統計が無ければ無い)。 */
  row_estimate?: number;
}

/** Where-used (#1027 / #1261) の検索対象。`column` が null ならテーブル (ビュー) そのもの。 */
export interface WhereUsedTarget {
  /** ツリーの「データベース」ノード名 (PostgreSQL はスキーマ)。 */
  database: string;
  table: string;
  column: string | null;
}

/** 参照の確からしさ。`possible` は「対象テーブルとの結び付きを確認できなかった」候補。 */
export type ReferenceConfidence = "direct" | "possible";

/** 表示用に 1 行へまとめた該当箇所。`ranges` は `text` 内のオフセット (UTF-16)。 */
export interface ReferenceLine {
  /** 1 始まりの行番号。 */
  line: number;
  text: string;
  ranges: [number, number][];
  /** 長い行の先頭 / 末尾を省略したか (表示側で「…」を付ける)。 */
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface WhereUsedMatch {
  confidence: ReferenceConfidence;
  hitCount: number;
  lines: ReferenceLine[];
  source: "object" | "snippet";
  /** オブジェクト種別。スニペットは "snippet"。 */
  kind: SchemaObjectKind | "snippet";
  name: string;
  /** スキーマオブジェクトの一意識別子 (`get_object_definition` へそのまま渡す)。 */
  id: string | null;
  /** スニペットの ID (スニペットのときだけ)。 */
  snippetId: string | null;
}

export interface WhereUsedFailure {
  kind: SchemaObjectKind;
  name: string;
  error: string;
}

export interface WhereUsedReport {
  matches: WhereUsedMatch[];
  /** 定義を走査できたオブジェクト数 (スニペットを除く)。 */
  scannedObjects: number;
  scannedSnippets: number;
  /** 定義の取得に失敗したオブジェクト (権限不足など)。 */
  failed: WhereUsedFailure[];
  /** 定義本文が空で返ったオブジェクト。 */
  emptyDefinitions: { kind: SchemaObjectKind; name: string }[];
  /** キャンセルされ、途中までの結果であること。 */
  cancelled: boolean;
}

export interface WhereUsedProgress {
  done: number;
  total: number;
}

/** DB 全体からの値検索 (#748 / #1261) の列 1 つ (名前と生の型名)。 */
export interface ScanColumn {
  name: string;
  /** `TableColumnInfo.data_type` / `Column.type_name` と同じ語彙の生の型名。 */
  dataType: string;
}

/** 値検索の走査 1 テーブルぶんの結果。テーブルの指定順に届く。 */
export type DataSearchEntry =
  | {
      status: "hit";
      table: string;
      columns: ScanColumn[];
      hits: { column: string; count: number }[];
    }
  | { status: "no-hit"; table: string }
  | {
      status: "skipped";
      table: string;
      reason: "row-threshold" | "no-searchable-columns" | "error";
      detail?: string;
    };

/** `dataSearchStream` の要求。 */
export interface DataSearchRequest {
  database: string;
  term: string;
  mode: MatchMode;
  /** 走査するテーブル (この順に結果が届く)。 */
  tables: string[];
  /** 概算行数がこれを超えるテーブルは走査しない。 */
  rowThreshold: number;
  /** 日付・日時列も文字列として検索する (#1623)。省略は false。 */
  includeDates?: boolean;
}

/** ルーチン引数の入出力モード (#1003)。`table` は PostgreSQL の RETURNS TABLE 出力列。 */
export type RoutineParamMode = "in" | "out" | "inout" | "variadic" | "table";

/** ストアドプロシージャ / 関数の 1 パラメータ (`get_routine_signature`)。 */
export interface RoutineParameter {
  /** パラメータ名。PostgreSQL の無名引数は空文字。 */
  name: string;
  /** 入出力モード。未知の値はバックエンドが `in` に倒して返す。 */
  mode: RoutineParamMode | string;
  /** 型名 (PostgreSQL は `format_type` の出力で、キャスト先にも使う)。 */
  data_type: string;
}

/** ルーチンのシグネチャ (#1003)。 */
export interface RoutineSignature {
  kind: "procedure" | "function" | string;
  name: string;
  parameters: RoutineParameter[];
  /** 関数が集合 / テーブル値を返すか (true なら `SELECT * FROM fn(...)`)。 */
  returns_set: boolean;
  /** 関数の戻り値型 (表示用)。 */
  return_type: string | null;
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

/** スキーマキャッシュの取得時刻 (DB ごと, #1539)。 */
export interface SchemaCacheTime {
  database: string;
  /** UNIX epoch ミリ秒 (壁時計)。表示はローカル時刻。 */
  fetched_at_ms: number;
}

/** テーブル (またはビュー) のコメント 1 件 (#1002)。コメントを持つものだけが返る。 */
export interface TableComment {
  name: string;
  comment: string;
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
  /** 不要行 (dead tuple) の概算数 (#1622)。PostgreSQL のみ。 */
  dead_rows?: number | null;
  /** 最後の VACUUM / autovacuum の時刻 (Unix 秒, #1622)。PostgreSQL のみ。 */
  last_vacuum_at?: number | null;
  /** 最後の ANALYZE / autoanalyze の時刻 (Unix 秒, #1622)。PostgreSQL のみ。 */
  last_analyze_at?: number | null;
}

/**
 * テーブル統計ダッシュボードの 1 行 (`table_statistics`、#1255)。サイズ情報に、列数・
 * インデックス数・PK 有無・FK 数 (制約単位) を合成したもの。`column_count` は列メタ
 * データが無いテーブル (PostgreSQL のマテビューなど) で `null` (= 不明)。
 */
export interface TableStatistic extends TableSizeInfo {
  column_count: number | null;
  index_count: number;
  has_primary_key: boolean;
  foreign_key_count: number;
  /** 前回取得時の値 (#1621)。増減 (今回 − 前回) の基準。初回・前回に無かったテーブルは null。 */
  previous: TableStatPrevious | null;
}

/** 前回取得時のテーブル統計 (#1621)。 */
export interface TableStatPrevious {
  /** 前回取得の時刻 (UTC, RFC 3339)。 */
  at: string;
  row_estimate: number | null;
  total_bytes: number | null;
}

/** 列編集ダイアログの初期ロード一式 (`alter_table_context`、#1255)。 */
export interface AlterTableContext {
  columns: TableColumnInfo[];
  /** テーブルコメント。無い・未対応 (SQLite) は空文字。 */
  table_comment: string;
  /** このテーブル自身が持つ外部キー。FK 編集に対応しないドライバでは空。 */
  foreign_keys: ForeignKey[];
  /** DB 内のテーブル名一覧 (FK の参照先候補)。 */
  table_names: string[];
  /** 取得に失敗して空で続行した付随情報の種別 (`comments` / `foreign_keys` / `table_names`)。 */
  warnings: string[];
}

/** DROP COLUMN の依存 1 件の種別 (`column_dependencies`、#1758)。 */
export type ColumnDependencyKind =
  | "view"
  | "materialized_view"
  | "trigger"
  | "generated_column"
  | "index"
  | "foreign_key"
  | "referenced_by";

/** DROP COLUMN で影響を受ける依存 1 件 (`column_dependencies`、#1758)。 */
export interface ColumnDependency {
  /** 削除対象の列名。 */
  column: string;
  kind: ColumnDependencyKind;
  name: string;
  detail: string | null;
  confidence: ReferenceConfidence;
}

/** `column_dependencies` の結果 (#1758)。 */
export interface ColumnDependencyReport {
  dependencies: ColumnDependency[];
  /** 取得できず調べられなかった依存の種別 (`definitions` / `indexes` / `foreign_keys` / `generated_columns`)。 */
  warnings: string[];
}

/** テーブルを開いた結果 (`open_table` / `open_tables`、#1263)。 */
export interface OpenTableResult {
  /** ページネーションの土台 (`SELECT *[, rowid|ctid] FROM ...`、LIMIT なし)。 */
  base: string;
  /** 初回実行する SQL (`base` + ` LIMIT <limit>`)。 */
  sql: string;
  columns: TableColumnInfo[];
  /** PK が無いときだけ取得する行識別フォールバック。 */
  row_identity: TableRowIdentity | null;
  /** 行数推定。`withEstimate` が偽・未対応・統計なしは null。 */
  row_estimate: number | null;
}

/** `open_tables` の 1 件分。`result` と `error` はどちらか一方だけ入る。 */
export interface OpenTableEntry {
  database: string;
  table: string;
  result: OpenTableResult | null;
  error: string | null;
}

/** 1 DB (PostgreSQL ではスキーマ) とそのテーブル名一覧 (`list_tables_all`、#1263)。 */
export interface DatabaseTables {
  database: string;
  tables: string[];
}

/** スキーマツリー復元 / 更新の一括結果 (`load_schema_tree`、#1263)。 */
export interface SchemaTree {
  /** 接続が持つ全データベース名。 */
  databases: string[];
  /** 要求した開いている DB のうち実在するもの。取得失敗の項目は null (反映しない) か空。 */
  open: {
    database: string;
    tables: string[] | null;
    row_estimates: TableRowEstimate[] | null;
    objects: SchemaObject[];
    comments: TableComment[] | null;
  }[];
  /** 開いているテーブルのうち、実在し列を取得できたもの。`key` は `db::table`。 */
  tables: { key: string; columns: TableColumnInfo[]; indexes: IndexInfo[] }[];
}

/** サーバ設定/状態の 1 変数 (サーバ情報パネル #563)。値は常に文字列で表示。 */
export interface ServerVariable {
  name: string;
  value: string;
  /** 値の出どころ (#1622)。PostgreSQL は pg_settings.source、MySQL 8 は variables_info。`default` 以外が変更済み。
   *  取れない / SQLite は無し。 */
  source?: string | null;
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
 * PostgreSQL は pg_stat_activity に対応する。`id` をそのまま `killProcesses` に渡す。
 * クエリ本文は Rust 側で 1 行要約 (`query_summary`) にして返し、全文は
 * `getProcessQuery` で id 指定で取得する (#1259)。
 */
/** `insert_generated_rows` の結果 (#1259)。 */
export interface InsertRowsResult {
  inserted: number;
  elapsed_ms: number;
}

/**
 * `bulk_update_cells` の結果 (#1777)。実影響行数が想定 (編集対象として指定した行数) を超えると、
 * バックエンドはコミットせずロールバックして `row_count_exceeded` を返す (エラーではない)。
 * `expected_rows` / `actual_rows` は想定を外れた文の合計 (表示用)、`batch_total_rows` は全文の合計
 * (「最大で N 行が変わる」の表示用)、`statement_counts` は文ごとの実際の影響行数。
 * 利用者が確認して承認したときだけ、`statement_counts` を `approvedCounts` に付けて再実行する
 * (各文の上限を max(期待, 承認件数) に引き上げる。合計での承認と違い、他の変更で相殺されない)。
 * `rollback_incomplete` は、トランザクション非対応の表 (MyISAM など) のため書き込みの一部が
 * 戻らなかったことを表す。承認して再実行してはいけない (再読込して現状を確認させる)。
 */
export type BulkWriteOutcome =
  | { status: "applied"; result: QueryResult }
  | {
      status: "row_count_exceeded";
      expected_rows: number;
      actual_rows: number;
      batch_total_rows: number;
      statement_counts: number[];
    }
  | { status: "rollback_incomplete"; expected_rows: number; actual_rows: number };

/** `bulk_update_cells` の追加オプション (#1777)。後続の検査 (楽観ロックなど) もここへ足す。 */
export interface BulkWriteOptions {
  /** 確認ダイアログで承認した文ごとの影響行数 (`row_count_exceeded.statement_counts`)。各文の上限にして再実行する。 */
  approvedCounts?: number[];
}

export interface KillProcessesResult {
  killed: number;
  failed: number;
  first_error: string | null;
  /** プロセス id ごとの成否 (#1622)。入力順ではなくバックエンドの実行順。 */
  outcomes: KillProcessOutcome[];
}

/** `kill_processes` の 1 プロセスぶんの結果 (#1622)。 */
export interface KillProcessOutcome {
  id: number;
  /** killed=停止を受け付けた / already_gone=既に居なかった (成功扱い) / failed=失敗 (error に理由) /
   *  skipped=実行しなかった (文のみ停止で自接続)。 */
  status: "killed" | "already_gone" | "failed" | "skipped";
  error: string | null;
}

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
  /** 改行・連続空白を畳み 200 文字で切り詰めた 1 行要約。クエリが無ければ null。 */
  query_summary: string | null;
  /** 要約が全文より短い (切り詰めた) とき true。 */
  query_truncated: boolean;
  /**
   * この行が一覧クエリを実行した接続自身 (= 本アプリのプール接続) のとき true。
   * kill するとアプリのセッションが切断されるため、UI は警告を出す。ベスト
   * エフォート: 同じプールの別接続までは判別できない。
   */
  is_self: boolean;
  /**
   * このプロセスをロック待ちで止めているブロッカーの id (#1417)。待っていない / 取得
   * できない (権限不足・SQLite) ときは空。待機チェーンのツリー化はフロント側で行う。
   */
  blocked_by: number[];
  /** VACUUM / CREATE INDEX の進捗 (#1622)。PostgreSQL のみ・走っているときだけ。 */
  progress?: ProcessProgress | null;
}

/** プロセスのメンテナンス作業の進捗 (#1622)。`total` が 0 のフェーズは割合を出せない。 */
export interface ProcessProgress {
  kind: "vacuum" | "create_index";
  phase: string;
  done: number;
  total: number;
}

/**
 * データベースユーザ / ロール 1 件 (ユーザ・権限管理パネル #732)。MySQL は
 * `(user, host)` の組でアカウントを識別する (同じユーザ名でもホストごとに別の
 * 権限を持てる) ため `host` を持つ。PostgreSQL のロールはホストの概念を持たず
 * 常に `null`。SQLite はユーザ概念を持たず、UI は導線ごと非表示にする。
 */
export interface DbUserInfo {
  name: string;
  host: string | null;
  /** MySQL は `SUPER` のみ。PostgreSQL は SUPERUSER/CREATEDB/CREATEROLE/LOGIN/
   *  REPLICATION/BYPASSRLS のうち該当するもの。 */
  attributes: string[];
  /** PostgreSQL のロール所属 (`pg_auth_members`)。MySQL は常に空配列。 */
  member_of: string[];
  is_superuser: boolean;
  can_login: boolean;
}

/**
 * 権限マトリクスの 1 行。`table` は DB 全体既定行 (MySQL の `mysql.user` グローバル
 * 権限) では `"*"`、テーブル単位の GRANT では `"<db>.<table>"`。`ddl` は各ドライバが
 * テーブル単位で実際に GRANT できるスキーマ変更系権限をまとめたもの (MySQL:
 * CREATE/ALTER/DROP/INDEX/REFERENCES、PostgreSQL: TRUNCATE/REFERENCES/TRIGGER —
 * PostgreSQL の CREATE/ALTER/DROP TABLE はスキーマ所有権で制御されテーブル単位の
 * GRANT 対象ではないため対象外)。
 */
export interface TablePrivilegeRow {
  table: string;
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  ddl: boolean;
}

/** 1 ユーザ/ロール分の権限マトリクス全体。`global` は MySQL のみ (PostgreSQL は
 *  DB 全体既定に相当する概念を持たないため常に `null`)。 */
export interface UserPrivileges {
  global: TablePrivilegeRow | null;
  tables: TablePrivilegeRow[];
}

/** 権限フラグ (CRUD + DDL)。 */
export interface PrivilegeFlags {
  select: boolean;
  insert: boolean;
  update: boolean;
  delete: boolean;
  ddl: boolean;
}

/** 1 テーブル (または DB/スキーマ全体) 分の権限差分 (`generatePrivilegeDiffSql` の入力)。
 *  `table` を省略すると DB/スキーマ全体が対象になる (MySQL `db.*` / PostgreSQL
 *  `ALL TABLES IN SCHEMA`)。 */
export interface PrivilegeChange {
  table?: string | null;
  /** 付与するフラグ。 */
  added: PrivilegeFlags;
  /** 剥奪するフラグ。 */
  removed: PrivilegeFlags;
  /** 列単位の権限 (#1622)。空でなければ `table` 指定時に SELECT / INSERT / UPDATE をその列に限定する。 */
  columns?: string[] | null;
}

/**
 * サーバランタイムの軽量メトリクス 1 サンプル (#731)。監視ダッシュボードが一定
 * 間隔でポーリングし、在メモリのリングバッファに蓄積して接続数 / QPS / ロック待ちを
 * 時系列グラフ化する。ゲージ (瞬時値) とカウンタ (累積値) が混在し、QPS/TPS などの
 * レートは累積カウンタの 2 サンプル差分から `serverMetrics.ts` の純ロジックが算出
 * する。エンジンが報告しない項目は `null`。スループット (`questions`) の意味は
 * ドライバで異なる (MySQL=ステートメント数 / PostgreSQL=トランザクション数)。
 * SQLite はサーバを持たずコマンドがエラーを返す (UI は導線ごと非表示にする)。
 */
/** `health_probe_all` の 1 セッション分の観測値 (#1259)。 */
export interface HealthProbeItem {
  session_id: string;
  status: "up" | "down" | "timeout";
  /** `SELECT 1` の往復時間 (ms)。up のときだけ値がある。 */
  latency_ms: number | null;
  version: string | null;
  /** 現在の接続数。SQLite / 取得不可は null。 */
  connections: number | null;
  /** SSH トンネルの生存 (#1537)。トンネル越しでなければ null、false なら SSH セッションが閉じている。 */
  tunnel_alive: boolean | null;
}

export interface ServerMetrics {
  /** クライアント接続数 (ゲージ)。MySQL Threads_connected / PG client backend 数。 */
  connections: number | null;
  /** 実行中の接続・スレッド数 (ゲージ)。MySQL Threads_running / PG state='active'。 */
  active: number | null;
  /** トランザクション開始済みだがアイドルな接続数 (ゲージ)。PG のみ (MySQL は null)。 */
  idle_in_transaction: number | null;
  /** いまロック待ちの接続・スレッド数 (ゲージ)。MySQL Innodb_row_lock_current_waits / PG wait_event_type='Lock'。 */
  lock_waiting: number | null;
  /** スループットカウンタ (累積)。MySQL Questions / PG xact_commit+xact_rollback。 */
  questions: number | null;
  /** スロークエリ数 (累積)。MySQL Slow_queries。PG は null。 */
  slow_queries: number | null;
  /** 行ロック待ちの累積回数。MySQL Innodb_row_lock_waits。PG は null。 */
  lock_waits: number | null;
  /** サーバの接続数上限 (#1622)。MySQL max_connections / PG max_connections。取れなければ null。 */
  max_connections?: number | null;
}

/** One trusted SSH host from known_hosts (`host:port` + fingerprint). #682. */
export interface KnownHost {
  host: string;
  port: number;
  fingerprint: string;
}

/** One entry of the known_hosts trust/forget/import history (#1630). Never holds key material. */
export interface KnownHostEvent {
  /** UTC, RFC 3339. */
  at: string;
  action: "trust" | "forget" | "import";
  host: string;
  port: number;
  fingerprint: string;
  previous_fingerprint: string | null;
}

/** One OpenSSH known_hosts entry offered for import (#1630). */
export interface ImportCandidate {
  host: string;
  port: number;
  fingerprint: string;
  key_type: string;
  /** `conflict` = noobDB already trusts a different fingerprint (import replaces it). */
  status: "new" | "same" | "conflict";
  existing_fingerprint: string | null;
}

/** Result of scanning `~/.ssh/known_hosts` (#1630). */
export interface ImportScan {
  found: boolean;
  candidates: ImportCandidate[];
  /** Hashed (`HashKnownHosts`) lines that cannot be matched and were skipped. */
  hashed_skipped: number;
  other_skipped: number;
}

/**
 * ライブクエリ・インスペクタ (#746) の前提可否。使えない機能には機械可読な
 * 理由コード (`unsupported_driver` / `performance_schema_off` /
 * `statements_consumer_off` / `statements_digest_off` /
 * `pg_stat_statements_missing` / `pg_stat_statements_not_preloaded` / `stats_unreadable`) が付き、UI は有効化手順
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
  /** Rust の `normalize_sql_fingerprint` による同型クエリキー (N+1 グルーピング用, #1259)。 */
  fingerprint: string;
}

/**
 * digest (フィンガープリント) 単位の**差分**統計 1 行 (#746 / #1259)。記録開始時点
 * (baseline) との引き算と N+1 目安の判定は Rust 側 (`db/inspector.rs`) が行う。
 * `max_time_ms` は高水位マークで差分計算できない累積値。`fingerprint` (SQL 本文) は
 * digest の初出時のみ載り、以降は null (呼び出し側がキャッシュする)。
 */
export interface StatementDeltaRow {
  digest: string;
  fingerprint: string | null;
  database: string | null;
  calls: number;
  total_time_ms: number;
  mean_time_ms: number;
  max_time_ms: number;
  /** MySQL は走査行数 (SUM_ROWS_EXAMINED)、PostgreSQL は返却/影響行数。 */
  rows: number | null;
  /** 直近のポーリング間隔の実行レートが N+1 目安の閾値を超えた。 */
  n_plus_one: boolean;
}

/**
 * 集計件数。2^53 を超えるとバックエンド (`Value::from_u64_lossless`) が十進文字列で
 * 返すので `number | string` (#974)。
 */
export type ProfileCount = number | string;

/**
 * 列データプロファイル (「列を探索」、#974)。サーバ側で全件集計した NULL 率 /
 * DISTINCT / MIN・MAX / 上位頻出値 / (数値列のみ) ヒストグラム。`notes` は縮退
 * 理由コード (`stats_unavailable` / `top_values_unavailable` /
 * `histogram_unavailable` / `approx_distinct_unsupported` /
 * `approx_distinct_no_stats` / `sampled`)。
 */
export interface ColumnProfile {
  column: string;
  data_type: string;
  numeric: boolean;
  total_count: ProfileCount;
  non_null_count: ProfileCount;
  null_count: ProfileCount;
  distinct_count: ProfileCount | null;
  distinct_approximate: boolean;
  min_value: CellValue;
  max_value: CellValue;
  top_values: { value: CellValue; count: ProfileCount }[];
  histogram: { lower: number; upper: number; count: ProfileCount }[];
  notes: string[];
  /** 標本モード (#1628) の抽出率 (%)。全件を集計したときは null。 */
  sample_percent?: number | null;
}

/** 全列の概要の 1 列分 (#1539)。`distinct_count` が null なら求めていない / 求められなかった。 */
export interface ColumnOverview {
  column: string;
  data_type: string;
  non_null_count: ProfileCount;
  null_count: ProfileCount;
  distinct_count: ProfileCount | null;
  min_value: CellValue;
  max_value: CellValue;
  notes: string[];
}

/** 表の全列の概要 (#1539)。`scans` は集計に使った SELECT の本数 (通常 1)。 */
export interface TableProfileOverview {
  table: string;
  total_count: ProfileCount;
  columns: ColumnOverview[];
  /** `distinct_count` が統計情報からの近似値か (PostgreSQL で近似を要求したとき)。 */
  distinct_approximate: boolean;
  /** 表単位の縮退理由コード (近似を求めたが統計が無い、など)。 */
  notes: string[];
  scans: number;
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
  /**
   * `source_only` テーブルの外部キー制約 (source 側。`CREATE TABLE` 同期が出力する)。
   * スキーマ比較だけが埋め、それ以外 (サンドボックス等) では空。
   */
  foreign_keys?: DiffForeignKey[];
  /** インデックス (UNIQUE 含む、主キー以外) の差分 (#1625)。 */
  indexes?: IndexDiff[];
  /** 既存テーブルの外部キー制約の差分 (追加・削除・ON DELETE / ON UPDATE の変更, #1625)。 */
  fk_changes?: ForeignKeyDiff[];
  /** SQLite のテーブル再作成に使う target の完全な定義 (#1625)。 */
  target_snapshot?: TargetTableSnapshot | null;
}

/** インデックス 1 本の定義 (差分用)。 */
export interface DiffIndex {
  name: string;
  columns: string[];
  unique: boolean;
  method: string | null;
  predicate?: string | null;
  first_expression_at?: number | null;
  key_column_count?: number | null;
  column_options?: string[];
  nulls_not_distinct?: boolean;
}

/** 1 インデックスの差分。`changed_fields` は columns / unique / method / predicate / include / order / expression。 */
export interface IndexDiff {
  name: string;
  status: DiffStatus;
  source: DiffIndex | null;
  target: DiffIndex | null;
  changed_fields?: string[];
}

/** 既存テーブルの外部キー 1 制約の差分。`changed_fields` は on_delete / on_update / referenced_columns。 */
export interface ForeignKeyDiff {
  status: DiffStatus;
  source: DiffForeignKey | null;
  target: DiffForeignKey | null;
  changed_fields?: string[];
}

/** SQLite のテーブル再作成に必要な target 側の定義。 */
export interface TargetTableSnapshot {
  columns: TableColumnInfo[];
  foreign_keys?: DiffForeignKey[];
  unique_constraints?: string[][];
  recreate_sql?: string[];
  drop_views?: string[];
  original_sql?: string | null;
  referenced_by?: string[];
}

/** 外部キー 1 制約 (複合キーの列を束ねたもの)。`referenced_columns` が空なら参照先列は未解決。 */
export interface DiffForeignKey {
  name: string | null;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  on_delete: string | null;
  on_update: string | null;
}

/** 新規インデックスと既存インデックスの重なり方 (#1625)。 */
export type IndexOverlapKind = "duplicate" | "covered_by_existing" | "makes_existing_redundant";

/** 新規インデックスと重なる既存インデックス 1 件 (#1625)。 */
export interface IndexOverlap {
  name: string;
  kind: IndexOverlapKind;
}

/** SQLite のメンテナンス操作 (#1625)。 */
export type SqliteMaintenanceAction = "integrity_check" | "foreign_key_check" | "optimize" | "analyze";

/** `PRAGMA foreign_key_check` の違反行 1 件。 */
export interface SqliteFkViolation {
  table: string;
  rowid: number | null;
  parent: string;
  fk_index: number;
}

/** `sqliteMaintenance` の戻り値 (#1625)。 */
export interface SqliteMaintenanceResult {
  action: SqliteMaintenanceAction;
  ok: boolean;
  messages: string[];
  fk_violations: SqliteFkViolation[];
  truncated: boolean;
  page_count: number | null;
  freelist_count: number | null;
  elapsed_ms: number;
}

/** Result of comparing a source schema against a target schema. */
export interface SchemaDiff {
  source_driver: DriverKind;
  target_driver: DriverKind;
  tables: TableDiff[];
  /** 比較時の注意 (例: SQLite で target の外部キー取得に失敗)。同期計画の警告に載る。 */
  warnings: string[];
  /** インデックスの差分を比較済みか (#1625)。 */
  indexes_compared?: boolean;
}

/**
 * One table's full column metadata (mirrors the Rust `TableColumns` struct in
 * `db::diff`). The wire shape of `describe_database`; the schema drift timeline
 * (#736) stores the same columns, plus indexes, on the Rust side (#1260).
 */
export interface SchemaSnapshotTable {
  name: string;
  columns: TableColumnInfo[];
}

/** 保存済みスキーマ世代のメタデータ (スキーマドリフト・タイムライン #736 / #1260)。 */
/** 巻き戻し DDL の生成結果 (#1621)。`plan` は現在側の世代を戻したい世代の形へ揃える DDL。 */
export interface SchemaDriftRevertSql {
  plan: SyncPlan;
  /** 破壊的な文 (DROP) の許可が無いため出力しなかった数。 */
  omitted_destructive: number;
  database: string;
  /** 文の前に置く対象指定 (MySQL は USE、PostgreSQL は SET search_path)。SQLite は null。 */
  preamble: string | null;
}

export interface SchemaDriftGeneration {
  id: string;
  /** 取得時刻 (RFC 3339)。 */
  capturedAt: string;
  driver: DriverKind;
  database: string;
  /** 内容フィンガープリント (dedupe 用)。 */
  fingerprint: string;
  /** キャプチャ時点のテーブル数。 */
  tableCount: number;
  /** true のとき、サイズ暴走ガードで中身を保存していない (差分表示不可)。 */
  omitted: boolean;
  /** DDL の成功をきっかけに自動取得した世代のとき、そのとき実行した SQL (#1537)。 */
  triggerSql?: string | null;
  /** 利用者が付けたラベル (#1621)。ラベル付きの世代はローテーションで消えない。 */
  label?: string | null;
}

/** 1 テーブルの変化サマリ。`tableStatus` はテーブル自体の増減、それ以外は
 *  「両側に存在するテーブル」内の列/インデックス単位の変化件数。 */
export interface SchemaDriftTableChange {
  table: string;
  tableStatus: "added" | "removed" | "changed";
  columnsAdded: number;
  columnsRemoved: number;
  columnsChanged: number;
  indexesAdded: number;
  indexesRemoved: number;
  indexesChanged: number;
  /** 追加/削除/変更された列名 (`changed` テーブルのみ)。古いバックエンドでは欠ける。 */
  addedColumns?: string[];
  removedColumns?: string[];
  changedColumns?: string[];
  /** 追加/削除/変更されたインデックス名。 */
  addedIndexes?: string[];
  removedIndexes?: string[];
  changedIndexes?: string[];
}

/** ダンプに使う外部クライアントツール。 */
export type DumpToolName = "mysqldump" | "pg_dump";

/**
 * ダンプ用ツールの検出結果 (`dump_tool_status` / `install_dump_tool`)。ツールは
 * noobDB を実行している**この PC** で動くので、導入先もこの PC (踏み台・DB サーバではない)。
 */
export interface DumpToolStatus {
  tool: string;
  /** 見つかった実行ファイルのパス。無ければ null。 */
  path: string | null;
  /** 導入方法。この OS で案内できなければ null。 */
  install: {
    /** `winget` / `brew` / `manual`。 */
    manager: string;
    /** 実行される (または手で実行する) コマンド。 */
    command: string;
    /** この PC 上のインストール先。 */
    location: string;
    /** アプリから実行できるか。false ならコマンドを手で実行してもらう。 */
    oneClick: boolean;
  } | null;
}

/** 2 世代間の変化サマリ全体。変化のあったテーブルのみ、名前順。 */
export interface SchemaDriftSummary {
  tables: SchemaDriftTableChange[];
}

/** `schema_drift_capture` の結果。 */
export interface SchemaDriftCapture {
  /** 新しい世代が追加されたか (直前世代と同一内容なら false)。 */
  added: boolean;
  /** 実際に取得した対象。PostgreSQL ではプロファイルの DB 名が既定スキーマに解決される。 */
  database: string;
  /** 追加後の世代一覧 (新しい順)。`added` が false のときは空。 */
  generations: SchemaDriftGeneration[];
  /** 直前世代からの変化サマリ。初回取得・比較不能のときは null。 */
  summary: SchemaDriftSummary | null;
}

/** 実行計画ウォッチ (#743 / #1260) の保存済み計画 1 世代。 */
export interface PlanWatchGeneration {
  id: string;
  capturedAt: string;
  driver: string;
  /** MySQL/PG: 生 JSON 文字列。SQLite: [id, parent, detail] 行の JSON。 */
  payloadKind: "json" | "sqliteRows";
  payload: string;
  /** Rust 側の `plan_fingerprint`。 */
  fingerprint: string;
}

/** ウォッチ登録 1 件と世代 (新しい順)。エントリの存在 = ウォッチ登録済み。 */
export interface PlanWatchEntry {
  snippetId: string;
  generations: PlanWatchGeneration[];
}

/** 一覧に出ないプロファイルの要約 (`list_skipped_profiles`、#1614)。秘密は含まない。 */
export interface SkippedProfile {
  /** `unparsable`: 解釈できない要素 / `unsupported_driver`: 対応外ドライバのプロファイル。 */
  kind: "unparsable" | "unsupported_driver";
  /** `unparsable` のとき `delete_skipped_profile` に渡す並び順。 */
  index: number;
  id: string | null;
  name: string | null;
  driver: string | null;
  reason: string;
}

/** `plan_watch_refresh` の結果。 */
export interface PlanWatchRefreshResult {
  /** 新しい世代が記録された件数。 */
  recorded: number;
  /** 記録された世代のうち、前世代から重要な変化があった件数。 */
  changed: number;
  errors: { snippetId: string; name: string; error: string }[];
  /** 前世代から警告相当の変化 (フルスキャンへの退行など) があったスニペットの名前。 */
  warned: string[];
  /** `warned` と同じ並びの、警告の先頭 1 件の要約 (`orders: Index Scan → Parallel Seq Scan`, #1621)。 */
  warnedSummaries: string[];
}

/** スキーマ健全性アドバイザ (#741) の指摘ルール識別子。バックの serde
 *  (snake_case) と一致させる。 */
export type AdvisorRuleId =
  | "fk_missing_index"
  | "duplicate_index"
  | "redundant_index"
  | "missing_primary_key"
  | "unused_index"
  | "fk_type_mismatch"
  | "sqlite_integer_pk_hint";

/** 指摘の重要度。フロントで semantic トークンに色分けされる (#664)。 */
export type AdvisorSeverity = "high" | "medium" | "low";

/** スキーマ健全性の 1 指摘。`columns` / `context` の意味はルールごとに異なる
 *  (バック `db::advisor::RuleId` のドキュメント参照)。 */
export interface HealthFinding {
  rule: AdvisorRuleId;
  severity: AdvisorSeverity;
  table: string;
  columns: string[];
  context: string[];
  /** エディタへ挿入する修正 DDL。設計判断を要するルールでは null。 */
  fix_ddl: string | null;
  /** `fix_ddl` のオンライン版 (#1534)。PostgreSQL は `CONCURRENTLY` (トランザクション外で実行)、
   *  MySQL は `ALGORITHM=INPLACE, LOCK=NONE`。SQLite・修正 DDL が無いルールでは null。 */
  fix_ddl_online: string | null;
  /** エンジンの実行時統計に由来する指摘 (観測期間に依存する旨を注記)。 */
  statistical: boolean;
  /** 削除で空く容量 (バイト)。未使用インデックスで、エンジンから取れたときだけ (#1621)。 */
  size_bytes: number | null;
}

/** 前提を満たさずスキップしたルールと機械可読な理由コード。 */
export interface SkippedRule {
  rule: AdvisorRuleId;
  reason: string;
}

/** 1 テーブルぶんの修正 DDL のまとめ (#1540)。2 件以上の機械的に直せる指摘があるテーブルだけ。 */
export interface TableFixPlan {
  table: string;
  /** まとめに含まれる変更 (インデックスの追加・削除) の件数。 */
  change_count: number;
  /** 標準版。方言が許す範囲で 1 文に束ねてある。 */
  ddl: string;
  /** オンライン版 (#1534)。SQLite では null。 */
  ddl_online: string | null;
}

/** スキーマ健全性診断のレポート全体。 */
export interface SchemaHealthReport {
  driver: DriverKind;
  tables_analyzed: number;
  findings: HealthFinding[];
  skipped: SkippedRule[];
  /** テーブル単位のまとめ DDL (#1540)。 */
  table_plans: TableFixPlan[];
  /** 「対応しない」にした指摘 (#1621)。`findings` からは除かれ、別枠に折りたたんで出す。 */
  ignored: HealthFinding[];
  /** 前回診断 (同じセッション・同じデータベース) との差分 (#1621)。初回は null。 */
  diff: AdvisorDiff | null;
}

/** 前回診断との差分 (#1621)。 */
export interface AdvisorDiff {
  /** 前回診断の時刻 (UTC, RFC 3339)。 */
  previous_at: string;
  /** 今回の `findings` のうち前回は無かった指摘の添字。 */
  new_indexes: number[];
  /** 前回は出ていて今回は消えた (解消された) 指摘。 */
  resolved: HealthFinding[];
  /** 前回から続いている指摘の件数。 */
  unchanged: number;
}

/** What a generated sync statement does. */
export type SyncKind =
  | "create_table"
  | "add_column"
  | "alter_column"
  | "add_foreign_key"
  | "drop_column"
  | "drop_table"
  | "add_index"
  | "drop_index"
  | "drop_foreign_key"
  | "rebuild_table"
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

/** テーブル・タイムラプス (#739) の保存済み世代 1 件のメタデータ (行データは含まない)。 */
export interface TimelapseGenerationMeta {
  id: number;
  /** 取得時刻 (RFC 3339)。 */
  captured_at: string;
  row_count: number;
  /** 行数上限で打ち切った部分取得の世代なら true。 */
  truncated: boolean;
  bytes: number;
}

/** ウォッチ登録されたテーブル 1 件と、その世代一覧 (新しい順)。 */
export interface TableWatch {
  id: number;
  profile_id: string;
  driver: string;
  database: string;
  table: string;
  /** false = ウォッチ解除済み (世代データは残してある)。自動取得の対象外。 */
  active: boolean;
  /** 登録時に行数上限を超えており、先頭 N 行だけの記録に同意した。 */
  partial: boolean;
  created_at: string;
  generations: TimelapseGenerationMeta[];
}

/** `timelapseWatchTable` の結果。`watch_id` が null なら行数上限超過で未登録。 */
export interface TimelapseWatchOutcome {
  watch_id: number | null;
  over_limit: boolean;
  row_limit: number;
  generation_added: boolean;
}

/** `timelapseCapture` の 1 ウォッチ分の結果。 */
export interface TimelapseCaptureOutcome {
  watch_id: number;
  database: string;
  table: string;
  added: boolean;
  truncated: boolean;
  error: string | null;
}

/**
 * 2 世代間の差分。`diff` の **source = 新しい世代 / target = 古い世代** なので、
 * `source_only` = 追加行、`target_only` = 削除行、`different` = 変更行。
 */
export interface TimelapseGenerationDiff {
  diff: DataDiff;
  columns_added: string[];
  columns_removed: string[];
  partial: boolean;
  from_captured_at: string;
  to_captured_at: string;
}

/** 主キー指定の 1 行の値の推移 (#1621)。変化があった世代だけが古い順に並ぶ。 */
export interface TimelapseRowHistoryEntry {
  generation_id: number;
  captured_at: string;
  /** false = この世代でその行が無くなった。 */
  present: boolean;
  /** `columns` と同じ並びの値。`present` が false のとき null。 */
  row: CellValue[] | null;
  /** 直前の存在世代から値が変わった列 (初出・再出現は空)。 */
  changed_columns: string[];
}

export interface TimelapseRowHistory {
  columns: string[];
  primary_key: string[];
  entries: TimelapseRowHistoryEntry[];
  generations_scanned: number;
  /** 部分取得の世代を含む (範囲外の行が「消えた」ように見えうる)。 */
  partial: boolean;
}

/**
 * サンドボックス (壊せる砂場、#747) の非秘密メタデータ。実データはローカル
 * SQLite ファイル (`file_path`) に持ち、`session_id` (作成/一覧取得後にセッション
 * として開いたもの) を通じて通常のエディタ/グリッド UI でそのまま操作できる。
 * `source_driver` は書き戻し SQL の方言 (`generateSyncSql` / `generateDataSyncSql`
 * が使う `target_driver`) を決める。
 */
export interface SandboxRecord {
  id: string;
  name: string;
  source_profile_id: string | null;
  source_driver: DriverKind;
  source_database: string | null;
  /** 実データを持つテーブル名 (影の base スナップショットは含まない)。 */
  tables: string[];
  row_limit: number;
  file_path: string;
  created_at: string;
  /** 行数上限に達し部分コピーになったテーブル。 */
  truncated_tables: string[];
  /** 作成時に表ごとへ指定した抽出条件 (`WHERE` の中身, #1625)。 */
  row_filters: { table: string; filter: string }[];
}

/** `createSandbox` の戻り値。`session_id` は通常のセッションと同様に扱える。 */
export interface SandboxCreateResponse {
  sandbox: SandboxRecord;
  session_id: string;
}

/**
 * データ書き戻しの行競合 1 件: サンドボックスと元 DB の双方が、コピー取得後に
 * 同じ主キーの行を独立に変更した状態。`external_row` は元 DB の**現在の**値
 * (元 DB 側で削除されていれば null)。
 */
export interface SandboxConflict {
  key: CellValue[];
  desired_status: RowStatus;
  external_status: RowStatus;
  external_row: CellValue[] | null;
}

/** `compareTableData` の戻り値。`diff` は表示用、`diff_id` はバックエンド保持の同じ差分の ID (#1259)。 */
export interface DataDiffHandle {
  diff_id: string;
  diff: DataDiff;
}

/** `sandboxTableDiff` の戻り値。 */
export interface SandboxTableDiffResult {
  /** サンドボックスでの変更 (base 比較)。表示用。SQL 生成には `desired_diff_id` を使う。 */
  desired: DataDiff;
  /** `desired` をバックエンドが保持した ID (#1259)。`generateDataSyncSql` /
   *  `sandboxAdvanceBase` にはこの ID (+ 除外キー) だけを送る。不要になったら
   *  `releaseDataDiffs` で破棄する。 */
  desired_diff_id: string;
  /** `source_checked` が false のときは常に空 (競合未検査、「競合なし」の意味ではない)。 */
  conflicts: SandboxConflict[];
  source_checked: boolean;
  /** 実 DB 側の取得に失敗して競合検出ができなかったときのエラー文。 */
  source_error: string | null;
}

/** `sandboxResetTable` の戻り値 (#1539)。 */
export interface SandboxResetResult {
  /** リセット後にライブ表へ戻った行数 (= base スナップショットの行数)。 */
  restored_rows: number;
}

/** `sandboxSchemaDiff` の戻り値。 */
export interface SandboxSchemaDiffResult {
  /** サンドボックスでのスキーマ変更 (base 比較)。`generateSyncSql` にそのまま渡せる。 */
  desired: SchemaDiff;
  /** サンドボックス・元 DB の双方でスキーマが変わったテーブル名 (情報提供のみ)。 */
  external_changed_tables: string[];
  source_checked: boolean;
  /** 元 DB の列取得に失敗した理由。失敗しても `desired` は返る。 */
  source_error: string | null;
}

/** Application log contents plus the on-disk file path, for the Settings viewer. */
export interface LogView {
  text: string;
  path: string | null;
}

/** 直近の計測値 1 件 (#1622)。SQL 本文・行データは含まない。 */
export interface PerfSample {
  at_ms: number;
  kind: string;
  sql_execute_ms: number | null;
  emit_ms: number | null;
  payload_bytes_approx: number | null;
  rows: number;
  columns: number;
}

export interface PerfStatus {
  enabled: boolean;
  ui_enabled: boolean;
  env_enabled: boolean;
  samples: PerfSample[];
}

/** OS keyring の疎通診断結果 (#1622)。`reason` は固定コード (秘密・エラー本文は含まない)。 */
export interface KeyringStatus {
  available: boolean;
  reason: string | null;
}

export type ExportFormat = "csv" | "json" | "ndjson" | "markdown" | "sql" | "xlsx";

/** xlsx エクスポートで Excel の上限 (行数 / セル文字数) に当たり、出力が欠けた内訳 (#711)。 */
export interface ExportTruncation {
  /** 実際にシートへ書いたデータ行数 (ヘッダを除く)。 */
  writtenRows: number;
  /** 行数上限 (1,048,576 行 = ヘッダ + 1,048,575 データ行) を超えて書かなかった行数。 */
  droppedRows: number;
  /** セル文字数上限 (32,767 文字) で切り詰めたセル数。 */
  truncatedCells: number;
}

/** 在グリッド経路 `export_query_result` の戻り値 (#711)。 */
export interface ExportResult {
  bytes: number;
  /** 出力が欠けていなければ (xlsx 以外は常に) null。 */
  truncation: ExportTruncation | null;
}

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
  /**
   * All drivers — gzip-compress the finished dump (`.sql.gz`, #1539). Applied after
   * `formatSql`. Off by default. The save path's extension is chosen by the caller.
   */
  gzip?: boolean;
  /**
   * 指定したテーブルだけをダンプする (#1399)。未指定 / null はデータベース全体。
   * 空配列は不可 (バックエンドが拒否する)。MySQL ではルーチン / イベントは対象外。
   */
  tables?: string[] | null;
  /** MySQL のみ — `mysqldump --no-tablespaces` (PROCESS 権限が無いユーザ向け, #1624)。 */
  noTablespaces?: boolean;
  /** MySQL のみ — `mysqldump --set-gtid-purged=OFF` (GTID 有効サーバ間の移行向け, #1624)。 */
  setGtidPurgedOff?: boolean;
  /** 全ドライバ — 完成したダンプの SHA-256 を `<保存先>.sha256` に書く (#1624)。 */
  writeChecksum?: boolean;
  /** SQLite のみ — SQL ではなく `VACUUM INTO` による整合したバイナリ・スナップショット (`.db`, #1624)。 */
  sqliteSnapshot?: boolean;
}

// --- タスクスケジューラ (#730) -------------------------------------------

/** タスクが実行するアクション。読み取り専用に限定される (バックエンドが
 *  作成時・実行時の両方で `sql` を検証する)。 */
export type TaskAction =
  | {
      kind: "export_query";
      sql: string;
      database: string | null;
      format: ExportFormat;
      /** 出力先パス。`{date}` / `{datetime}` プレースホルダに対応 (UTC)。 */
      output_path: string;
      /** SQL INSERT 形式のときの対象テーブル名。他形式では無視。 */
      sql_table?: string | null;
      /** SQL INSERT 形式のときの 1 文あたり行数。他形式では無視。 */
      sql_batch_size?: number | null;
    }
  | {
      kind: "dump";
      database: string;
      output_path: string;
      options: DumpOptions;
    }
  | {
      /** 保存済みデータ品質アサーション (#742) の定期実行 (#1170)。 */
      kind: "run_assertions";
      /** 対象データベース。未指定 (null) ならプロファイルの既定。 */
      database?: string | null;
      /** 実行するアサーション ID。空ならプロファイルのスコープに合うものすべて。 */
      assertion_ids: string[];
      /** true: 失敗件数が前回の実行より増えたときだけ失敗扱い (通知) にする (#1537)。 */
      notify_only_on_increase?: boolean;
    }
  | {
      /** ウォッチ中のテーブルのスナップショットを無人で取得する (#1537)。 */
      kind: "timelapse_capture";
      /** 1 ウォッチあたりの保持世代数の上限。未指定ならタイムラプスの既定値。 */
      max_generations?: number | null;
    }
  | {
      /** ウォッチ中の EXPLAIN を再取得し、警告相当の変化だけを失敗扱い (通知) にする (#1537)。 */
      kind: "refresh_plan_watch";
      /** 対象スニペット ID。空ならこのプロファイルでウォッチ中のものすべて。 */
      snippet_ids: string[];
    };

/** 接続失敗時の自動リトライ設定 (#1537)。接続段階の失敗だけを指数バックオフで再試行する。 */
export interface ConnectRetry {
  /** 初回失敗後の再試行回数 (0 = しない、上限 10)。 */
  max_retries: number;
  /** 最初の待機秒数 (5〜3600)。以降 2 倍ずつ伸びる (上限 15 分)。 */
  interval_secs: number;
}

/**
 * タスクの発火スケジュール。`daily` の時刻は `timezone` (IANA 名) のローカル時刻で、
 * 省略 / null は UTC (旧データ)。`weekdays` は月 = bit0 … 日 = bit6 のマスクで、
 * 0 / 省略は毎日 (曜日は `timezone` のローカル日付で判定, #1621)。
 */
export type TaskSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "daily"; hour: number; minute: number; timezone?: string | null; weekdays?: number };

export interface TaskDefinition {
  id: string;
  name: string;
  profile_id: string;
  action: TaskAction;
  schedule: TaskSchedule;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  connect_retry: ConnectRetry;
  /** 連続この回数失敗したら自動で一時停止する (0 = しない, #1621)。 */
  pause_after_failures: number;
  /** 現在の連続失敗回数 (成功で 0 に戻る)。 */
  consecutive_failures: number;
  /** 連続失敗で自動停止した時刻 (手動で再有効化すると null)。 */
  auto_paused_at: string | null;
}

export interface SaveTaskRequest {
  id?: string | null;
  name: string;
  profile_id: string;
  action: TaskAction;
  schedule: TaskSchedule;
  enabled: boolean;
  connect_retry?: ConnectRetry;
  /** 連続失敗で自動停止するまでの回数 (0 / 省略 = しない, #1621)。 */
  pause_after_failures?: number;
}

/** 1 回分のタスク実行ログ (`task_runs.sqlite`、クエリ履歴とは別)。 */
export interface TaskRun {
  id: number;
  task_id: string;
  started_at: string;
  finished_at: string;
  status: string;
  error: string | null;
  output_path: string | null;
  rows: number | null;
  bytes: number | null;
  elapsed_ms: number;
  catch_up: boolean;
  /** 接続を試みた回数 (#1537)。2 以上なら接続リトライが働いた。 */
  attempts: number;
}

/** アサーション実行タスクの 1 アサーション分の合否履歴 (#1170)。 */
export interface AssertionRunRecord {
  id: number;
  task_id: string;
  run_started_at: string;
  assertion_id: string;
  assertion_name: string;
  passed: boolean;
  /** 実行エラーで取れなかったときは null。 */
  observed: number | null;
  error: string | null;
  elapsed_ms: number;
}

export interface SchedulerSettings {
  /** true: アプリ非起動中に過ぎたスケジュールを次回起動時に 1 回だけ追い掛け
   *  実行する。false (既定): 過ぎた分はスキップする。 */
  catch_up_missed: boolean;
}

/**
 * Source data format for an import. CSV uses the delimiter/quote/header options;
 * JSON (array of objects) and NDJSON (one object per line) key rows by field
 * name and ignore those options. "xlsx" (#1171) reads one sheet of an Excel
 * workbook (`sheet`, default: the first) and uses only `hasHeader`. Defaults to
 * "csv" on the backend if omitted.
 */
export type ImportFormat = "csv" | "json" | "ndjson" | "xlsx";

/** How the importer handles rows the database rejects (#687). */
export type ImportErrorMode = "abort" | "skip";

/**
 * How the importer treats a row whose key already exists (#972).
 * `"insert"` (default) issues a plain INSERT, so a duplicate key is a row
 * error handled by `errorMode`; `"skip"` leaves the existing row untouched;
 * `"update"` overwrites it with the imported values (UPSERT).
 */
export type ImportConflictMode = "insert" | "skip" | "update";

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
  /** Duplicate-key handling (#972). Omitted → `"insert"`. */
  conflictMode?: ImportConflictMode;
  /**
   * Destination columns identifying a row for `conflictMode` `"skip"` /
   * `"update"`. Must be a non-empty subset of the mapped columns in those
   * modes (the backend rejects anything else); ignored for `"insert"`.
   */
  keyColumns?: string[];
  /** xlsx のシート名 (#1171)。省略 / 空 → 先頭シート。他の形式では無視される。 */
  sheet?: string | null;
}

/**
 * 新規テーブル作成付きインポート (#985) の列型。バックエンドの
 * `db::create_table::NewColumnType` と 1:1 (方言ごとの型名への変換と縮退は
 * バックエンドが行う)。
 */
export type NewColumnType =
  | "integer"
  | "bigint"
  | "decimal"
  | "double"
  | "boolean"
  | "date"
  | "datetime"
  | "text";

/** 新規テーブルの 1 列 (#985)。 */
export interface NewTableColumn {
  name: string;
  type: NewColumnType;
  /** 主キーに含める (#1623)。複数列なら複合主キー。主キー列は NOT NULL になる。 */
  primaryKey?: boolean;
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
  /** xlsx ブックの全シート名 (ブック順、#1171)。他の形式では空配列。 */
  sheets: string[];
}

/**
 * ローカル横断クエリ (#740) — ローカルエンジンへ登録された 1 テーブルの由来情報。
 * 取り込みそのものは接続情報を持ち出さないので、ここに含まれるのは表示用の
 * ラベル (プロファイル名・実行 SQL・ドライバ) と件数/日時のみ。
 */
export interface LocalTableMeta {
  name: string;
  source_profile: string | null;
  /** 元の接続のプロファイル id (#1541)。旧データは null (名前で照合する)。 */
  source_profile_id: string | null;
  source_sql: string;
  source_driver: string | null;
  /** 元の SQL を実行した DB (#1541)。記録していない (旧データ・SQLite) 場合は null。 */
  source_database: string | null;
  /** 登録時刻 (epoch ミリ秒)。`new Date(fetched_at_ms)` でそのまま使える。 */
  fetched_at_ms: number;
  row_count: number;
}

export interface RegisterLocalTableRequest {
  sessionId: string;
  tableName: string;
  columns: Column[];
  /** 取り込む行。`resultId` 指定時は使われない (空配列でよい)。 */
  rows: CellValue[][];
  /** 結果ハンドル (#1264)。指定時はバックエンド保持の行を取り込む。 */
  resultId?: string | null;
  sourceProfile?: string | null;
  /** 元の接続のプロファイル id (#1541)。 */
  sourceProfileId?: string | null;
  sourceSql: string;
  sourceDriver?: string | null;
  /** 元の SQL を実行した DB (#1541)。再取得で同じ DB へ流すために保存する。 */
  sourceDatabase?: string | null;
}

/**
 * フロントから Rust を呼ぶ唯一の入口。ラッパー本体は `./commands/<module>.ts`
 * (`src-tauri/src/commands/<module>.rs` と 1 対 1) に置き、ここでは束ねるだけにする。
 * 新しいコマンドは対応するモジュールのファイルへ足す (モジュールを新設したときだけ
 * ここに 1 行足す)。
 */
export const api = {
  ...connectionCommands,
  ...localCommands,
  ...sshCommands,
  ...queryCommands,
  ...bulkWriteCommands,
  ...broadcastCommands,
  ...schemaCommands,
  ...tableOpenCommands,
  ...schemaTreeCommands,
  ...serverCommands,
  ...advisorCommands,
  ...processCommands,
  ...inspectorCommands,
  ...profileCommands,
  ...searchCommands,
  ...diffCommands,
  ...syncCommands,
  ...privilegesCommands,
  ...sandboxCommands,
  ...profilesCommands,
  ...profileBackupCommands,
  ...snippetsCommands,
  ...assertionsCommands,
  ...historyCommands,
  ...logsCommands,
  ...exportCommands,
  ...resultCommands,
  ...dumpCommands,
  ...dumpToolsCommands,
  ...importCommands,
  ...importTemplatesCommands,
  ...scriptCommands,
  ...transferCommands,
  ...fileCommands,
  ...windowCommands,
  ...cellBlobCommands,
  ...flightRecorderCommands,
  ...timelapseCommands,
  ...schemaDriftCommands,
  ...planWatchCommands,
  ...tasksCommands,
  ...aiCommands,
};

/** `cancelStream` の戻り値 (#685)。`cancelled` が `false` のときはストリームが
 *  既に終わっていた (または存在しなかった) ことを意味し、`deliveredRows` は 0。 */
export interface CancelStreamResult {
  cancelled: boolean;
  deliveredRows: number;
}

/** キャンセル成立時に `csv-import:cancelled` / `export-stream:cancelled` /
 *  `dump-stream:cancelled` として届く共通ペイロード (#685)。クエリ/プレビュー
 *  ストリームは #1096 でこのイベントを卒業し、下の `ChannelCancelledMessage`
 *  (streamId を持たない、チャンネル自体がスコープ) を使う。 */
export interface StreamCancelledEvent {
  streamId: string;
  deliveredRows: number;
}

// --- クエリ/プレビュー ストリーミングメッセージ (Tauri Channel, #1096) -----
//
// 以下は `runQueryStream` / `previewQueryStream` が内部で生成する Channel から
// 届くメッセージ形状。1 ストリームにつき 1 チャンネルなのでスコープが自明になり、
// 旧 `query-stream:*` / `preview-stream:*` イベントが個々に運んでいた `streamId`
// を持たない (payload 削減、#1096)。

export interface QueryStreamColumnsMessage {
  columns: Column[];
}

/** `result_find` の戻り値 (#1264)。 */
export interface ResultFindOutput {
  hits: { rowIdx: number; colIdx: number }[];
  /** 打ち切りを含む総ヒット数。 */
  total: number;
  /** `hits` が `limit` で打ち切られたか。 */
  truncated: boolean;
}

/** `result_duplicate_keys` の戻り値 (#1628)。 */
export interface ResultDuplicateKeys {
  rowCount: number;
  /** キー列のどれかが NULL で対象外にした行数。 */
  nullKeyRows: number;
  distinctKeys: number;
  /** 2 行以上で現れたキー値の数。 */
  groupCount: number;
  /** 重複グループに属する行の総数。 */
  duplicateRows: number;
  /** 各グループの 2 行目以降の行数の合計。 */
  extraRows: number;
  top: { values: string[]; count: number; firstRow: number }[];
  /** 重複グループに属する行のインデックス (昇順、上限あり)。 */
  rowIndices: number[];
  indicesTruncated: boolean;
}

/** `result_column_stats` の戻り値 (#1264)。`gridStats.ts::ColumnStats` と同形。 */
export interface ResultColumnStats {
  count: number;
  nullCount: number;
  nonNullCount: number;
  distinctCount: number;
  numericCount: number;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  minLen: number | null;
  maxLen: number | null;
  mode: { value: string; count: number } | null;
}

/** ストリーム中に Rust が逐次更新した列統計 (#1257, `StreamStatsSnapshot`)。 */
export interface StreamStatsSnapshot {
  /** 観測した総行数。手元の `rows.length` と一致するときだけ採用する。 */
  rowCount: number;
  nullCounts: number[];
  numMin: (number | null)[];
  numMax: (number | null)[];
  /** 全列が同一の行が 2 行以上あるか (`null` = 追跡上限超えで不明)。 */
  duplicateRows: boolean | null;
  /** 列ごとの近似ユニーク数 (HyperLogLog、#1628)。非 NULL 値が無い列は 0。 */
  distinctEstimates?: number[];
}

export interface QueryStreamRowsMessage {
  rows: CellValue[][];
  /** この送信分までの累積統計 (#1257)。無ければ JS 側で再計算する。 */
  stats?: StreamStatsSnapshot | null;
}

/** パッチの 1 区間 (#1257)。`keep` は前回行の `from` から `count` 行のコピー、
 *  `rows` は実データの行 (`prev[i]` は対応する前回行の位置、追加行は null)。 */
export type QueryStreamPatchRun =
  | { type: "keep"; from: number; count: number }
  | { type: "rows"; prev: (number | null)[]; rows: CellValue[][] };

export interface QueryStreamPatchMessage {
  totalRows: number;
  /** 全行が前回と同一 (`runs` は空)。 */
  unchanged: boolean;
  /** 前回にあって今回に対応が無い行数。 */
  removedCount: number;
  /** 前回に対応が無い (新しく現れた) 行数 (#1621)。 */
  addedCount: number;
  /** 前回と対応するが値が変わった行数 (#1621)。 */
  changedCount: number;
  runs: QueryStreamPatchRun[];
}

/** 自動 LIMIT を付与しなかった理由 (#1534)。バックエンド `AutoLimitSkip` と同じ camelCase。 */
export type AutoLimitSkip = "existingLimit" | "lockingClause" | "aggregateOnly" | "notApplicable";

export interface QueryStreamDoneMessage {
  totalRows: number;
  rowsAffected: number;
  elapsedMs: number;
  hasColumns: boolean;
  /** Row cap auto-injected for this run, or null when none was applied. */
  appliedAutoLimit: number | null;
  /** 自動 LIMIT を要求したが付与しなかった理由 (#1534)。 */
  autoLimitSkip?: AutoLimitSkip | null;
  /** サーバの通知・警告 (PostgreSQL NOTICE/WARNING、MySQL SHOW WARNINGS) (#1165)。 */
  serverMessages?: ServerMessage[];
  /** 全行を観測し終えた統計 (#1257)。 */
  stats?: StreamStatsSnapshot | null;
  /** 自動リフレッシュ差分 (#1257) の比較元スナップショット ID (保持しなければ null)。 */
  snapshotId?: number | null;
  /** 実行した SQL が読み取り専用か (バックエンドの判定値。再計算しなくてよい、#1256)。 */
  readOnly: boolean;
  /** 実行した SQL がスキーマを変えうるか (バックエンドの判定値、#1256)。 */
  schemaMayChange: boolean;
  /** 結果ハンドル (#1264)。全行をバックエンドに保持できたときの ID (保持しなければ null)。 */
  resultId?: string | null;
}

export interface QueryStreamErrorMessage {
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

/** Query チャンネル・Preview チャンネルどちらでも同じ shape (#685)。 */
export interface ChannelCancelledMessage {
  deliveredRows: number;
}

// --- エディタのバッチ実行 (Tauri Channel, #1256) ---------------------------

/** バッチ実行で 1 文ぶんの結果。`sqlScript.ts` の `BatchStatementResult` に
 *  サーバメッセージ (出力ログ用) を足した wire 形。 */
export interface BatchStreamStatementResult {
  sql: string;
  status: "ok" | "error" | "skipped";
  columns?: Column[];
  rows?: CellValue[][];
  rowsAffected?: number;
  elapsedMs?: number;
  error?: string;
  serverMessages?: ServerMessage[];
  /** `rows` がプレビュー上限で切り詰められている (まだ続きの行がある、#1534)。 */
  truncated?: boolean;
  /** 結果セットの総行数。取得を途中で打ち切ったときは数えていないので省略される。 */
  totalRows?: number;
}

export interface BatchStreamStartedMessage {
  /** 分割後の文の数。 */
  total: number;
}

export interface BatchStreamResultsMessage {
  /** 前回の通知以降に終わった文の結果 (実行順)。 */
  results: BatchStreamStatementResult[];
}

export interface BatchStreamDoneMessage {
  ok: number;
  errors: number;
  skipped: number;
  elapsedMs: number;
  /** 全体を 1 つのトランザクションで包んで実行した (#1626)。 */
  wrapped: boolean;
  /** `wrapped` でエラーがあり、成功扱いの文も含めて全部取り消した (#1626)。 */
  rolledBack: boolean;
  /** DML を記録したときのバッチ id (#1626)。記録が無ければ null。 */
  batchId: string | null;
  /** 記録できた DML の数 / 記録を辞退した DML の数 (#1626)。 */
  captured: number;
  captureSkipped: number;
}

export interface BatchStreamErrorMessage {
  error: string;
  connectionLost: boolean;
}

export interface BatchStreamCancelledMessage {
  deliveredStatements: number;
}

export interface BatchStreamHandlers {
  onStarted?: (event: BatchStreamStartedMessage) => void;
  onResults?: (event: BatchStreamResultsMessage) => void;
  onDone?: (event: BatchStreamDoneMessage) => void;
  onError?: (event: BatchStreamErrorMessage) => void;
  onCancelled?: (event: BatchStreamCancelledMessage) => void;
}

export interface PreviewStreamMetaMessage {
  targetTable: string | null;
  columns: Column[];
  primaryKey: string[];
  rowsAffected: number;
  elapsedMs: number;
  truncated: boolean;
}

export interface PreviewStreamRowsMessage {
  rows: CellValue[][];
}

export interface PreviewStreamErrorMessage {
  error: string;
  /** True when the dry-run was aborted by the execution-timeout guard. */
  timedOut: boolean;
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

/** スキップ行の書き出し形式 (#1623)。`csv` / `ndjson` は元の行データを書き出す。 */
export type SkippedExportFormat = "text" | "csv" | "ndjson";

/** 取り込みの事前検証 (dry run) の結果 (#1623)。 */
export interface ImportDryRunResult {
  total: number;
  failed: number;
  /** 拒否された行の先頭一部。 */
  failures: SkippedRowInfo[];
  /** false: 新規テーブル作成を伴うため DB への試し書きはしていない。 */
  dbChecked: boolean;
}

/** 保存済みの取り込みマッピング (#1623)。 */
export interface ImportTemplateColumn {
  column: string;
  header?: string | null;
  csvIndex: number;
}

export interface ImportTemplate {
  id: string;
  profileId: string;
  database?: string | null;
  table: string;
  format: string;
  delimiter: string;
  quote: string;
  hasHeader: boolean;
  nullToken?: string | null;
  encoding: string;
  sheet?: string | null;
  conflictMode?: string | null;
  errorMode?: string | null;
  keyColumns: string[];
  mapping: ImportTemplateColumn[];
  updatedAtMs: number;
}

export interface ImportDoneEvent {
  streamId: string;
  inserted: number;
  elapsedMs: number;
  /**
   * Rows skipped in skip mode (empty in abort mode). #687. 多いときは先頭の一部
   * だけ (#1258)。全件は `skippedTotal` と {@link api.saveImportSkippedRows} 側。
   */
  skipped: SkippedRowInfo[];
  /** スキップされた総件数 (`skipped` に載っていない行を含む)。 */
  skippedTotal: number;
  /** 件数が多く、一部のスキップ行の元の行データを保持していない (#1623)。 */
  skippedDataTruncated?: boolean;
  /** 複数シート一括取り込み (#1623) のシートごとの結果。通常の取り込みでは空。 */
  sheets: SheetImportResult[];
}

/** 複数シート一括取り込みの 1 シートぶんの結果 (#1623)。 */
export interface SheetImportResult {
  sheet: string;
  table: string;
  inserted: number;
  skippedTotal: number;
}

/** 複数シート一括取り込みの 1 シートぶんの指定 (#1623)。 */
export interface SheetImportSpec {
  sheet: string;
  table: string;
  mapping: ColumnMapping[];
  createTable?: NewTableColumn[] | null;
}

/** BLOB セルの probe 結果 (#1258)。本体を運ばずサイズと種別だけ。 */
export interface CellBlobProbe {
  /** 生バイト数。 */
  size: number;
  /** 推定 MIME (判別不能なら null)。 */
  mime: string | null;
  /** 保存ダイアログの既定拡張子 (ドット無し。判別不能なら null)。 */
  ext: string | null;
  /** `<img>` でそのまま描画できる画像か。 */
  image: boolean;
}

/** BLOB 列のフォルダ一括保存の結果 (#1539)。 */
export interface BlobFolderSaveResult {
  /** 保存したファイル数。 */
  saved: number;
  /** 保存した合計バイト数。 */
  totalBytes: number;
  /** NULL のセルで保存しなかった行数。 */
  skippedNull: number;
  /** 上限 (16 MiB) を超えて保存しなかった行数。 */
  skippedTooLarge: number;
  /** 取得・書き込みに失敗した行数。 */
  failed: number;
  /** 失敗した行の理由 (先頭 20 件まで。`row` は渡した keys の添字)。 */
  errors: { row: number; error: string }[];
  /** 対応表 (CSV) を書いたときのフォルダ内のファイル名。書かなかったときは null (#1624)。 */
  manifestFile: string | null;
}

export interface ImportErrorEvent {
  streamId: string;
  error: string;
  /** For an abort-mode failure, the pinpointed record number + CSV line (#687). */
  record: number | null;
  line: number | null;
  /** 全体障害で中断するまでにコミット済みの行数 (skip モードのみ。無ければ null)。 */
  committed: number | null;
}

// 全件ストリーミングエクスポート。
export interface ExportProgressEvent {
  streamId: string;
  rows: number;
}
export interface ExportDoneEvent {
  streamId: string;
  /** クエリから読んだ行数 (xlsx で上限を超えた行も含む)。 */
  rows: number;
  bytes: number;
  /** xlsx で Excel の上限に当たったときだけ非 null (#711)。 */
  truncation: ExportTruncation | null;
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

/** 接続間データ転送 (#986) で既存テーブルと衝突したときの扱い。 */
export type TransferMode = "create" | "replace" | "append" | "upsert";

export interface TransferRequest {
  sourceSessionId: string;
  targetSessionId: string;
  sourceDatabase?: string | null;
  /** テーブル全件を転送するときのテーブル名 (`sourceSql` と排他)。 */
  sourceTable?: string | null;
  /** 単一の読み取り専用クエリの結果を転送するときの SQL (`sourceTable` と排他)。 */
  sourceSql?: string | null;
  targetDatabase?: string | null;
  targetTable: string;
  mode: TransferMode;
  batchSize?: number | null;
  /** `mode === "upsert"` の衝突方針。省略は `update` (#1539)。 */
  conflictMode?: "skip" | "update" | null;
  /** `mode === "upsert"` の衝突判定キー列。省略 / 空は転送先テーブルの主キー (#1539)。 */
  keyColumns?: string[] | null;
  /** 列の除外・改名・型上書き (#1623)。指定のない列はそのまま転送する。 */
  columns?: TransferColumnSpec[];
  /** テーブル元の絞り込み (WHERE の後ろに置く式。#1623)。クエリ元では指定できない。 */
  whereClause?: string | null;
  /** 先頭 N 行だけ転送する試験転送 (#1623)。省略は全件。 */
  limitRows?: number | null;
  /** 転送後に件数を照合する (#1623)。省略は true。 */
  verifyCounts?: boolean | null;
}
/** 転送先の論理型 (列ごとの型上書き, #1623)。 */
export type TransferTypeKind =
  | "boolean"
  | "integer"
  | "float"
  | "decimal"
  | "text"
  | "date"
  | "time"
  | "timestamp"
  | "timestamptz"
  | "binary"
  | "json"
  | "uuid";
export interface TransferTypeOverride {
  kind: TransferTypeKind;
  /** `decimal` のみ。 */
  precision?: number | null;
  scale?: number | null;
}
/** 転送する列 1 つへの指定 (#1623)。`source` はソースが返した列名。 */
export interface TransferColumnSpec {
  source: string;
  /** 転送先での列名 (別名)。 */
  name?: string | null;
  /** true なら転送しない。 */
  exclude?: boolean;
  /** 自動判定ではなくこの型にする。 */
  type?: TransferTypeOverride | null;
}
export type TransferLossyKind = "decimal_clamped" | "decimal_float" | "timestamp_tz_degraded";
export interface TransferLossyConversion {
  column: string;
  kind: TransferLossyKind;
  sourceType: string;
  targetType: string;
}
export interface TransferPreview {
  columns: { name: string; sourceType: string; targetType: string }[];
  /** 指定を適用する前のソースの全列と自動判定した型 (#1623)。 */
  sourceColumns: { name: string; sourceType: string; targetType: string }[];
  lossy: TransferLossyConversion[];
}
export interface TransferProgressEvent {
  streamId: string;
  rows: number;
}
export interface TransferDoneEvent {
  streamId: string;
  rows: number;
  elapsedMs: number;
  warnings: string[];
  /** 件数照合 (#1623) の食い違い。`warnings` の部分集合。 */
  integrityWarnings: string[];
}
export interface TransferErrorEvent {
  streamId: string;
  message: string;
  rows: number;
}
export interface TransferStreamHandlers {
  onProgress?: (event: TransferProgressEvent) => void;
  onDone?: (event: TransferDoneEvent) => void;
  onError?: (event: TransferErrorEvent) => void;
  /** `cancelStream` が転送を中断したとき。`deliveredRows` は書き込み済み行数。 */
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

/** `.sql` スクリプト実行のオプション (#973)。2 つは排他 (両方 true はバックエンドが拒否)。 */
export interface ScriptOptions {
  /** 失敗した文をスキップして続行し、最後に失敗一覧を返す。 */
  continueOnError: boolean;
  /** 全体を 1 トランザクションで包む (失敗・キャンセルで ROLLBACK)。 */
  wrapInTransaction: boolean;
  /**
   * スクリプトが BEGIN したまま COMMIT / ROLLBACK なしで終わったときの扱い (#1626)。
   * 既定は `rollback` (EOF で取り消す)。`commit` で EOF に確定する。`wrapInTransaction` には影響しない。
   */
  unclosedTx: "rollback" | "commit";
  /** ファイルの文字コード (#1535)。`null` は自動判定 (BOM → UTF-8 → Shift_JIS / EUC-JP)。 */
  encoding: TextEncodingId | null;
  /**
   * この通し番号 (1 始まり、トランザクション制御文を含む) より前の文を実行せず読み飛ばす
   * (#1535)。失敗した文からの再開に使う。0 は先頭から。
   */
  startAtStatement: number;
  /**
   * 実行せず読み飛ばす文の通し番号 (事前確認の一覧での個別除外、#1535)。BEGIN / COMMIT /
   * ROLLBACK の番号は指定されても無視される (バックエンドが常に実行する)。
   */
  skipStatements: number[];
  /**
   * 事前確認をしたときのファイルの大きさ・更新時刻 (`ScriptAnalyzedEvent.fileStamp`)。
   * 実行時のファイルと違えば、文番号がずれるので実行前にエラーになる (#1535)。
   */
  expectedFile?: ScriptFileStamp | null;
}

/** ファイルの大きさと更新時刻 (ミリ秒)。事前確認の後でファイルが変わっていないかの照合用。 */
export interface ScriptFileStamp {
  size: number;
  mtimeMs: number;
}

/**
 * SQL ファイルの文字コード識別子 (#1535)。Rust `TextEncoding` の serde 名と一致する。
 * `utf-8-bom` / `utf-16*` は保存時に BOM を付ける。
 */
/** About 面から開けるプロジェクトのリンク (Rust の `ProjectLink`, #1770)。 */
export type ProjectLink = "repository" | "docs";

export type TextEncodingId = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "shift_jis" | "euc-jp";

/** `read_sql_file` の戻り値: 本文と実際に使った文字コード (保存時に同じ文字コードへ戻す)。 */
export interface SqlFileContent {
  content: string;
  encoding: TextEncodingId;
}

/** `preview_sql_file_encodings` の候補 1 つ分 (#1627)。`valid` は先頭バイトに不正が無かったか。 */
export interface SqlEncodingCandidatePreview {
  encoding: TextEncodingId;
  valid: boolean;
  lines: string[];
}

/** `preview_sql_file_encodings` の戻り値 (#1627): 自動判定の結果と、候補ごとの先頭数行。 */
export interface SqlEncodingPreview {
  detected: TextEncodingId | null;
  detectError: string | null;
  candidates: SqlEncodingCandidatePreview[];
}

/** 事前確認で検出する危険な文の種別 (`src/dangerousSql.ts` の `DangerKind` と同じ名前)。 */
/** INSERT の対象テーブル別の集計 (#1626)。`rows` は VALUES のタプル数の概算 (INSERT ... SELECT は 0)。 */
export interface ScriptInsertTable {
  table: string;
  statements: number;
  rows: number;
}

export type ScriptDangerKind =
  | "deleteNoWhere"
  | "updateNoWhere"
  | "drop"
  | "truncate"
  | "dropColumn"
  | "dropConstraint";

/** 事前確認の一覧の 1 文。`index` は実行時の通し番号 (`ScriptFailure.index`) と同じ。 */
export interface ScriptAnalyzedStatement {
  index: number;
  line: number;
  sql: string;
  category: "read" | "write" | "ddl" | "txControl";
  danger?: ScriptDangerKind;
  /** 読み取り専用セッションで実行時に拒否される文。 */
  blocked: boolean;
}

/** 事前確認 (`analyze_sql_script`) の集計。一覧は上限つきで、全文は保持しない。 */
export interface ScriptAnalysis {
  totalStatements: number;
  categories: { read: number; write: number; ddl: number; txControl: number };
  dangerCounts: {
    deleteNoWhere: number;
    updateNoWhere: number;
    drop: number;
    truncate: number;
    dropColumn: number;
    dropConstraint: number;
  };
  /** INSERT の対象テーブル別の文数・概算行数 (概算行数の多い順、上限あり, #1626)。 */
  insertTables: ScriptInsertTable[];
  /** 上限を超えて別集計できなかった表への INSERT の文数。0 でなければ `insertTables` は一部のみ。 */
  insertTablesOverflow: number;
  dangerousTotal: number;
  blockedTotal: number;
  txControlTotal: number;
  /** 先頭 `headLimit` 文 (個別除外の対象)。 */
  head: ScriptAnalyzedStatement[];
  /** 危険文の先頭 `listLimit` 件。 */
  dangerous: ScriptAnalyzedStatement[];
  /** トランザクション制御文の位置 (先頭 `listLimit` 件)。 */
  txControls: { index: number; line: number; kind: "begin" | "commit" | "rollback" }[];
  headLimit: number;
  listLimit: number;
  /** BEGIN したまま COMMIT / ROLLBACK なしで終わるスクリプトか。 */
  unclosedTransaction: boolean;
}

export interface ScriptAnalyzedEvent {
  streamId: string;
  encoding: TextEncodingId;
  totalBytes: number;
  /** 事前確認したときのファイルの大きさ・更新時刻。実行時に `expectedFile` として渡す。 */
  fileStamp: ScriptFileStamp;
  elapsedMs: number;
  analysis: ScriptAnalysis;
}

/** 失敗した 1 文。`index` はスクリプト内の通し番号、`line` はファイル内の開始行 (1 始まり)。 */
export interface ScriptFailure {
  index: number;
  line: number;
  sql: string;
  error: string;
}

export interface ScriptProgressEvent {
  streamId: string;
  executed: number;
  failed: number;
  bytesRead: number;
  totalBytes: number;
  elapsedMs: number;
}

export interface ScriptDoneEvent {
  streamId: string;
  executed: number;
  succeeded: number;
  failedCount: number;
  failures: ScriptFailure[];
  /** wrap-in-transaction で読み飛ばしたスクリプト内の BEGIN/COMMIT 等の数。 */
  skippedControl: number;
  /** 事前確認で個別除外して読み飛ばした文の数 (#1535)。 */
  skippedExcluded: number;
  /** 開始位置より前で読み飛ばした文の数 (#1535)。 */
  skippedBeforeStart: number;
  /** BEGIN したまま終わったスクリプトを EOF でランナーが取り消した (ROLLBACK) か。 */
  implicitRollback: boolean;
  /** 同じく BEGIN したまま終わったスクリプトを、利用者の選択で EOF に確定した (COMMIT) か (#1626)。 */
  implicitCommit: boolean;
  rowsAffected: number;
  elapsedMs: number;
}

export interface ScriptErrorEvent {
  streamId: string;
  error: string;
  failure: ScriptFailure | null;
  executed: number;
  /** 開いていたトランザクションを ROLLBACK したか。 */
  rolledBack: boolean;
  /**
   * 失敗した時点でトランザクションが開いていたか (ROLLBACK の成否に関係なく true)。
   * 開いていたなら失敗した文だけからの再開は欠けた範囲を残すので出さない。
   */
  inTransaction: boolean;
  /** 開いていたトランザクションを始めた BEGIN 文の通し番号 (全体を包む実行では `null`)。 */
  txBeginStatement: number | null;
}

export interface ScriptStreamHandlers {
  onProgress?: (event: ScriptProgressEvent) => void;
  /** 事前確認 (`analyzeSqlScript`) の完了 (#1535)。 */
  onAnalyzed?: (event: ScriptAnalyzedEvent) => void;
  onDone?: (event: ScriptDoneEvent) => void;
  onError?: (event: ScriptErrorEvent) => void;
  /** `deliveredRows` は確定済み (キャンセル後も残る) 文の数。 */
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
  onColumns?: (event: QueryStreamColumnsMessage) => void;
  onRows?: (event: QueryStreamRowsMessage) => void;
  /** 自動リフレッシュの差分パッチ (#1257)。`refreshDiff` 付きの実行でだけ届く。 */
  onPatch?: (event: QueryStreamPatchMessage) => void;
  onDone?: (event: QueryStreamDoneMessage) => void;
  onError?: (event: QueryStreamErrorMessage) => void;
  /** See `ExportStreamHandlers.onCancelled` (#685). Fired through the same
   *  Channel as the other messages, not a broadcast event (#1096). */
  onCancelled?: (event: ChannelCancelledMessage) => void;
}

export interface PreviewStreamHandlers {
  onMeta?: (event: PreviewStreamMetaMessage) => void;
  onBeforeRows?: (event: PreviewStreamRowsMessage) => void;
  onAfterRows?: (event: PreviewStreamRowsMessage) => void;
  onDone?: () => void;
  onError?: (event: PreviewStreamErrorMessage) => void;
  /** See `ExportStreamHandlers.onCancelled` (#685). Fired through the same
   *  Channel as the other messages, not a broadcast event (#1096). */
  onCancelled?: (event: ChannelCancelledMessage) => void;
}

/**
 * Await a set of `listen()` registrations failure-safe: if any registration
 * rejects, unlisten every one that already resolved before rethrowing, so a
 * partial failure never leaks a live listener. On success, returns a single
 * unlisten function that detaches all of them. The registration promises are
 * passed already-started, so they still register concurrently.
 */
async function registerListeners(registrations: Array<Promise<UnlistenFn>>): Promise<UnlistenFn> {
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

// --- クエリ/プレビュー ストリーミング (Tauri Channel, #1096) ----------------
//
// 旧実装は `query-stream:*` / `preview-stream:*` という名前付きイベントを
// `listen()` で (ストリームごとに 5〜6 本) 購読し、`payload.streamId` で自分宛て
// かどうかを毎回判定していた。Tauri の `Channel` は 1 回の invoke に紐づく専用
// チャンネルなので、(1) `streamId` によるフィルタが要らず (チャンネル自体が
// スコープ)、(2) 大きな行チャンクは `webview.eval()` へのインライン展開ではなく
// fetch 経由の受け渡しに切り替わる (`@tauri-apps/api` `core.js` / tauri
// `ipc/channel.rs` 参照) ため大きなペイロードほど効く。
//
// `listenQueryStream`/`listenPreviewStream` は呼び出し側 (App.tsx) から見た
// 「まず listen* を呼んで unlisten 相当の関数を受け取り、そのあとで
// `api.runQueryStream`/`api.previewQueryStream` を呼ぶ」という既存の 2 段階の
// 呼び出し順をそのまま保つ — 内部では `listen()` の代わりに Channel を生成して
// `streamId` ごとのレジストリへ登録するだけで、後続の invoke がそこから
// チャンネルを取り出して `onEvent` 引数として渡す。

/** Channel から届く生メッセージの最小形。`kind` で分岐する。 */
type RawStreamMessage = { kind: string } & Record<string, unknown>;

/**
 * `parseResponse` は引数の静的型をそのまま返り値の型にする (`T` は `schema` では
 * なく `value` から推論される) ため、`RawStreamMessage` (index signature 型) を
 * そのまま渡すと呼び出し側が期待する具象型 (`QueryStreamColumnsMessage` 等) に
 * 構造的に代入できず型エラーになる。ここで明示的に型引数を渡して変換する薄い
 * ラッパー — 実行時の検証は `parseResponse`/`schema.safeParse` がそのまま行う
 * ので安全性は変わらない。
 */
function parseChannelMessage<T>(
  schema: Parameters<typeof parseResponse>[0],
  raw: RawStreamMessage,
  command: string,
): T {
  return parseResponse(schema, raw as unknown as T, command);
}

/**
 * Subscribes to the query-stream Channel that will be created for `streamId`.
 * Returns a function that detaches the handlers — further messages that
 * arrive after detaching (e.g. one already in flight when a cancel raced it)
 * are silently ignored rather than reaching stale callbacks.
 */
export async function listenQueryStream(
  streamId: string,
  handlers: QueryStreamHandlers,
): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "columns":
        handlers.onColumns?.(
          parseChannelMessage<QueryStreamColumnsMessage>(
            schemas.queryStreamColumnsMessage,
            msg,
            "queryStreamColumnsMessage",
          ),
        );
        break;
      case "rows":
        handlers.onRows?.(
          parseChannelMessage<QueryStreamRowsMessage>(
            schemas.queryStreamRowsMessageLite,
            msg,
            "queryStreamRowsMessageLite",
          ),
        );
        break;
      case "patch":
        handlers.onPatch?.(
          parseChannelMessage<QueryStreamPatchMessage>(
            schemas.queryStreamPatchMessage,
            msg,
            "queryStreamPatchMessage",
          ),
        );
        break;
      case "done":
        handlers.onDone?.(
          parseChannelMessage<QueryStreamDoneMessage>(
            schemas.queryStreamDoneMessage,
            msg,
            "queryStreamDoneMessage",
          ),
        );
        break;
      case "error":
        handlers.onError?.(
          parseChannelMessage<QueryStreamErrorMessage>(
            schemas.queryStreamErrorMessage,
            msg,
            "queryStreamErrorMessage",
          ),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<ChannelCancelledMessage>(
            schemas.channelCancelledMessage,
            msg,
            "channelCancelledMessage",
          ),
        );
        break;
      default:
        // 未知の kind は無視する (将来バリアントが増えても古いフロントが落ちない
        // ようにするための保険。#797 の streamEventParity と同じ「取りこぼしより
        // 静かな無視を優先」の考え方)。
        break;
    }
  };
  queryStreamChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    // 同じ streamId で既に新しい登録に差し替わっていたら、他人のエントリを
    // 消さない (`register_stream`/`forget_stream` のトークン方式と同じ発想)。
    if (queryStreamChannels.get(streamId) === channel) {
      queryStreamChannels.delete(streamId);
    }
  };
}

// --- ブロードキャスト比較 (#1257) -------------------------------------------

/** 基準環境との差分サマリ (`db/broadcast_diff.rs` の `BroadcastDiff`)。変化セルは疎表現。 */
export interface BroadcastDiff {
  comparable: boolean;
  /** "pk": PK ペアリング / "hash": 行ハッシュの多重集合比較 / "none": 比較不能。 */
  mode: "pk" | "hash" | "none";
  changedCells: { row: number; cols: number[] }[];
  changedCellCount: number;
  /** 対象にだけ存在する行の位置 (表示行上の添字)。 */
  addedRowIndices: number[];
  /** 基準にだけ存在した行の件数。 */
  removedCount: number;
  /** 基準にだけ存在した行の位置 (基準の表示行上の添字, #1625)。 */
  removedRowIndices: number[];
  /** 比較上限に達して先頭行のみで比較した。 */
  truncated: boolean;
  hasDiff: boolean;
}

export interface BroadcastEnvMessage {
  sessionId: string;
  status: "done" | "error";
  columns: Column[];
  /** 先頭 5,000 行までの表示行。 */
  rows: CellValue[][];
  /** 打ち切り前の総行数。 */
  totalRows: number;
  elapsedMs: number;
  error: string | null;
  /** 基準環境との差分。基準自身・比較できないときは null。 */
  diff: BroadcastDiff | null;
}

export interface BroadcastHandlers {
  onEnv?: (event: BroadcastEnvMessage) => void;
  onCancelled?: (event: { sessionId: string }) => void;
  onDone?: () => void;
}

/** 環境ごとの stream id (`cancel_stream` で個別にキャンセルできる)。バックエンドと同じ規則。 */
export function broadcastEnvStreamId(runId: string, sessionId: string): string {
  return `${runId}:${sessionId}`;
}

/**
 * `api.broadcastCompare({ runId })` の結果を受ける Channel を用意する。先に await してから
 * `broadcastCompare` を呼ぶこと。戻り値でハンドラを外す (以後のメッセージは無視される)。
 */
export async function listenBroadcast(runId: string, handlers: BroadcastHandlers): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "env":
        handlers.onEnv?.(
          parseChannelMessage<BroadcastEnvMessage>(schemas.broadcastEnvMessage, msg, "broadcastEnvMessage"),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<{ sessionId: string }>(
            schemas.broadcastCancelledMessage,
            msg,
            "broadcastCancelledMessage",
          ),
        );
        break;
      case "done":
        handlers.onDone?.();
        break;
      default:
        break;
    }
  };
  broadcastChannels.set(runId, channel);
  return () => {
    channel.onmessage = () => {};
    if (broadcastChannels.get(runId) === channel) broadcastChannels.delete(runId);
  };
}

/**
 * エディタのバッチ実行 (`runSqlBatch`, #1256) の Channel を `streamId` 向けに作って
 * 購読する。戻り値は `listenQueryStream` と同じく、ハンドラを外す関数。
 */
export async function listenBatchStream(
  streamId: string,
  handlers: BatchStreamHandlers,
): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "started":
        handlers.onStarted?.(
          parseChannelMessage<BatchStreamStartedMessage>(
            schemas.batchStreamStartedMessage,
            msg,
            "batchStreamStartedMessage",
          ),
        );
        break;
      case "results":
        handlers.onResults?.(
          parseChannelMessage<BatchStreamResultsMessage>(
            schemas.batchStreamResultsMessage,
            msg,
            "batchStreamResultsMessage",
          ),
        );
        break;
      case "done":
        handlers.onDone?.(
          parseChannelMessage<BatchStreamDoneMessage>(
            schemas.batchStreamDoneMessage,
            msg,
            "batchStreamDoneMessage",
          ),
        );
        break;
      case "error":
        handlers.onError?.(
          parseChannelMessage<BatchStreamErrorMessage>(
            schemas.batchStreamErrorMessage,
            msg,
            "batchStreamErrorMessage",
          ),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<BatchStreamCancelledMessage>(
            schemas.batchStreamCancelledMessage,
            msg,
            "batchStreamCancelledMessage",
          ),
        );
        break;
      default:
        // 未知の kind は無視する (`listenQueryStream` と同じ保険)。
        break;
    }
  };
  batchStreamChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    if (batchStreamChannels.get(streamId) === channel) {
      batchStreamChannels.delete(streamId);
    }
  };
}

export interface WhereUsedStreamHandlers {
  onProgress?: (event: WhereUsedProgress) => void;
  onDone?: (event: { report: WhereUsedReport }) => void;
  onError?: (event: { error: string; connectionLost: boolean }) => void;
  onCancelled?: (event: { report: WhereUsedReport }) => void;
}

/**
 * Where-used (`findWhereUsed`, #1261) の Channel を `streamId` 向けに作って購読する。
 * 戻り値は `listenQueryStream` と同じく、ハンドラを外す関数。
 */
export async function listenWhereUsedStream(
  streamId: string,
  handlers: WhereUsedStreamHandlers,
): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "progress": {
        const m = parseChannelMessage<WhereUsedProgress>(
          schemas.whereUsedProgressMessage,
          msg,
          "whereUsedProgressMessage",
        );
        handlers.onProgress?.({ done: m.done, total: m.total });
        break;
      }
      case "done":
        handlers.onDone?.(
          parseChannelMessage<{ report: WhereUsedReport }>(
            schemas.whereUsedDoneMessage,
            msg,
            "whereUsedDoneMessage",
          ),
        );
        break;
      case "error":
        handlers.onError?.(
          parseChannelMessage<{ error: string; connectionLost: boolean }>(
            schemas.whereUsedErrorMessage,
            msg,
            "whereUsedErrorMessage",
          ),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<{ report: WhereUsedReport }>(
            schemas.whereUsedCancelledMessage,
            msg,
            "whereUsedCancelledMessage",
          ),
        );
        break;
      default:
        break;
    }
  };
  whereUsedChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    if (whereUsedChannels.get(streamId) === channel) {
      whereUsedChannels.delete(streamId);
    }
  };
}

export interface DataSearchStreamHandlers {
  /** テーブルの走査を開始した (`index` は 0 始まりの通し番号)。 */
  onProgress?: (event: { index: number; total: number; table: string }) => void;
  onTable?: (event: { entry: DataSearchEntry }) => void;
  onDone?: () => void;
  onError?: (event: { error: string; connectionLost: boolean }) => void;
  onCancelled?: (event: ChannelCancelledMessage) => void;
}

/**
 * 値検索 (`dataSearchStream`, #1261) の Channel を `streamId` 向けに作って購読する。
 * 戻り値は `listenQueryStream` と同じく、ハンドラを外す関数。
 */
export async function listenDataSearchStream(
  streamId: string,
  handlers: DataSearchStreamHandlers,
): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "progress":
        handlers.onProgress?.(
          parseChannelMessage<{ index: number; total: number; table: string }>(
            schemas.dataSearchProgressMessage,
            msg,
            "dataSearchProgressMessage",
          ),
        );
        break;
      case "table":
        handlers.onTable?.(
          parseChannelMessage<{ entry: DataSearchEntry }>(
            schemas.dataSearchTableMessage,
            msg,
            "dataSearchTableMessage",
          ),
        );
        break;
      case "done":
        handlers.onDone?.();
        break;
      case "error":
        handlers.onError?.(
          parseChannelMessage<{ error: string; connectionLost: boolean }>(
            schemas.dataSearchErrorMessage,
            msg,
            "dataSearchErrorMessage",
          ),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<ChannelCancelledMessage>(
            schemas.channelCancelledMessage,
            msg,
            "channelCancelledMessage",
          ),
        );
        break;
      default:
        break;
    }
  };
  dataSearchChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    if (dataSearchChannels.get(streamId) === channel) {
      dataSearchChannels.delete(streamId);
    }
  };
}

/** `listenQueryStream` の preview 版。プレビューは `onDone` が引数を運ばない。 */
export async function listenPreviewStream(
  streamId: string,
  handlers: PreviewStreamHandlers,
): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "meta":
        handlers.onMeta?.(
          parseChannelMessage<PreviewStreamMetaMessage>(
            schemas.previewStreamMetaMessage,
            msg,
            "previewStreamMetaMessage",
          ),
        );
        break;
      case "beforeRows":
        handlers.onBeforeRows?.(
          parseChannelMessage<PreviewStreamRowsMessage>(
            schemas.previewStreamRowsMessageLite,
            msg,
            "previewStreamRowsMessageLite",
          ),
        );
        break;
      case "afterRows":
        handlers.onAfterRows?.(
          parseChannelMessage<PreviewStreamRowsMessage>(
            schemas.previewStreamRowsMessageLite,
            msg,
            "previewStreamRowsMessageLite",
          ),
        );
        break;
      case "done":
        handlers.onDone?.();
        break;
      case "error":
        handlers.onError?.(
          parseChannelMessage<PreviewStreamErrorMessage>(
            schemas.previewStreamErrorMessage,
            msg,
            "previewStreamErrorMessage",
          ),
        );
        break;
      case "cancelled":
        handlers.onCancelled?.(
          parseChannelMessage<ChannelCancelledMessage>(
            schemas.channelCancelledMessage,
            msg,
            "channelCancelledMessage",
          ),
        );
        break;
      default:
        break;
    }
  };
  previewStreamChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    if (previewStreamChannels.get(streamId) === channel) {
      previewStreamChannels.delete(streamId);
    }
  };
}

/**
 * グローバル `listen` で受けるストリームイベント (`csv-import:*` など) を `streamId` で
 * 絞り、スキーマ検証してからハンドラへ渡す共通フィルタ。`listen*Stream` 系が共有する。
 */
function streamEventFilter(streamId: string) {
  return <T extends { streamId: string }>(
    schema: Parameters<typeof parseResponse>[0],
    event: string,
    cb?: (e: T) => void,
  ) =>
    (e: { payload: T }) => {
      if (cb && e.payload.streamId === streamId) {
        cb(parseResponse(schema, e.payload, event));
      }
    };
}

/**
 * Subscribes to all csv-import events for `streamId`. Returns a function that
 * detaches every listener.
 */
export async function listenImportStream(
  streamId: string,
  handlers: ImportStreamHandlers,
): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
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

/**
 * `.sql` スクリプト実行 (#973) の `sql-script:*` イベントを `streamId` で絞って
 * 購読する。戻り値の関数ですべてのリスナーを外す。
 */
export async function listenScriptStream(
  streamId: string,
  handlers: ScriptStreamHandlers,
): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
  return registerListeners([
    listen<ScriptProgressEvent>(
      "sql-script:progress",
      filter(schemas.scriptProgressEvent, "sql-script:progress", handlers.onProgress),
    ),
    listen<ScriptDoneEvent>(
      "sql-script:done",
      filter(schemas.scriptDoneEvent, "sql-script:done", handlers.onDone),
    ),
    listen<ScriptAnalyzedEvent>(
      "sql-script:analyzed",
      filter(schemas.scriptAnalyzedEvent, "sql-script:analyzed", handlers.onAnalyzed),
    ),
    listen<ScriptErrorEvent>(
      "sql-script:error",
      filter(schemas.scriptErrorEvent, "sql-script:error", handlers.onError),
    ),
    listen<StreamCancelledEvent>(
      "sql-script:cancelled",
      filter(schemas.streamCancelledEvent, "sql-script:cancelled", handlers.onCancelled),
    ),
  ]);
}

/** 全件ストリーミングエクスポートの進捗/完了/エラーイベントを購読する。 */
export async function listenExportStream(
  streamId: string,
  handlers: ExportStreamHandlers,
): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
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

/** 全行データ比較 (#1612) の進捗 (これまでに読んだ source の行数) を購読する。 */
export async function listenDataDiffProgress(
  streamId: string,
  onProgress: (event: { streamId: string; rows: number }) => void,
): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
  return registerListeners([
    listen<{ streamId: string; rows: number }>(
      "data-diff:progress",
      filter(schemas.dataDiffProgressEvent, "data-diff:progress", onProgress),
    ),
  ]);
}

/** 接続間データ転送 (#986) の進捗/完了/エラー/キャンセルイベントを購読する。 */
export async function listenTransferStream(
  streamId: string,
  handlers: TransferStreamHandlers,
): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
  return registerListeners([
    listen<TransferProgressEvent>(
      "transfer-stream:progress",
      filter(schemas.transferProgressEvent, "transfer-stream:progress", handlers.onProgress),
    ),
    listen<TransferDoneEvent>(
      "transfer-stream:done",
      filter(schemas.transferDoneEvent, "transfer-stream:done", handlers.onDone),
    ),
    listen<TransferErrorEvent>(
      "transfer-stream:error",
      filter(schemas.transferErrorEvent, "transfer-stream:error", handlers.onError),
    ),
    listen<StreamCancelledEvent>(
      "transfer-stream:cancelled",
      filter(schemas.streamCancelledEvent, "transfer-stream:cancelled", handlers.onCancelled),
    ),
  ]);
}

/** ストリーミングダンプの進捗/完了/エラー/キャンセルイベントを購読する (#686)。 */
export async function listenDumpStream(streamId: string, handlers: DumpStreamHandlers): Promise<UnlistenFn> {
  const filter = streamEventFilter(streamId);
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
    const payload = parseResponse(schemas.connectPhaseEvent, e.payload, "connect-progress:phase");
    if (payload.attemptId === attemptId) onPhase(payload.phase);
  });
}

/** タスクスケジューラの実行完了 (#730)。`task-run:done` / `task-run:error` の
 *  どちらでも同じ形。`status` で成否を判別する。 */
export interface TaskRunEvent {
  taskId: string;
  taskName: string;
  status: string;
  message: string | null;
  outputPath: string | null;
  catchUp: boolean;
  /** この失敗で連続失敗の上限に達し、タスクが自動で一時停止した (#1621)。 */
  autoPaused: boolean;
}

/** 「今すぐ実行」(`runTaskNow`) の進捗 (#1534)。`count` の単位は `unit`
 *  (エクスポート = 行数、ダンプ = 書き込みバイト数、アサーション = 実行済みの件数)。 */
export interface TaskRunProgressEvent {
  streamId: string;
  taskId: string;
  count: number;
  unit: "rows" | "bytes" | "items";
}

/** `runTaskNow` に渡した `streamId` の `task-run:progress` を購読する (#1534)。 */
export async function listenTaskRunProgress(
  streamId: string,
  onProgress: (e: TaskRunProgressEvent) => void,
): Promise<UnlistenFn> {
  return listen<TaskRunProgressEvent>("task-run:progress", (e) => {
    const payload = parseResponse<TaskRunProgressEvent>(
      schemas.taskRunProgressEvent,
      e.payload,
      "task-run:progress",
    );
    if (payload.streamId === streamId) onProgress(payload);
  });
}

/**
 * バックグラウンドスケジューラが発火させた `task-run:*` イベントをグローバルに
 * 購読する (特定の `streamId` を持たない — アプリ起動中いつでも、どのタブからでも
 * 発火しうるため)。App のマウント時に一度だけ購読して、失敗トースト/OS 通知と、
 * タスク管理画面が開いていれば一覧の再読み込みに使う想定。
 */
export async function listenTaskRunEvents(handlers: {
  onDone?: (e: TaskRunEvent) => void;
  onError?: (e: TaskRunEvent) => void;
}): Promise<UnlistenFn> {
  const parse = (event: string, payload: unknown) =>
    parseResponse<TaskRunEvent>(schemas.taskRunEvent, payload as TaskRunEvent, event);
  return registerListeners([
    listen<TaskRunEvent>("task-run:done", (e) => {
      handlers.onDone?.(parse("task-run:done", e.payload));
    }),
    listen<TaskRunEvent>("task-run:error", (e) => {
      handlers.onError?.(parse("task-run:error", e.payload));
    }),
  ]);
}

// --- AI 基盤 (#690) ---------------------------------------------------------

export type AiConnectionStatus =
  | "success"
  | "authError"
  | "networkError"
  | "apiError"
  | "overloaded"
  | "refused";

export interface AiConnectionTestResult {
  status: AiConnectionStatus;
  /** 成功時は応答本文 (短縮)、失敗時はエラーメッセージ。API キーは含まれない。 */
  message: string;
  model: string | null;
  elapsedMs: number;
}

/** 使用量台帳の 1 行 (日 JST × タスク種別 × モデル、#1540)。 */
export interface AiUsageRecord {
  day: string;
  task: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AiDeltaEvent {
  streamId: string;
  text: string;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface AiDoneEvent {
  streamId: string;
  /** 実際に応答したモデル。フォールバックが働くと `requestedModel` と異なる。 */
  model: string;
  requestedModel: string;
  fallbackUsed: boolean;
  stopReason: string;
  usage: AiUsage;
}

export interface AiErrorEvent {
  streamId: string;
  error: string;
  /** `AppError.kind` (`aiRefused` / `aiAuth` / `aiNetwork` / `aiApi` / `aiOverloaded`)。 */
  kind: string;
}

export interface AiRetryingEvent {
  streamId: string;
  /** 何回目の再試行か (1 始まり)。 */
  attempt: number;
  maxAttempts: number;
  /** 再試行までの待ち時間 (ms)。 */
  delayMs: number;
}

export interface AiStreamHandlers {
  onDelta?: (event: AiDeltaEvent) => void;
  /** 429 / 529 (混雑) を受けて、待ってから自動で再試行する (#1534)。 */
  onRetrying?: (event: AiRetryingEvent) => void;
  onDone?: (event: AiDoneEvent) => void;
  onError?: (event: AiErrorEvent) => void;
  /** `deliveredRows` は送信済みの本文差分 (delta) の件数。 */
  onCancelled?: (event: StreamCancelledEvent) => void;
}

/**
 * AI リクエスト (#690) の Tauri Channel を `streamId` 向けに作って購読する (#1534。以前は
 * `ai-stream:*` のグローバルイベントで、webview 内の全リスナーに配られていた)。`runAiRequest`
 * の前に await すること。戻り値の関数でハンドラを外す。ハンドラへは従来どおり `streamId`
 * 付きのイベントを渡す。
 */
export async function listenAiStream(streamId: string, handlers: AiStreamHandlers): Promise<UnlistenFn> {
  const channel = new Channel<unknown>();
  channel.onmessage = (raw) => {
    const msg = raw as RawStreamMessage;
    switch (msg.kind) {
      case "delta": {
        const m = parseChannelMessage<{ text: string }>(
          schemas.aiStreamDeltaMessage,
          msg,
          "aiStreamDeltaMessage",
        );
        handlers.onDelta?.({ streamId, text: m.text });
        break;
      }
      case "retrying": {
        const m = parseChannelMessage<Omit<AiRetryingEvent, "streamId">>(
          schemas.aiStreamRetryingMessage,
          msg,
          "aiStreamRetryingMessage",
        );
        handlers.onRetrying?.({
          streamId,
          attempt: m.attempt,
          maxAttempts: m.maxAttempts,
          delayMs: m.delayMs,
        });
        break;
      }
      case "done": {
        const m = parseChannelMessage<Omit<AiDoneEvent, "streamId">>(
          schemas.aiStreamDoneMessage,
          msg,
          "aiStreamDoneMessage",
        );
        handlers.onDone?.({
          streamId,
          model: m.model,
          requestedModel: m.requestedModel,
          fallbackUsed: m.fallbackUsed,
          stopReason: m.stopReason,
          usage: m.usage,
        });
        break;
      }
      case "error": {
        const m = parseChannelMessage<{ error: string; errorKind: string }>(
          schemas.aiStreamErrorMessage,
          msg,
          "aiStreamErrorMessage",
        );
        handlers.onError?.({ streamId, error: m.error, kind: m.errorKind });
        break;
      }
      case "cancelled": {
        const m = parseChannelMessage<ChannelCancelledMessage>(
          schemas.channelCancelledMessage,
          msg,
          "channelCancelledMessage",
        );
        handlers.onCancelled?.({ streamId, deliveredRows: m.deliveredRows });
        break;
      }
      default:
        break;
    }
  };
  aiStreamChannels.set(streamId, channel);
  return () => {
    channel.onmessage = () => {};
    if (aiStreamChannels.get(streamId) === channel) {
      aiStreamChannels.delete(streamId);
    }
  };
}
