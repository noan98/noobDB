// `src-tauri/src/commands/bulk_write.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { UpdateGroup } from "../../components/cellEdit";
import type { CellValue, QueryResult, InsertRowsResult } from "../tauri";

export const bulkWriteCommands = {
  /**
   * 結果グリッドのセル編集 Apply (#1259)。同じ (列, 値) ごとにまとめた `groups` から
   * Rust が `UPDATE t SET c = v WHERE pk IN (…)` をチャンク化して組み立て、
   * `extraStatements` (削除予定行 / 新規行の DELETE / INSERT) と合わせて 1 トランザクション
   * (all-or-nothing) で実行する。read_only ガード・履歴・キャッシュは `runQueryTransaction`
   * と同じ経路。
   */
  bulkUpdateCells: (params: {
    sessionId: string;
    database?: string | null;
    table: string;
    pkColumns: string[];
    groups: UpdateGroup[];
    extraStatements?: string[];
  }) =>
    invoke<QueryResult>("bulk_update_cells", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      table: params.table,
      pkColumns: params.pkColumns,
      groups: params.groups,
      extraStatements: params.extraStatements ?? [],
    }).then((r) => parseResponse(schemas.queryResultLite, r, "bulk_update_cells")),
  /**
   * テストデータ生成 (#602) の生成行を 1 トランザクションで投入する (#1259)。セルは
   * null / 真偽 / 数値 / 文字列で、ドライバが列型へ強制変換する。
   */
  insertGeneratedRows: (params: {
    sessionId: string;
    database?: string | null;
    table: string;
    columns: string[];
    rows: CellValue[][];
  }) =>
    invoke<InsertRowsResult>("insert_generated_rows", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      table: params.table,
      columns: params.columns,
      rows: params.rows,
    }).then((r) => parseResponse(schemas.insertRowsResult, r, "insert_generated_rows")),
};
