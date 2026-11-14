// `src-tauri/src/commands/deadlock.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { DeadlockAnalysis } from "../tauri";

export const deadlockCommands = {
  /**
   * デッドロック / ロック待ちを事後に解析する (#2328)。MySQL は `SHOW ENGINE INNODB STATUS` の最新報告、
   * PostgreSQL は 40P01 のエラー文の DETAIL、SQLite は `SQLITE_BUSY` の切り分け材料を返す。
   * 読み取りのみで read_only セッションでも動く。
   * `errorMessage` はエラー本文、`errorAgeSecs` はエラーが返ってからの経過秒。
   */
  analyzeDeadlock: (sessionId: string, errorMessage: string | null, errorAgeSecs: number | null) =>
    invoke<DeadlockAnalysis>("analyze_deadlock", { sessionId, errorMessage, errorAgeSecs }).then((r) =>
      parseResponse(schemas.deadlockAnalysis, r, "analyze_deadlock"),
    ),
};
