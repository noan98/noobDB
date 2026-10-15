// `src-tauri/src/commands/import_templates.rs` の IPC ラッパー (#1623)。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ImportTemplate } from "../tauri";

export const importTemplatesCommands = {
  /** 保存済みの取り込みマッピング (#1623)。`table` 省略でそのデータベースの全テーブル分。 */
  listImportTemplates: (profileId: string, database?: string | null, table?: string | null) =>
    invoke<ImportTemplate[]>("list_import_templates", {
      profileId,
      database: database ?? null,
      table: table ?? null,
    }).then((r) => parseResponse(schemas.importTemplateArray, r, "list_import_templates")),

  /** 取り込みマッピングを保存する (#1623)。同じ接続・データベース・テーブルは置き換わる。 */
  saveImportTemplate: (template: ImportTemplate) =>
    invoke<ImportTemplate>("save_import_template", { template }).then((r) =>
      parseResponse(schemas.importTemplate, r, "save_import_template"),
    ),

  deleteImportTemplate: (id: string) => invoke<void>("delete_import_template", { id }),
};
