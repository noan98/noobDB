// `src-tauri/src/commands/bulk_write.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { UpdateGroup } from "../../components/cellEdit";
import type { BulkWriteOptions, BulkWriteOutcome, CellValue, InsertRowsResult } from "../tauri";

export const bulkWriteCommands = {
  /**
   * 結果グリッドのセル編集 Apply (#1259)。同じ (列, 値) ごとにまとめた `groups` から
   * Rust が `UPDATE t SET c = v WHERE pk IN (…)` をチャンク化して組み立て、
   * `extraStatements` (削除予定行 / 新規行の DELETE / INSERT) と合わせて 1 トランザクション
   * (all-or-nothing) で実行する。read_only ガード・履歴・キャッシュは `runQueryTransaction`
   * と同じ経路。
   *
   * 合計の実影響行数が想定 (`groups` の行数 + `extraStatements` の数) を超えたらバックエンドが
   * ロールバックして `status: "row_count_exceeded"` を返す (#1777)。承認後の再実行は
   * `options.approvedCounts` (= `statement_counts`) を付ける。`groups[].olds` を付けると編集した列の
   * 読込時点の旧値も WHERE に足し、他者が変えた行があれば全体をロールバックして
   * `status: "optimistic_conflict"` を返す (楽観ロック、#1766)。
   */
  bulkUpdateCells: (params: {
    sessionId: string;
    database?: string | null;
    table: string;
    pkColumns: string[];
    groups: UpdateGroup[];
    extraStatements?: string[];
    /**
     * `pkColumns` と同順で、BLOB/BINARY/BYTEA の主キー列なら true。16 進文字列で届く
     * 値を Rust がバイナリリテラルにする (all_columns 同定で BLOB 列を含むとき)。
     */
    pkBinary?: boolean[];
    options?: BulkWriteOptions;
  }) =>
    invoke<BulkWriteOutcome>("bulk_update_cells", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      table: params.table,
      pkColumns: params.pkColumns,
      groups: params.groups,
      extraStatements: params.extraStatements ?? [],
      pkBinary: params.pkBinary ?? null,
      options: params.options ? { approved_counts: params.options.approvedCounts ?? null } : undefined,
    }).then((r) => parseResponse(schemas.bulkWriteOutcome, r, "bulk_update_cells")),
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
