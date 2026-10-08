// `src-tauri/src/commands/process.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { KillProcessesResult, ProcessInfo } from "../tauri";

export const processCommands = {
  /** サーバ側プロセス/接続の一覧を取得する (プロセス監視パネル)。SQLite は非対応。 */
  listProcesses: (sessionId: string) =>
    invoke<ProcessInfo[]>("list_processes", { sessionId }).then((r) =>
      parseResponse(schemas.processInfoArray, r, "list_processes"),
    ),
  /** プロセス/接続をまとめて強制終了する (#1259)。PostgreSQL は `unnest` で 1 文、MySQL は
   *  1 接続上で順に `KILL`。失敗があっても残りは続行し、件数と最初のエラーを返す。
   *  read_only セッションはバックエンドで拒否される。 */
  killProcesses: (sessionId: string, processIds: number[]) =>
    invoke<KillProcessesResult>("kill_processes", { sessionId, processIds }).then((r) =>
      parseResponse(schemas.killProcessesResult, r, "kill_processes"),
    ),
  /** 1 プロセスの実行中 (または直近) の SQL 全文を取得する (#1259)。一覧は要約しか
   *  返さないため、ツールチップ表示などで全文が要るときだけ呼ぶ。消えていれば null。 */
  getProcessQuery: (sessionId: string, processId: number) =>
    invoke<string | null>("get_process_query", { sessionId, processId }).then((r) =>
      parseResponse(schemas.nullableStringResponse, r, "get_process_query"),
    ),
};
