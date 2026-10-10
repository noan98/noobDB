// Stryker (JS ミューテーションテスト, #1358) 専用の Vitest 設定。
// 変異対象の安全網モジュール (と共有ゴールデン) を検証する純ロジックのテストだけに絞り、全スイートを変異ごとに
// 回さない (全体は jsdom 込みで重く、初回ドライランがタイムアウトする)。
// すべて純ロジックのテストなので node 環境で足りる。
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
    ],
  },
});
