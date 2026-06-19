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
  primary_key: z.array(z.string()),
  rows: z.array(rowDiff),
  truncated: z.boolean(),
  source_count: z.number(),
  target_count: z.number(),
});

export const csvPreview = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  truncated: z.boolean(),
});

export const connectResult = z.object({ session_id: z.string() });

/** 単純なプリミティブ/配列レスポンス用の共有スキーマ。 */
export const stringArray = z.array(z.string());
export const numberResponse = z.number();
export const booleanResponse = z.boolean();
export const stringResponse = z.string();

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

export const importDoneEvent = z.object({
  streamId: z.string(),
  inserted: z.number(),
  elapsedMs: z.number(),
});

export const importErrorEvent = z.object({
  streamId: z.string(),
  error: z.string(),
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
