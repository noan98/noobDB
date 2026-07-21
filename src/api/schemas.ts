import { z } from "zod";

/**
 * Zod ランタイムスキーマ — IPC レスポンスの実行時型検証。
 *
 * `src/api/tauri.ts` の各 `invoke` ラッパーは Rust バックエンドの戻り値を
 * TypeScript の型に **キャスト** しているだけで、実行時の型保証がない。Rust 側の
 * `serde` 構造体のフィールド名・型が変わると、TypeScript の型宣言とサイレントに
 * ズレ、`undefined` や想定外の値が UI 深部まで流れてからようやく壊れる。ここで
 * 主要レスポンス型の Zod スキーマを定義し、`tauri.ts` 側で `safeParse` を通して
 * デシリアライズの不整合を **早期に・具体的なメッセージで** 検出する。
 *
 * 設計方針:
 * - オブジェクトは既定 (非 strict) のままにし、未知キーは **黙って捨てる**。
 *   バックエンドがフィールドを追加しただけでフロントが落ちないようにするため
 *   (前方互換性)。検証したいのは「期待するフィールドが期待する型で存在するか」。
 * - 戻り値の TypeScript 型は `tauri.ts` のインターフェースが正であり続ける。
 *   ここでは `z.infer` を公開せず、`parseResponse` は受け取った値の型をそのまま
 *   返す (実行時ガードに徹し、コンパイル時の公開 API 形状は変えない)。
 */

/** `Value` のワイヤフォーマット。`#[serde(untagged)]` なので素のプリミティブ。
 *  BLOB は 16 進文字列 (`Value::Bytes`) として string に乗る (CLAUDE.md 参照)。 */
const cellValue = z.union([z.null(), z.boolean(), z.number(), z.string()]);

const column = z.object({
  name: z.string(),
  type_name: z.string(),
});

export const queryResult = z.object({
  columns: z.array(column),
  rows: z.array(z.array(cellValue)),
  rows_affected: z.number(),
  elapsed_ms: z.number(),
});

export const tableColumnInfo = z.object({
  name: z.string(),
  data_type: z.string(),
  nullable: z.boolean(),
  key: z.string(),
  default: z.string().nullable(),
  extra: z.string(),
  referenced_table: z.string().nullable(),
  referenced_column: z.string().nullable(),
});

export const tableSchema = z.object({
  name: z.string(),
  columns: z.array(z.string()),
});

export const foreignKey = z.object({
  table: z.string(),
  column: z.string(),
  referenced_table: z.string(),
  referenced_column: z.string().nullable(),
  constraint_name: z.string().nullable(),
});

/**
 * i64 精度方針 (#625): `estimate` は Rust の `Option<i64>` を JSON 数値で受ける。
 * JS の `number` は安全整数が ±(2^53-1) までなので、それを超える巨大テーブルの推定
 * 行数では精度が静かに落ちうる。**方針: これは許容する** — この値は engine の統計に
 * 基づく **概算** (`~1.2K` 形式で表示するだけ) であり、2^53 (≈9×10^15 行) を超える
 * 現実のテーブルは事実上存在せず、超えても表示上の丸めに留まるため。文字列化には
 * 寄せない (`TableSizeInfo` のバイト数・`ProcessInfo.id`/`time_secs` も同様に、
 * 現実的なレンジが安全整数に収まるので number のまま)。厳密な i64 識別子を新設する
 * ときだけ、その場で文字列シリアライズを検討する。
 */
export const tableRowEstimate = z.object({
  name: z.string(),
  estimate: z.number().nullable(),
});

/** テーブルのサイズ・統計 (サイズダッシュボード #562)。 */
export const tableSizeInfo = z.object({
  name: z.string(),
  row_estimate: z.number().nullable(),
  data_bytes: z.number().nullable(),
  index_bytes: z.number().nullable(),
  total_bytes: z.number().nullable(),
});

/** サーバ設定/状態の 1 変数 (サーバ情報パネル #563)。 */
export const serverVariable = z.object({
  name: z.string(),
  value: z.string(),
});

/** サーバ情報 (バージョン + 設定変数一覧)。 */
export const serverInfo = z.object({
  version: z.string(),
  variables: z.array(serverVariable),
});

export const indexInfo = z.object({
  name: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
  primary: z.boolean(),
  method: z.string().nullable(),
});

/** サーバ側プロセス/接続 (プロセス監視パネル)。 */
export const processInfo = z.object({
  id: z.number(),
  user: z.string().nullable(),
  host: z.string().nullable(),
  database: z.string().nullable(),
  command: z.string().nullable(),
  state: z.string().nullable(),
  time_secs: z.number().nullable(),
  query: z.string().nullable(),
  is_self: z.boolean(),
});

/** サーバランタイムの軽量メトリクス 1 サンプル (監視ダッシュボード #731)。 */
export const serverMetrics = z.object({
  connections: z.number().nullable(),
  active: z.number().nullable(),
  idle_in_transaction: z.number().nullable(),
  lock_waiting: z.number().nullable(),
  questions: z.number().nullable(),
  slow_queries: z.number().nullable(),
  lock_waits: z.number().nullable(),
});

/** SSH known_hosts の 1 エントリ (host:port + fingerprint)。#682。 */
export const knownHost = z.object({
  host: z.string(),
  port: z.number(),
  fingerprint: z.string(),
});
export const knownHostArray = z.array(knownHost);

/** ライブクエリ・インスペクタ (#746) の前提可否 + 縮退理由コード。 */
export const queryStatsSupport = z.object({
  live_tail: z.boolean(),
  statements: z.boolean(),
  live_tail_reason: z.string().nullable(),
  statements_reason: z.string().nullable(),
});

/** ライブテールの 1 イベント (#746)。 */
export const liveQuery = z.object({
  key: z.string(),
  query: z.string(),
  user: z.string().nullable(),
  host: z.string().nullable(),
  database: z.string().nullable(),
  application: z.string().nullable(),
  duration_ms: z.number().nullable(),
  rows_examined: z.number().nullable(),
  running: z.boolean(),
  started_at_ms: z.number().nullable(),
});

/** digest 単位の累積統計 1 行 (#746)。 */
export const statementStat = z.object({
  digest: z.string(),
  fingerprint: z.string(),
  database: z.string().nullable(),
  calls: z.number(),
  total_time_ms: z.number(),
  max_time_ms: z.number(),
  rows: z.number().nullable(),
});

export const schemaObject = z.object({
  kind: z.string(),
  name: z.string(),
  id: z.string().nullish().transform((v) => v ?? null),
});

/**
 * プレビュー結果の検証スキーマ。他の IPC スキーマと対をなす公開検証表面で、
 * 現状ランタイム検証には未配線だが API 完全性のため保持する。
 * @public
 */
export const previewResult = z.object({
  target_table: z.string().nullable(),
  columns: z.array(column),
  primary_key: z.array(z.string()),
  before_rows: z.array(z.array(cellValue)),
  after_rows: z.array(z.array(cellValue)),
  rows_affected: z.number(),
  elapsed_ms: z.number(),
  truncated: z.boolean(),
});

const sshProfile = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  auth_method: z.enum(["key", "agent", "password"]),
  private_key_path: z.string(),
});

export const connectionProfile = z.object({
  id: z.string(),
  name: z.string(),
  driver: z.string(),
  host: z.string(),
  port: z.number(),
  user: z.string(),
  database: z.string().nullable(),
  ssh: sshProfile.nullable(),
  group: z.string().nullable(),
  color: z.string().nullable(),
  is_production: z.boolean(),
  confirm_writes: z.boolean(),
  read_only: z.boolean(),
  skip_history: z.boolean(),
  file_path: z.string().nullable(),
  // TLS 設定 (非秘密)。TLS 未設定で保存された旧プロファイルではフィールドごと
  // 欠落するため optional + nullable。証明書はパスのみで値は保存しない。
  ssl_mode: z
    .enum(["disable", "prefer", "require", "verify_ca", "verify_full"])
    .nullable()
    .optional(),
  ssl_root_cert: z.string().nullable().optional(),
  ssl_client_cert: z.string().nullable().optional(),
  ssl_client_key: z.string().nullable().optional(),
  // セッション初期化 SQL (非秘密)。未設定の旧プロファイルでは欠落。
  init_sql: z.string().nullable().optional(),
  // 以下は list_profiles の戻り値にのみ含まれる「秘密が設定済みか」の表示用フラグ。
  has_db_password: z.boolean().optional(),
  has_ssh_passphrase: z.boolean().optional(),
  has_ssh_password: z.boolean().optional(),
});

const snippetScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any") }),
  z.object({ kind: z.literal("profile"), profile_id: z.string() }),
  z.object({ kind: z.literal("group"), group: z.string() }),
]);

export const snippet = z.object({
  id: z.string(),
  name: z.string(),
  folder: z.string().nullable(),
  tags: z.array(z.string()),
  sql: z.string(),
  driver: z.string().nullable(),
  scope: snippetScope,
});

export const historyEntry = z.object({
  id: z.number(),
  profile_id: z.string().nullable(),
  driver: z.string(),
  database: z.string().nullable(),
  sql: z.string(),
  rows: z.number().nullable(),
  rows_affected: z.number().nullable(),
  elapsed_ms: z.number().nullable(),
  status: z.string(),
  error: z.string().nullable(),
  executed_at: z.string(),
});

export const logView = z.object({
  text: z.string(),
  path: z.string().nullable(),
});

const diffStatus = z.enum(["source_only", "target_only", "different", "same"]);

const columnDiff = z.object({
  name: z.string(),
  status: diffStatus,
  source: tableColumnInfo.nullable(),
  target: tableColumnInfo.nullable(),
  changed_fields: z.array(z.string()),
});

const tableDiff = z.object({
  name: z.string(),
  status: diffStatus,
  columns: z.array(columnDiff),
});

const driverKind = z.enum(["mysql", "postgres", "sqlite"]);

export const schemaDiff = z.object({
  source_driver: driverKind,
  target_driver: driverKind,
  tables: z.array(tableDiff),
});

const syncStatement = z.object({
  sql: z.string(),
  table: z.string(),
  kind: z.enum([
    "create_table",
    "add_column",
    "alter_column",
    "drop_column",
    "drop_table",
    "insert_row",
    "update_row",
    "delete_row",
  ]),
  destructive: z.boolean(),
});

export const syncPlan = z.object({
  statements: z.array(syncStatement),
  warnings: z.array(z.string()),
});

const rowDiff = z.object({
  status: z.enum(["source_only", "target_only", "different"]),
  key: z.array(cellValue),
  source: z.array(cellValue).nullable(),
  target: z.array(cellValue).nullable(),
  changed_columns: z.array(z.string()),
});

export const dataDiff = z.object({
  target_driver: driverKind,
  table: z.string(),
  columns: z.array(z.string()),
  /** `columns` と同じ並びの型名。BLOB 列を復元して sql_literal の補正に使う (修正3)。 */
  column_types: z.array(z.string()),
  primary_key: z.array(z.string()),
  rows: z.array(rowDiff),
  truncated: z.boolean(),
  source_count: z.number(),
  target_count: z.number(),
});

// スキーマ健全性アドバイザ (#741)。RuleId / Severity はバックの serde 表現
// (snake_case / lowercase) に一致させる。
const advisorSeverity = z.enum(["high", "medium", "low"]);
const advisorRuleId = z.enum([
  "fk_missing_index",
  "duplicate_index",
  "redundant_index",
  "missing_primary_key",
  "unused_index",
  "fk_type_mismatch",
  "sqlite_integer_pk_hint",
]);

export const healthFinding = z.object({
  rule: advisorRuleId,
  severity: advisorSeverity,
  table: z.string(),
  columns: z.array(z.string()),
  context: z.array(z.string()),
  fix_ddl: z.string().nullable(),
  statistical: z.boolean(),
});

export const skippedRule = z.object({
  rule: advisorRuleId,
  reason: z.string(),
});

export const schemaHealthReport = z.object({
  driver: driverKind,
  tables_analyzed: z.number(),
  findings: z.array(healthFinding),
  skipped: z.array(skippedRule),
});

export const csvPreview = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  truncated: z.boolean(),
});

export const connectResult = z.object({ session_id: z.string() });

/** `connect-progress:phase` イベント: 接続確立のフェーズ進捗 (#684)。
 *  phase は "preparing" / "tunnel_connecting" / "tunnel_authenticating" /
 *  "db_connecting" のいずれか (バック ConnectPhase::label と一致)。 */
export const connectPhaseEvent = z.object({
  attemptId: z.string(),
  phase: z.string(),
});

/** 単純なプリミティブ/配列レスポンス用の共有スキーマ。 */
export const stringArray = z.array(z.string());
export const numberResponse = z.number();
export const stringResponse = z.string();

/** `cancel_stream` の戻り値。中断できた行数 (#685) を運ぶため単純な bool から
 *  拡張されている。 */
export const cancelStreamResponse = z.object({
  cancelled: z.boolean(),
  deliveredRows: z.number(),
});

/** プロファイルインポート結果。 */
export const profileImportResult = z.object({
  imported: z.number(),
  skipped: z.number(),
  overwritten: z.number(),
  invalid: z.number(),
});

/** 配列を返すコマンド用のラッパースキーマ。 */
export const tableColumnInfoArray = z.array(tableColumnInfo);
export const tableSchemaArray = z.array(tableSchema);
export const foreignKeyArray = z.array(foreignKey);
export const tableRowEstimateArray = z.array(tableRowEstimate);
export const tableSizeInfoArray = z.array(tableSizeInfo);
export const indexInfoArray = z.array(indexInfo);
export const processInfoArray = z.array(processInfo);
export const liveQueryArray = z.array(liveQuery);
export const statementStatArray = z.array(statementStat);
export const schemaObjectArray = z.array(schemaObject);
export const connectionProfileArray = z.array(connectionProfile);
export const snippetArray = z.array(snippet);
export const historyEntryArray = z.array(historyEntry);

// --- ストリーミングイベント (StreamBatch) ---------------------------------
//
// クエリ/プレビュー/CSV インポートの結果は `invoke` の戻り値ではなくイベント
// (`listen`) で届く。制御系イベント (columns / meta / done / error / インポートの
// ライフサイクル) は低頻度なので完全に検証する。一方 `*:rows` 系イベントは 1 バッチ
// あたり最大 chunkSize 行を運び高頻度で飛ぶため、**セル単位の検証は行わず構造のみ**
// を軽量に検証する (大きな結果セットでの検証コスト増を避けるトレードオフ)。

export const queryStreamColumnsEvent = z.object({
  streamId: z.string(),
  columns: z.array(column),
});

/** `*:rows` 系の軽量スキーマ: `rows` が配列であることだけを確認する。各行・各セルの
 *  中身は検証しない (大きなバッチでの深いコピー/反復コストを避けるため、外側 1 次元の
 *  存在チェックに留める)。 */
export const streamRowsEventLite = z.object({
  streamId: z.string(),
  rows: z.array(z.unknown()),
});

export const queryStreamDoneEvent = z.object({
  streamId: z.string(),
  totalRows: z.number(),
  rowsAffected: z.number(),
  elapsedMs: z.number(),
  hasColumns: z.boolean(),
  appliedAutoLimit: z.number().nullable(),
});

export const queryStreamErrorEvent = z.object({
  streamId: z.string(),
  error: z.string(),
  timedOut: z.boolean(),
  connectionLost: z.boolean(),
  /** Rows already delivered to the frontend before the run failed (#685). */
  deliveredRows: z.number(),
});

/** キャンセル成立時に `query-stream:cancelled` / `preview-stream:cancelled` /
 *  `export-stream:cancelled` として届く共通ペイロード (#685)。 */
export const streamCancelledEvent = z.object({
  streamId: z.string(),
  deliveredRows: z.number(),
});

export const previewStreamMetaEvent = z.object({
  streamId: z.string(),
  targetTable: z.string().nullable(),
  columns: z.array(column),
  primaryKey: z.array(z.string()),
  rowsAffected: z.number(),
  elapsedMs: z.number(),
  truncated: z.boolean(),
});

export const previewStreamDoneEvent = z.object({ streamId: z.string() });

export const previewStreamErrorEvent = z.object({
  streamId: z.string(),
  error: z.string(),
  connectionLost: z.boolean(),
  /** Rows already delivered to the frontend before the run failed (#685). */
  deliveredRows: z.number(),
});

export const importStartedEvent = z.object({
  streamId: z.string(),
  total: z.number(),
});

export const importProgressEvent = z.object({
  streamId: z.string(),
  inserted: z.number(),
  total: z.number(),
});

/** スキップされた行 (skip モード。#687)。 */
export const skippedRowInfo = z.object({
  record: z.number(),
  line: z.number().nullable(),
  reason: z.string(),
});

export const importDoneEvent = z.object({
  streamId: z.string(),
  inserted: z.number(),
  elapsedMs: z.number(),
  // 旧バックエンド (skipped フィールド無し) との後方互換で既定 []。
  skipped: z.array(skippedRowInfo).default([]),
});

export const importErrorEvent = z.object({
  streamId: z.string(),
  error: z.string(),
  record: z.number().nullable().default(null),
  line: z.number().nullable().default(null),
});

// ストリーミングダンプのイベント (#686)。
export const dumpProgressEvent = z.object({
  streamId: z.string(),
  bytes: z.number(),
  elapsedMs: z.number(),
  /** SQLite 経路のみ処理済み/総テーブル数。外部ツールでは null。 */
  tables: z.number().nullable(),
  tablesTotal: z.number().nullable(),
});

export const dumpDoneEvent = z.object({
  streamId: z.string(),
  bytes: z.number(),
  elapsedMs: z.number(),
});

export const dumpErrorEvent = z.object({
  streamId: z.string(),
  error: z.string(),
});

/** `dump-stream:cancelled`。cancel_stream は共有ペイロード (deliveredRows) を送るが、
 *  ダンプでは deliveredRows = 書き出し済みバイト数として解釈する (#686)。 */
export const dumpCancelledEvent = z.object({
  streamId: z.string(),
  deliveredRows: z.number(),
});

// 全件ストリーミングエクスポートのイベント。
export const exportProgressEvent = z.object({
  streamId: z.string(),
  rows: z.number(),
});

export const exportDoneEvent = z.object({
  streamId: z.string(),
  rows: z.number(),
  bytes: z.number(),
});

export const exportStreamErrorEvent = z.object({
  streamId: z.string(),
  message: z.string(),
  /** Rows already written to the output file before the run failed (#685).
   *  Informational only — a failed/cancelled export always discards its
   *  partial output file. */
  rows: z.number(),
});

/** DEV ビルドでのみ詳細なバリデーションエラーをコンソールへ出す。 */
const DEV = import.meta.env.DEV;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  • ${path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * IPC レスポンスをスキーマで検証する実行時ガード。成功すれば値をそのまま返し、
 * 失敗すれば `AppError` 相当の `Error` を投げる (`invoke` の reject と同様に
 * フロントは reject された Promise として受け取る)。
 *
 * `value` の TypeScript 型 `T` は `invoke<T>` のキャスト結果をそのまま素通しする
 * (コンパイル時の公開 API 形状は不変)。検証はあくまで実行時の安全網。DEV では
 * 詳細なフィールド単位のエラーをコンソールに出し、本番では簡潔なメッセージのみ
 * (バンドル/ログ配慮)。
 */
export function parseResponse<T>(
  schema: z.ZodType,
  value: T,
  command: string,
): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data as T;
  }
  if (DEV) {
    // eslint-disable-next-line no-console
    console.error(
      `[IPC] "${command}" のレスポンスがスキーマ検証に失敗しました:\n${formatIssues(
        result.error,
      )}`,
      value,
    );
  }
  const summary = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new Error(
    `IPC レスポンス "${command}" が期待した形式と一致しません: ${summary}`,
  );
}
