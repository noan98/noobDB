// `src-tauri/src/commands/logical_relations.rs` の IPC ラッパー (#2356)。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { LogicalRelation, LogicalRelationInput, LogicalRelationsImportParse } from "../tauri";

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
  /**
   * この接続先の論理リレーションを書き出し用 JSON 文字列で返す (#2423)。`profile_id`・接続情報・登録時刻は
   * 含まない。保存ダイアログで選んだパスへ `writeTextFile` で書く (新しい書き込み経路を増やさない)。
   */
  exportLogicalRelations: (sessionId: string, database: string) =>
    invoke<string>("export_logical_relations", { sessionId, database }).then((r) =>
      parseResponse(schemas.stringResponse, r, "export_logical_relations"),
    ),
  /** 書き出しファイルの中身を寛容に読む (#2423)。保存はしない。壊れた JSON・サイズ/件数超過はエラー。 */
  parseLogicalRelationsImport: (json: string) =>
    invoke<LogicalRelationsImportParse>("parse_logical_relations_import", { json }).then((r) =>
      parseResponse(schemas.logicalRelationsImportParse, r, "parse_logical_relations_import"),
    ),
  /** この接続先の論理リレーションを渡した内容で置き換える (取り込みの「上書き」、#2423)。置き換え後の一覧を返す。 */
  replaceLogicalRelations: (sessionId: string, database: string, relations: LogicalRelationInput[]) =>
    invoke<LogicalRelation[]>("replace_logical_relations", { sessionId, database, relations }).then((r) =>
      parseResponse(schemas.logicalRelationArray, r, "replace_logical_relations"),
    ),
};

/**
 * 論理リレーション (仮想 FK, #2356) を読む。宣言済み FK を使う機能へ一緒に渡すためのマージ用で、
 * 読めなくても (未対応のバックエンド・ストア障害など) 宣言 FK だけで動き続けるよう空配列に倒す。
 */
export function listLogicalRelationsOrEmpty(sessionId: string, database: string): Promise<LogicalRelation[]> {
  return logicalRelationsCommands.listLogicalRelations(sessionId, database).catch(() => []);
}
