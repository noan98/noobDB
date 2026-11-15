// `src-tauri/src/commands/logical_relations.rs` の IPC ラッパー (#2356)。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { LogicalRelation, LogicalRelationInput } from "../tauri";

export const logicalRelationsCommands = {
  /**
   * この接続先 (プロファイル × データベース) の論理リレーション (仮想 FK) 一覧。DB には保存されない
   * アプリ側だけの関係で、`foreignKeys` / `incomingForeignKeys` / `describeTable` / `describeDatabase` が
   * 宣言済み FK とマージして返す。
   */
  listLogicalRelations: (sessionId: string, database: string) =>
    invoke<LogicalRelation[]>("list_logical_relations", { sessionId, database }).then((r) =>
      parseResponse(schemas.logicalRelationArray, r, "list_logical_relations"),
    ),
  /** 論理リレーションをまとめて登録する (既存と同じものは無視)。登録後の一覧を返す。DB には書かない。 */
  saveLogicalRelations: (sessionId: string, database: string, relations: LogicalRelationInput[]) =>
    invoke<LogicalRelation[]>("save_logical_relations", { sessionId, database, relations }).then((r) =>
      parseResponse(schemas.logicalRelationArray, r, "save_logical_relations"),
    ),
  /** 論理リレーションを 1 件削除する。削除後の一覧を返す。 */
  deleteLogicalRelation: (sessionId: string, database: string, relation: LogicalRelationInput) =>
    invoke<LogicalRelation[]>("delete_logical_relation", { sessionId, database, relation }).then((r) =>
      parseResponse(schemas.logicalRelationArray, r, "delete_logical_relation"),
    ),
};
