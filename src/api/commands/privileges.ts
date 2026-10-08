// `src-tauri/src/commands/privileges.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { DriverKind, DbUserInfo, UserPrivileges, PrivilegeChange } from "../tauri";

export const privilegesCommands = {

  // --- ユーザ / 権限管理 (#732) ---------------------------------------------
  //
  // Diff/Sync (`generateSyncSql` → `applySyncSql`) と同じ「生成とプレビュー →
  // 確認 → 適用」の分離パターン。SQL 生成 (create/drop/alterPassword/grant/
  // revoke) は副作用なしの純コマンドで、`applyPrivilegeSql` だけがセッションを
  // 介して実際に SQL を実行する。パスワードを含みうる SQL 文はクエリ履歴・ログの
  // どちらにも記録されない (バックエンド `apply_privilege_sql` が
  // `run_query_transaction` ではなく `execute_transaction` を直接呼ぶため)。
  /** サーバ側のユーザ (MySQL) / ロール (PostgreSQL) 一覧を取得する。読み取りの
   *  みなので read_only セッションでも可。SQLite は非対応でエラーを返す。 */
  listDbUsers: (sessionId: string) =>
    invoke<DbUserInfo[]>("list_db_users", { sessionId }).then((r) =>
      parseResponse(schemas.dbUserInfoArray, r, "list_db_users"),
    ),
  /** 指定ユーザ/ロールの CRUD+DDL 権限マトリクスを取得する。読み取りのみ。`database`
   *  (MySQL: DB 名 / PostgreSQL: スキーマ名) を渡すと、テーブル別の行をサーバ側で絞る
   *  (global 行は常に返る, #1259)。 */
  listUserPrivileges: (
    sessionId: string,
    user: string,
    host?: string | null,
    database?: string | null,
  ) =>
    invoke<UserPrivileges>("list_user_privileges", {
      sessionId,
      user,
      host: host ?? null,
      database: database ?? null,
    }).then((r) => parseResponse(schemas.userPrivileges, r, "list_user_privileges")),
  /** `CREATE USER` / `CREATE ROLE` の SQL を生成する (純粋、副作用なし)。 */
  generateCreateUserSql: (
    driver: DriverKind,
    spec: { name: string; host?: string | null; password?: string | null },
  ) =>
    invoke<string>("generate_create_user_sql", {
      driver,
      spec: { name: spec.name, host: spec.host ?? null, password: spec.password ?? null },
    }).then((r) => parseResponse(schemas.stringResponse, r, "generate_create_user_sql")),
  /** `DROP USER` / `DROP ROLE` の SQL を生成する (純粋)。 */
  generateDropUserSql: (driver: DriverKind, name: string, host?: string | null) =>
    invoke<string>("generate_drop_user_sql", { driver, name, host: host ?? null }).then((r) =>
      parseResponse(schemas.stringResponse, r, "generate_drop_user_sql"),
    ),
  /** `ALTER USER ... IDENTIFIED BY` / `ALTER ROLE ... PASSWORD` の SQL を生成する
   *  (純粋)。生成された SQL 文字列自体にパスワードが埋め込まれる点に注意 —
   *  呼び出し側はこれをログや履歴に残してはいけない。 */
  generateAlterPasswordSql: (
    driver: DriverKind,
    name: string,
    host: string | null,
    password: string,
  ) =>
    invoke<string>("generate_alter_password_sql", { driver, name, host, password }).then((r) =>
      parseResponse(schemas.stringResponse, r, "generate_alter_password_sql"),
    ),
  /** 権限差分 (テーブルごとの付与/剥奪フラグ) から `GRANT` / `REVOKE` 文をまとめて
   *  生成する (純粋, #1259)。テーブル順に GRANT → REVOKE を並べ、フラグが無い側は出力
   *  しない。 */
  generatePrivilegeDiffSql: (
    driver: DriverKind,
    user: string,
    host: string | null,
    database: string,
    changes: PrivilegeChange[],
  ) =>
    invoke<string[]>("generate_privilege_diff_sql", {
      driver,
      user,
      host,
      database,
      changes: changes.map((c) => ({ ...c, table: c.table ?? null })),
    }).then((r) => parseResponse(schemas.stringArrayResponse, r, "generate_privilege_diff_sql")),
  /**
   * 確認済みの SQL 文 (CREATE USER / DROP USER / ALTER ... PASSWORD / GRANT /
   * REVOKE) を 1 トランザクションで適用する。`applySyncSql` と同じガード
   * (read_only セッション拒否・空文拒否) を持ち、クエリ履歴には一切記録しない。
   */
  applyPrivilegeSql: (params: {
    sessionId: string;
    database?: string | null;
    statements: string[];
  }) =>
    invoke<number>("apply_privilege_sql", {
      sessionId: params.sessionId,
      database: params.database ?? null,
      statements: params.statements,
    }).then((r) => parseResponse(schemas.numberResponse, r, "apply_privilege_sql")),
};
