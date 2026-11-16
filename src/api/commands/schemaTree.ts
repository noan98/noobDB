// `src-tauri/src/commands/schema_tree.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import { applyLogicalToColumns } from "../../logicalRelations";
import type { DatabaseTables, SchemaTree } from "../tauri";
import { listLogicalRelationsOrEmpty } from "./logicalRelations";

export const schemaTreeCommands = {
  /**
   * スキーマツリーの復元 / 更新に必要な情報を 1 回で取得する (#1263)。開いている
   * DB のテーブル一覧・行数推定・非テーブルオブジェクト・コメントと、開いている
   * テーブル (`db::table`) の列・インデックス。
   */
  loadSchemaTree: (sessionId: string, openDbs: string[], openTableKeys: string[]) =>
    invoke<SchemaTree>("load_schema_tree", { sessionId, openDbs, openTableKeys })
      .then((r) => parseResponse(schemas.schemaTree, r, "load_schema_tree"))
      // 開いているテーブルの列に論理リレーション (仮想 FK, #2356) の参照先を重ねる。
      .then(async (tree) => {
        if (tree.tables.length === 0) return tree;
        const byDb = new Map(
          await Promise.all(
            openDbs.map(async (db) => [db, await listLogicalRelationsOrEmpty(sessionId, db)] as const),
          ),
        );
        return {
          ...tree,
          tables: tree.tables.map((tb) => {
            // キー `db::table` の DB 名は `::` を含みうるので、開いている DB のうち最長一致を採る。
            const db = openDbs
              .filter((d) => tb.key.startsWith(`${d}::`))
              .sort((a, b) => b.length - a.length)[0];
            if (db === undefined) return tb;
            return {
              ...tb,
              columns: applyLogicalToColumns(tb.key.slice(db.length + 2), tb.columns, byDb.get(db) ?? []),
            };
          }),
        };
      }),
  /**
   * 全 DB のテーブル一覧を 1 回で取得する (#1263)。各 DB の内容は `listTables` と
   * 同一で、`listDatabases` の順。スキーマ検索が使う。
   */
  listTablesAll: (sessionId: string) =>
    invoke<DatabaseTables[]>("list_tables_all", { sessionId }).then((r) =>
      parseResponse(schemas.databaseTablesArray, r, "list_tables_all"),
    ),
};
