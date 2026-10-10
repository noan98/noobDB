// Stryker (JS ミューテーションテスト, #1358) 専用の Vitest 設定。
// 変異対象の安全網モジュールと、それを (間接的にも) 使う純ロジックのテスト、共有
// ゴールデンだけに絞る。全スイートを変異ごとに回すと初回ドライランがタイムアウトし、
// App.css を読む UI 規約テストなどは node 環境の単体では通らない。
// 対象モジュールを検証するテストを足したら include にも足す。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/__tests__/blobIo.test.ts",
      "src/__tests__/bulkEdit.test.ts",
      "src/__tests__/cellEdit.test.ts",
      "src/__tests__/columnReplace.test.ts",
      "src/__tests__/dangerousSql.test.ts",
      "src/__tests__/editApplyState.test.ts",
      "src/__tests__/maskGolden.test.ts",
      "src/__tests__/maskLiteralsIdentifiers.test.ts",
      "src/__tests__/pasteEdit.test.ts",
      "src/__tests__/preflight.test.ts",
      "src/__tests__/quickSetValues.test.ts",
      "src/__tests__/readOnlyGolden.test.ts",
      "src/__tests__/relatedRows.test.ts",
      "src/__tests__/rowInspectorEdit.test.ts",
      "src/__tests__/schemaMutatingGolden.test.ts",
      "src/__tests__/scriptSplitGolden.test.ts",
      "src/__tests__/sqlScript.test.ts",
      "src/__tests__/statementSplitGolden.test.ts",
      "src/__tests__/streamStats.test.ts",
      "src/__tests__/valuePicker.test.ts",
      "src/__tests__/keysetPagination.test.ts",
      "src/__tests__/fkNavigation.test.ts",
      "src/__tests__/typedEditor.test.ts",
      "src/__tests__/insertDefaults.test.ts",
      "src/__tests__/jsonTree.test.ts",
      "src/__tests__/QueryBuilder.test.ts",
      "src/__tests__/routineCall.test.ts",
      "src/__tests__/serverBrowse.test.ts",
      "src/__tests__/queryParams.test.ts",
      "src/__tests__/tabDirty.test.ts",
    ],
  },
});
