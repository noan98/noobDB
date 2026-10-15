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
  AcceptedValuesCandidates,
  ImportAssertionsResult,
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
  /** 一覧から外してごみ箱へ移す。`restoreAssertion` で取り消せる (#1621)。 */
  deleteAssertion: (id: string) => invoke<void>("delete_assertion", { id }),
  /** 削除したアサーションを一覧へ戻す (#1621)。 */
  restoreAssertion: (id: string) =>
    invoke<Assertion>("restore_assertion", { id }).then((r) =>
      parseResponse(schemas.assertion, r, "restore_assertion"),
    ),
  /**
   * アサーション定義を JSON 文字列として書き出す (#1621)。`ids` が空/省略なら全件。
   * 保存ダイアログで選んだパスへ `writeTextFile` で書く。
   */
  exportAssertions: (ids?: string[] | null) =>
    invoke<string>("export_assertions", { ids: ids ?? null }).then((r) =>
      parseResponse(schemas.stringResponse, r, "export_assertions"),
    ),
  /**
   * 書き出した JSON を取り込む (#1621)。ID の衝突は新規採番、同内容は追加せず、
   * 検証に通らない要素は `rejected` で返る。`profileId` を渡すとプロファイル限定の
   * スコープをそのプロファイルへ付け替える。
   */
  importAssertions: (json: string, profileId?: string | null) =>
    invoke<ImportAssertionsResult>("import_assertions", { json, profileId: profileId ?? null }).then((r) =>
      parseResponse(schemas.importAssertionsResult, r, "import_assertions"),
    ),
  /**
   * 列の DISTINCT 値を読み取り専用で取得し、`accepted_values` の候補として返す (#1621)。
   * 最大 50 種。read_only 接続でも動く。
   */
  suggestAcceptedValues: (params: {
    sessionId: string;
    schema: string | null;
    table: string;
    column: string;
    database?: string | null;
    queryTimeoutSecs?: number | null;
  }) =>
    invoke<AcceptedValuesCandidates>("suggest_accepted_values", {
      sessionId: params.sessionId,
      schema: params.schema,
      table: params.table,
      column: params.column,
      database: params.database ?? null,
      queryTimeoutSecs: params.queryTimeoutSecs ?? null,
    }).then((r) => parseResponse(schemas.acceptedValuesCandidates, r, "suggest_accepted_values")),
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
