// `src-tauri/src/commands/schema_tree.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { DatabaseTables, SchemaTree } from "../tauri";

export const schemaTreeCommands = {
  /**
   * スキーマツリーの復元 / 更新に必要な情報を 1 回で取得する (#1263)。開いている
   * DB のテーブル一覧・行数推定・非テーブルオブジェクト・コメントと、開いている
   * テーブル (`db::table`) の列・インデックス。
   */
  loadSchemaTree: (sessionId: string, openDbs: string[], openTableKeys: string[]) =>
    invoke<SchemaTree>("load_schema_tree", { sessionId, openDbs, openTableKeys }).then(
      (r) => parseResponse(schemas.schemaTree, r, "load_schema_tree"),
    ),
  /**
   * 全 DB のテーブル一覧を 1 回で取得する (#1263)。各 DB の内容は `listTables` と
   * 同一で、`listDatabases` の順。スキーマ検索が使う。
   */
  listTablesAll: (sessionId: string) =>
    invoke<DatabaseTables[]>("list_tables_all", { sessionId }).then((r) =>
      parseResponse(schemas.databaseTablesArray, r, "list_tables_all"),
    ),
};
