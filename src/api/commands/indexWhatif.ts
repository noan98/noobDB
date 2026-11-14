// `src-tauri/src/commands/index_whatif.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { IndexWhatIfOutcome, IndexWhatIfRequest, IndexWhatIfSupport } from "../tauri";

export const indexWhatIfCommands = {
  /**
   * インデックス試算 (#2326) で、この接続が使える方法 (PostgreSQL は hypopg の有無) と、使えない
   * 理由・ロックを取るか・インデックスを構築するかを返す。読み取りだけ。
   */
  getIndexWhatIfSupport: (sessionId: string) =>
    invoke<IndexWhatIfSupport>("get_index_whatif_support", { sessionId }).then((r) =>
      parseResponse(schemas.indexWhatIfSupport, r, "get_index_whatif_support"),
    ),

  /**
   * 「このインデックスが無かったら / あったら」の計画を、今の計画と一緒に取る (どちらも ANALYZE なしの
   * EXPLAIN)。実 DB に変更は残らない (PostgreSQL / SQLite は ROLLBACK、hypopg は仮想、MySQL は
   * IGNORE INDEX の差し込みだけ)。`read_only` 接続で DDL を使う経路はバックエンドが拒否し、ロックを
   * 取る経路は `confirmLocking` が無いと実行しない。
   */
  runIndexWhatIf: (sessionId: string, request: IndexWhatIfRequest) =>
    invoke<IndexWhatIfOutcome>("run_index_whatif", {
      sessionId,
      request: {
        database: request.database,
        table: request.table,
        sql: request.sql,
        action: request.action,
        index: request.index ?? null,
        columns: request.columns ?? [],
        confirmLocking: request.confirmLocking ?? false,
        lockTimeoutSecs: request.lockTimeoutSecs ?? null,
      },
    }).then((r) => parseResponse(schemas.indexWhatIfOutcome, r, "run_index_whatif")),
};
