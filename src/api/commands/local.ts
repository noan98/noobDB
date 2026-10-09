// `src-tauri/src/commands/local.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { LocalTableMeta, RegisterLocalTableRequest } from "../tauri";

export const localCommands = {
  /**
   * ローカル横断クエリ (#740): 駆動元セッションを持たない「ローカル」接続を新規に
   * 開く。実体は一時ファイルバックドの SQLite セッションで、以降は他の接続と同じ
   * `runQuery` / `runQueryStream` 等で扱える。既定で揮発 — `disconnect` すると
   * バッキングファイルごと削除される。
   */
  createLocalSession: () =>
    invoke<string>("create_local_session").then((r) =>
      parseResponse(schemas.stringResponse, r, "create_local_session"),
    ),
  /**
   * 結果セットを 1 つのローカルテーブルとして登録する (#740)。`sessionId` は
   * `createLocalSession` で開いたローカルセッション。取り込みは在メモリの行を
   * そのまま渡すだけの 1 本の経路で、上限行数はバックエンド側で強制される。
   */
  registerLocalTable: (req: RegisterLocalTableRequest) =>
    invoke<LocalTableMeta>("register_local_table", {
      req: {
        session_id: req.sessionId,
        table_name: req.tableName,
        columns: req.columns,
        rows: req.rows,
        result_id: req.resultId ?? null,
        source_profile: req.sourceProfile ?? null,
        source_sql: req.sourceSql,
        source_driver: req.sourceDriver ?? null,
      },
    }).then((r) => parseResponse(schemas.localTableMeta, r, "register_local_table")),
  /** ローカルセッションに登録済みの全テーブルを、登録が新しい順で返す。 */
  listLocalTables: (sessionId: string) =>
    invoke<LocalTableMeta[]>("list_local_tables", { sessionId }).then((r) =>
      parseResponse(schemas.localTableMetaArray, r, "list_local_tables"),
    ),
  /** 登録済みローカルテーブルを 1 つ削除する。 */
  dropLocalTable: (sessionId: string, tableName: string) =>
    invoke<void>("drop_local_table", { sessionId, tableName }),
  /**
   * ローカル DB を丸ごと 1 ファイルへ永続化する ("ファイルに保存")。セッション自体は
   * 引き続き揮発のまま — これは独立したスナップショットを作るだけ。
   */
  saveLocalDatabase: (sessionId: string, path: string) =>
    invoke<void>("save_local_database", { sessionId, path }),
};
