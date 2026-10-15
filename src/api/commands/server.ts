// `src-tauri/src/commands/server.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ServerInfo, ServerMetrics, SqliteMaintenanceAction, SqliteMaintenanceResult } from "../tauri";

export const serverCommands = {
  /** 接続中サーバの情報 (バージョン + 設定変数) を取得する (サーバ情報パネル #563)。 */
  serverInfo: (sessionId: string) =>
    invoke<ServerInfo>("server_info", { sessionId }).then((r) =>
      parseResponse(schemas.serverInfo, r, "server_info"),
    ),
  /**
   * サーバランタイムのメトリクスを 1 サンプル取得する (監視ダッシュボード #731)。
   * `SHOW GLOBAL STATUS` / `pg_stat_activity` などメモリ上のカウンタを読むだけの
   * 読み取り操作なので read_only セッションでも許可される。SQLite は非対応で
   * エラーを返す (呼び出し側で catch して導線ごと非表示にする)。
   */
  serverMetrics: (sessionId: string) =>
    invoke<ServerMetrics>("server_metrics", { sessionId }).then((r) =>
      parseResponse(schemas.serverMetrics, r, "server_metrics"),
    ),
  /**
   * SQLite のメンテナンスを実行する (#1625): `integrity_check` / `foreign_key_check` は
   * 読み取りのみ、`optimize` / `analyze` は統計を更新する (read_only セッションは拒否)。
   */
  sqliteMaintenance: (sessionId: string, action: SqliteMaintenanceAction) =>
    invoke<SqliteMaintenanceResult>("sqlite_maintenance", { sessionId, action }).then((r) =>
      parseResponse(schemas.sqliteMaintenanceResult, r, "sqlite_maintenance"),
    ),
};
