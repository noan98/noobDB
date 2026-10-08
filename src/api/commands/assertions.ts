// `src-tauri/src/commands/assertions.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type {
  DriverKind,
  AssertionRule,
  Assertion,
  SaveAssertionRequest,
  AssertionSql,
  AssertionOutcome,
} from "../tauri";

export const assertionsCommands = {

  /** データ品質アサーション (#742) の一覧 (`assertions.json`)。 */
  listAssertions: () =>
    invoke<Assertion[]>("list_assertions").then((r) =>
      parseResponse(schemas.assertionArray, r, "list_assertions"),
    ),
  saveAssertion: (req: SaveAssertionRequest) =>
    invoke<Assertion>("save_assertion", { req }).then((r) =>
      parseResponse(schemas.assertion, r, "save_assertion"),
    ),
  deleteAssertion: (id: string) => invoke<void>("delete_assertion", { id }),
  /**
   * 保存前のルールを `driver` 方言の読み取り専用 SQL に変換する (DB には触れない)。
   * 編集モーダルのプレビュー用。入力が不完全なら InvalidInput で reject される。
   */
  previewAssertionSql: (params: {
    driver: DriverKind;
    schema: string | null;
    table: string;
    rule: AssertionRule;
  }) =>
    invoke<AssertionSql>("preview_assertion_sql", {
      driver: params.driver,
      schema: params.schema,
      table: params.table,
      rule: params.rule,
    }).then((r) => parseResponse(schemas.assertionSql, r, "preview_assertion_sql")),
  /**
   * 保存済みアサーション 1 件を検証する。バックエンドは `run_lookup_query` と同じ
   * 経路 (セッションの read_only に関係なく読み取り専用の文だけを通す・
   * `queryTimeoutSecs` で打ち切る・クエリ履歴/結果キャッシュに載せない) で実行する。
   */
  runAssertion: (params: {
    sessionId: string;
    id: string;
    database?: string | null;
    queryTimeoutSecs?: number | null;
  }) =>
    invoke<AssertionOutcome>("run_assertion", {
      sessionId: params.sessionId,
      id: params.id,
      database: params.database ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.assertionOutcome, r, "run_assertion")),
};
