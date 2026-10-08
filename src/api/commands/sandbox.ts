// `src-tauri/src/commands/sandbox.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  CellValue,
  SandboxRecord,
  SandboxCreateResponse,
  SandboxTableDiffResult,
  SandboxSchemaDiffResult,
} from "../tauri";

export const sandboxCommands = {
  /**
   * サンドボックス (壊せる砂場、#747) を作成する。`sourceSessionId` の接続から
   * `tables` (+ `includeRelated` なら FK の推移的閉包) をローカル SQLite へ
   * コピーし、通常のセッションとして開いて返す。
   */
  createSandbox: (params: {
    sourceSessionId: string;
    sourceDatabase?: string | null;
    name: string;
    tables: string[];
    includeRelated: boolean;
    rowLimit?: number | null;
  }) =>
    invoke<SandboxCreateResponse>("create_sandbox", {
      sourceSessionId: params.sourceSessionId,
      sourceDatabase: params.sourceDatabase ?? null,
      name: params.name,
      tables: params.tables,
      includeRelated: params.includeRelated,
      rowLimit: params.rowLimit ?? null,
    }).then((r) => parseResponse(schemas.sandboxCreateResponse, r, "create_sandbox")),
  listSandboxes: () =>
    invoke<SandboxRecord[]>("list_sandboxes").then((r) =>
      parseResponse(schemas.sandboxRecordArray, r, "list_sandboxes"),
    ),
  /** サンドボックスを破棄する。開いていれば `sessionId` のセッションも閉じ、
   *  ローカル SQLite ファイルを削除する。 */
  discardSandbox: (sandboxId: string, sessionId?: string | null) =>
    invoke<void>("discard_sandbox", { sandboxId, sessionId: sessionId ?? null }),
  /** サンドボックスの 1 テーブル分のデータ差分 (書き戻し案 + 競合) を計算する。
   *  `sourceSessionId` を渡すと元 DB の現在値と突き合わせて競合を検出する。 */
  sandboxTableDiff: (params: {
    sandboxId: string;
    sandboxSessionId: string;
    table: string;
    sourceSessionId?: string | null;
    limit?: number | null;
  }) =>
    invoke<SandboxTableDiffResult>("sandbox_table_diff", {
      sandboxId: params.sandboxId,
      sandboxSessionId: params.sandboxSessionId,
      table: params.table,
      sourceSessionId: params.sourceSessionId ?? null,
      limit: params.limit ?? null,
    }).then((r) => parseResponse(schemas.sandboxTableDiffResult, r, "sandbox_table_diff")),
  /** サンドボックス全体のスキーマ差分 (書き戻し案 + 外部競合テーブル一覧) を計算する。 */
  sandboxSchemaDiff: (params: {
    sandboxId: string;
    sandboxSessionId: string;
    sourceSessionId?: string | null;
  }) =>
    invoke<SandboxSchemaDiffResult>("sandbox_schema_diff", {
      sandboxId: params.sandboxId,
      sandboxSessionId: params.sandboxSessionId,
      sourceSessionId: params.sourceSessionId ?? null,
    }).then((r) => parseResponse(schemas.sandboxSchemaDiffResult, r, "sandbox_schema_diff")),
  /**
   * 書き戻しに成功した直後に呼び、サンドボックスの base スナップショットを
   * 適用済みの行へ進める。呼ばないと、次回の差分計算で「サンドボックス側も
   * 元 DB 側も変化した」という偽の競合が (実際にはもう一致している行に対して)
   * 出続けてしまう。`diffId` / `skipKeys` には実際に適用した SQL の生成元
   * (`generateDataSyncSql` に渡したのと同じもの) を渡す。
   */
  sandboxAdvanceBase: (params: {
    sandboxId: string;
    sandboxSessionId: string;
    table: string;
    diffId: string;
    skipKeys?: CellValue[][] | null;
    allowDelete: boolean;
  }) =>
    invoke<void>("sandbox_advance_base", {
      sandboxId: params.sandboxId,
      sandboxSessionId: params.sandboxSessionId,
      table: params.table,
      diffId: params.diffId,
      skipKeys: params.skipKeys && params.skipKeys.length > 0 ? params.skipKeys : null,
      allowDelete: params.allowDelete,
    }),
};
