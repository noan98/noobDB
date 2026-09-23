// 既存テーブルの DDL 表示 / コピー (#1001) の純ロジック。
//
// DDL 本体はバックエンドの `get_object_definition` (kind = "table") が返す。
// MySQL (`SHOW CREATE TABLE`)・SQLite (`sqlite_master.sql`)・DuckDB
// (`duckdb_tables().sql`) はエンジン自身の DDL、PostgreSQL / MSSQL はネイティブな
// 出力手段が無いため列・インデックス・外部キーのカタログ情報から再構成した
// ベストエフォートの DDL (`src-tauri/src/db/table_ddl.rs`)。UI は後者のとき
// メニュー項目のツールチップで「再構成であること」を明示する。

/** テーブル DDL を introspection から再構成するドライバ (ネイティブ出力なし)。 */
const SYNTHESIZED_DDL_DRIVERS: ReadonlySet<string> = new Set(["postgres", "mssql"]);

/** `driver` のテーブル DDL が再構成 (ベストエフォート) かどうか。 */
export function isSynthesizedTableDdl(driver: string | null | undefined): boolean {
  return driver != null && SYNTHESIZED_DDL_DRIVERS.has(driver);
}

/** `get_object_definition` に渡すテーブル DDL の kind。 */
export const TABLE_DDL_KIND = "table";
