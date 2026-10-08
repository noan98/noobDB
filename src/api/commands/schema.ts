// `src-tauri/src/commands/schema.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { IncomingFk } from "../../fkNavigation";
import type {
  TableColumnInfo,
  TableSchema,
  IndexInfo,
  SchemaObject,
  RoutineSignature,
  ForeignKey,
  TableRowEstimate,
  TableComment,
  TableStatistic,
  AlterTableContext,
  SchemaSnapshotTable,
} from "../tauri";

export const schemaCommands = {

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
  /**
   * 1 テーブル分の行数推定 (#1263)。`tableRowEstimates` の 1 件版で、テーブルが無い・
   * ビュー・統計なし・SQLite は null。
   */
  tableRowEstimate: (sessionId: string, database: string, table: string) =>
    invoke<number | null>("table_row_estimate", { sessionId, database, table }).then(
      (r) => parseResponse(schemas.nullableNumber, r, "table_row_estimate"),
    ),
  /** DB 内のテーブルコメント一覧 (#1002)。コメントを持つテーブルだけ。SQLite は常に空。 */
  listTableComments: (sessionId: string, database: string) =>
    invoke<TableComment[]>("list_table_comments", { sessionId, database }).then((r) =>
      parseResponse(schemas.tableCommentArray, r, "list_table_comments"),
    ),
  /**
   * テーブルごとのサイズ・統計に、列数・インデックス数・PK 有無・FK 数を合成して
   * 取得する (テーブル統計ダッシュボード #562 / #660 / #1255)。結合はバックエンドが
   * 行い、テーブル数ぶんの `listIndexes` は不要。
   */
  tableStatistics: (sessionId: string, database: string) =>
    invoke<TableStatistic[]>("table_statistics", { sessionId, database }).then((r) =>
      parseResponse(schemas.tableStatisticArray, r, "table_statistics"),
    ),
  /**
   * DB 内の全テーブル (とビュー) の列メタデータを 1 回で取得する (#1255)。各テーブルの
   * 内容は `describeTable` と同一。スキーマエクスポートと ER 図が使う。
   */
  describeDatabase: (sessionId: string, database: string) =>
    invoke<SchemaSnapshotTable[]>("describe_database", { sessionId, database }).then((r) =>
      parseResponse(schemas.schemaSnapshotTableArray, r, "describe_database"),
    ),
  /**
   * 列編集ダイアログの初期ロード一式 (現在の列・テーブルコメント・このテーブルの FK・
   * テーブル名一覧) を 1 回で取得する (#1255)。
   */
  alterTableContext: (sessionId: string, database: string, table: string) =>
    invoke<AlterTableContext>("alter_table_context", { sessionId, database, table }).then(
      (r) => parseResponse(schemas.alterTableContext, r, "alter_table_context"),
    ),
  /**
   * `table` を参照している外部キー (逆参照) を取得する (#621 / #1255)。結果グリッドの
   * 「参照している行へジャンプ」用。
   */
  incomingForeignKeys: (sessionId: string, database: string, table: string) =>
    invoke<IncomingFk[]>("incoming_foreign_keys", { sessionId, database, table }).then(
      (r) => parseResponse(schemas.incomingForeignKeyArray, r, "incoming_foreign_keys"),
    ),
  /** テーブルのインデックス一覧を取得する。 */
  listIndexes: (sessionId: string, database: string, table: string) =>
    invoke<IndexInfo[]>("list_indexes", { sessionId, database, table }).then((r) =>
      parseResponse(schemas.indexInfoArray, r, "list_indexes"),
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
  /**
   * ストアドプロシージャ / 関数のシグネチャ (パラメータ・戻り値) を取得する (#1003)。
   * 読み取り専用の introspection。SQLite は未対応エラーを返す。
   * `id` は PostgreSQL の oid (オーバーロード解決用)。
   */
  getRoutineSignature: (
    sessionId: string,
    database: string,
    kind: string,
    name: string,
    id?: string | null,
  ) =>
    invoke<RoutineSignature>("get_routine_signature", {
      sessionId,
      database,
      kind,
      name,
      id: id ?? null,
    }).then((r) => parseResponse(schemas.routineSignature, r, "get_routine_signature")),
  /**
   * このセッションの Schema Cache (#1097) を明示的に無効化する。Schema Browser
   * の更新ボタンなど、ユーザが最新のスキーマを見たいときに呼ぶ — DDL 実行後の
   * 自動 invalidate はバックエンドが担うため、通常のフローでは不要。呼び出し後
   * に `listDatabases` / `listTables` / `describeTable` 等を呼び直すと、必ず
   * キャッシュを経由せず再取得される。
   */
  refreshSchemaCache: (sessionId: string) =>
    invoke<void>("refresh_schema_cache", { sessionId }),
};
