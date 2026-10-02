import { describe, expect, it } from "vitest";
import type { z } from "zod";
import fixtures from "./fixtures/serdeResponseFixtures.json";
import * as schemas from "../api/schemas";

// zod ⇔ serde フィールド整合の共有ゴールデン (フロント側、#625)。
//
// 主要レスポンス型について、Rust の serde が実際に吐いた JSON
// (`fixtures/serdeResponseFixtures.json`、`src-tauri/tests/serde_schema_parity.rs`
// が生成・固定) を `api/schemas.ts` の zod スキーマで検証する。バック側の対テスト
// (`serde_schema_parity.rs`) がフィクスチャ = 実 serde 出力を保証するので、ここでは:
//
//   1. 各フィクスチャが対応する zod スキーマを **通る** (Rust → zod 互換。必須フィールド
//      欠落・型不一致を検出)。
//   2. フィクスチャのキー集合が zod スキーマの `shape` のキー集合と **一致する**
//      (フィールドの追加/削除ドリフトを双方向に検出。zod は既定で未知キーを黙って
//      捨てるため、parse だけではバック側のフィールド追加に気付けない — キー集合の
//      突き合わせで塞ぐ)。
//
// Rust 側でフィールドを足すとバックの対テストがまず落ち、フィクスチャを再生成すると
// 今度はこのキー集合比較が落ちて zod 側の追随漏れに気付ける、という二段構え。

type AnyObjectSchema = z.ZodObject<z.ZodRawShape>;

// フィクスチャのキー ⇔ エクスポート済み zod スキーマの対応。`column` / `serverVariable`
// は非公開の入れ子スキーマなので、それらを内包する上位型 (queryResult / serverInfo) の
// parse で間接的にカバーする (主要レスポンス型のキー整合をここで固定)。同様に
// `sshProfile` (connectionProfile 内)・`tableDiff`/`columnDiff`/`diffStatus`
// (schemaDiff 内)・`syncStatement` (syncPlan 内)・`rowDiff` (dataDiff 内。
// `key_unreliable` は往復時に zod が意図的に落とすフィールドなのでスキーマに
// 含めない、#824) も上位型経由の間接カバーで、個別 case は持たない。
//
// #825: ストリーミングイベントの emit ペイロードも追加。`skippedRowInfo`
// (importDoneEvent 内) も上記と同じ間接カバーで個別 case を持たない。
// `streamCancelledEvent` フィクスチャは `StreamCancelledEvent` (Rust) を
// export/import の cancelled イベントで共有しており、`dump-stream:cancelled`
// も同一シェイプの `dumpCancelledEvent` zod スキーマで受けるため、ここでは同じ
// フィクスチャを両スキーマに対して検証する。
//
// #1096: Query/Preview ストリームは Tauri Channel 経由の `kind` タグ付き
// メッセージ (`QueryStreamMessage` / `PreviewStreamMessage`) に切り替わった。
// `previewStreamRowsMessageLite` は before/after 共有 (`kind` が違うだけの同じ
// shape) — フィクスチャは `beforeRows` の 1 サンプルのみ持つ。
const cases: Array<[keyof typeof fixtures, AnyObjectSchema]> = [
  ["queryResult", schemas.queryResult],
  // #1257: 行配列を外側だけ検証する軽量版も、フルスキーマと同じキー集合を持つこと。
  ["queryResult", schemas.queryResultLite],
  ["tableColumnInfo", schemas.tableColumnInfo],
  ["tableComment", schemas.tableComment],
  ["tableSchema", schemas.tableSchema],
  ["foreignKey", schemas.foreignKey],
  ["indexInfo", schemas.indexInfo],
  ["schemaObject", schemas.schemaObject],
  ["routineSignature", schemas.routineSignature],
  ["tableRowEstimate", schemas.tableRowEstimate],
  ["tableRowIdentity", schemas.tableRowIdentity],
  ["tableSizeInfo", schemas.tableSizeInfo],
  ["serverInfo", schemas.serverInfo],
  ["serverMetrics", schemas.serverMetrics],
  ["processInfo", schemas.processInfo],
  ["queryStatsSupport", schemas.queryStatsSupport],
  ["liveQuery", schemas.liveQuery],
  ["statementDeltaRow", schemas.statementDeltaRow],
  ["columnProfile", schemas.columnProfile],
  ["healthFinding", schemas.healthFinding],
  ["skippedRule", schemas.skippedRule],
  ["schemaHealthReport", schemas.schemaHealthReport],
  ["connectionProfile", schemas.connectionProfile],
  ["snippet", schemas.snippet],
  ["historyEntry", schemas.historyEntry],
  ["logView", schemas.logView],
  ["csvPreview", schemas.csvPreview],
  ["cellBlobProbe", schemas.cellBlobProbe],
  ["connectResult", schemas.connectResult],
  ["localTableMeta", schemas.localTableMeta],
  ["profileImportResult", schemas.profileImportResult],
  ["cancelStreamResponse", schemas.cancelStreamResponse],
  ["knownHost", schemas.knownHost],
  ["schemaDiff", schemas.schemaDiff],
  ["syncPlan", schemas.syncPlan],
  ["dataDiff", schemas.dataDiff],
  ["dataDiff", schemas.dataDiffLite],

  // #1096: Query/Preview ストリーミングメッセージ (Tauri Channel)。
  ["queryStreamColumnsMessage", schemas.queryStreamColumnsMessage],
  ["queryStreamRowsMessageLite", schemas.queryStreamRowsMessageLite],
  // 境界ケース: 空結果 (`rows: []`) / キャンセル直後 (`deliveredRows: 0`)。
  // shape (キー集合) は代表値と同一なので同じスキーマで検証する。
  ["queryStreamRowsMessageLiteEmpty", schemas.queryStreamRowsMessageLite],
  ["queryStreamDoneMessage", schemas.queryStreamDoneMessage],
  // 結果ハンドル (#1264)。
  ["resultFindOutput", schemas.resultFindOutput],
  ["resultColumnStats", schemas.resultColumnStats],
  ["queryStreamPatchMessage", schemas.queryStreamPatchMessage],
  // #1257: ブロードキャスト比較の Channel メッセージ。
  ["broadcastEnvMessage", schemas.broadcastEnvMessage],
  ["broadcastCancelledMessage", schemas.broadcastCancelledMessage],
  ["broadcastDoneMessage", schemas.broadcastDoneMessage],
  ["queryStreamErrorMessage", schemas.queryStreamErrorMessage],
  ["channelCancelledMessage", schemas.channelCancelledMessage],
  ["channelCancelledMessageZero", schemas.channelCancelledMessage],
  // #1256: エディタのバッチ実行 (`run_sql_batch`) の Channel メッセージ。
  ["batchStreamStartedMessage", schemas.batchStreamStartedMessage],
  ["batchStreamResultsMessage", schemas.batchStreamResultsMessage],
  ["batchStreamDoneMessage", schemas.batchStreamDoneMessage],
  ["batchStreamErrorMessage", schemas.batchStreamErrorMessage],
  ["batchStreamCancelledMessage", schemas.batchStreamCancelledMessage],
  ["previewStreamMetaMessage", schemas.previewStreamMetaMessage],
  ["previewStreamRowsMessageLite", schemas.previewStreamRowsMessageLite],
  ["previewStreamDoneMessage", schemas.previewStreamDoneMessage],
  ["previewStreamErrorMessage", schemas.previewStreamErrorMessage],

  // #825: CSV インポート/エクスポート/ダンプの emit ペイロード (名前付き
  // イベントのまま、#1096 のスコープ外)。
  ["streamCancelledEvent", schemas.streamCancelledEvent],
  ["streamCancelledEvent", schemas.dumpCancelledEvent],
  ["importStartedEvent", schemas.importStartedEvent],
  ["importProgressEvent", schemas.importProgressEvent],
  ["importDoneEvent", schemas.importDoneEvent],
  // #973: `.sql` スクリプト実行の `sql-script:*` (scriptFailure は done/error 内で間接カバー)。
  ["scriptProgressEvent", schemas.scriptProgressEvent],
  ["scriptDoneEvent", schemas.scriptDoneEvent],
  ["scriptErrorEvent", schemas.scriptErrorEvent],
  ["importErrorEvent", schemas.importErrorEvent],
  ["dumpProgressEvent", schemas.dumpProgressEvent],
  ["dumpDoneEvent", schemas.dumpDoneEvent],
  ["dumpErrorEvent", schemas.dumpErrorEvent],
  ["exportProgressEvent", schemas.exportProgressEvent],
  ["exportDoneEvent", schemas.exportDoneEvent],
  // #711: 在グリッド経路 `export_query_result` の戻り値。
  ["exportResult", schemas.exportResult],
  ["exportStreamErrorEvent", schemas.exportStreamErrorEvent],
  ["connectPhaseEvent", schemas.connectPhaseEvent],

  // #1195: enum を含む型は全バリアントを最低 1 回シリアライズした配列 (`*Variants`)
  // を、各要素ごとに同じスキーマで検証する (enum に値を足したのに zod が古い、を検出)。
  ["healthFindingVariants", schemas.healthFinding],
  ["schemaHealthReportVariants", schemas.schemaHealthReport],
  ["queryResultVariants", schemas.queryResult],
  ["connectionProfileVariants", schemas.connectionProfile],
  ["snippetVariants", schemas.snippet],
  ["schemaDiffVariants", schemas.schemaDiff],
  ["syncPlanVariants", schemas.syncPlan],
  ["dataDiffVariants", schemas.dataDiff],
  ["broadcastEnvMessageVariants", schemas.broadcastEnvMessage],
  ["batchStreamResultsMessageVariants", schemas.batchStreamResultsMessage],
  ["previewStreamRowsMessageVariants", schemas.previewStreamRowsMessageLite],
  // Preview の cancelled は Query と同一シェイプ (`channelCancelledMessage` を共有)。
  ["previewStreamCancelledMessage", schemas.channelCancelledMessage],

  // #1243: `#[tauri::command]` の戻り値型で、これまでフィクスチャに無かった型
  // (`serdeCoverageParity.test.ts` が載せ漏れを検出する)。
  ["alterTableContext", schemas.alterTableContext],
  ["assertionSql", schemas.assertionSql],
  ["assertionOutcome", schemas.assertionOutcome],
  ["assertionVariants", schemas.assertion],
  ["assertionRowCountOpVariants", schemas.assertion],
  ["assertionRunRecord", schemas.assertionRunRecord],
  ["writeCaptureSummaryVariants", schemas.writeCaptureSummary],
  ["healthProbeItemVariants", schemas.healthProbeItem],
  ["incomingForeignKey", schemas.incomingForeignKey],
  ["tableStatistic", schemas.tableStatistic],
  ["insertRowsResult", schemas.insertRowsResult],
  ["openTableResult", schemas.openTableResult],
  ["openTableEntryVariants", schemas.openTableEntry],
  ["databaseTables", schemas.databaseTables],
  ["schemaTree", schemas.schemaTree],
  ["resolvedSshAlias", schemas.resolvedSshAlias],
  ["killProcessesResult", schemas.killProcessesResult],
  ["dbUserInfo", schemas.dbUserInfo],
  ["userPrivileges", schemas.userPrivileges],
  ["objectSearchHit", schemas.objectSearchHit],
  ["schemaSnapshotTable", schemas.schemaSnapshotTable],
  ["sandboxRecord", schemas.sandboxRecord],
  ["sandboxCreateResponse", schemas.sandboxCreateResponse],
  ["sandboxTableDiffResult", schemas.sandboxTableDiffResult],
  ["sandboxSchemaDiffResult", schemas.sandboxSchemaDiffResult],
  ["dataDiffHandle", schemas.dataDiffHandle],
  ["undoPreviewResponse", schemas.undoPreviewResponse],
  ["undoOutcome", schemas.undoOutcome],
  ["taskDefinitionVariants", schemas.taskDefinition],
  ["taskExportFormatVariants", schemas.taskDefinition],
  ["taskRun", schemas.taskRun],
  ["schedulerSettings", schemas.schedulerSettings],
  ["timelapseWatchOutcome", schemas.timelapseWatchOutcome],
  ["timelapseCaptureOutcome", schemas.timelapseCaptureOutcome],
  ["tableWatch", schemas.tableWatch],
  ["timelapseGenerationDiff", schemas.timelapseGenerationDiff],
  ["schemaDriftGeneration", schemas.schemaDriftGeneration],
  ["schemaDriftSummary", schemas.schemaDriftSummary],
  ["schemaDriftCapture", schemas.schemaDriftCapture],
  ["planWatchEntryVariants", schemas.planWatchEntry],
  ["planWatchRefreshResult", schemas.planWatchRefreshResult],
  ["dumpToolStatusVariants", schemas.dumpToolStatus],
  ["encryptedProfileExportResult", schemas.encryptedProfileExportResult],
  ["encryptedProfileImportResult", schemas.encryptedProfileImportResult],
];

/** `*Variants` キーは「全バリアントを網羅した配列」。それ以外は単一インスタンス。 */
function instancesOf(name: string, fixture: unknown): unknown[] {
  if (!name.endsWith("Variants")) return [fixture];
  expect(Array.isArray(fixture), `${name} は配列であること`).toBe(true);
  expect((fixture as unknown[]).length, `${name} は空でないこと`).toBeGreaterThan(0);
  return fixture as unknown[];
}

describe("zod ⇔ serde フィールドパリティ (主要レスポンス型)", () => {
  for (const [name, schema] of cases) {
    describe(name, () => {
      const fixture = fixtures[name];

      it("Rust serde 出力が zod スキーマを通る", () => {
        for (const instance of instancesOf(name, fixture)) {
          const result = schema.safeParse(instance);
          expect(
            result.success,
            result.success
              ? ""
              : `zod parse failed for ${name}: ${JSON.stringify(result.error.issues, null, 2)}`,
          ).toBe(true);
        }
      });

      it("フィクスチャのキー集合が zod スキーマの shape と一致する", () => {
        const schemaKeys = Object.keys(schema.shape).sort();
        for (const instance of instancesOf(name, fixture)) {
          const fixtureKeys = Object.keys(instance as Record<string, unknown>).sort();
          // ズレたら「どちらに / 何が」余分かをメッセージで示す。
          expect(fixtureKeys).toEqual(schemaKeys);
        }
      });
    });
  }

  it("全フィクスチャ型がテスト対象に含まれる (取りこぼし防止)", () => {
    // フィクスチャに型を足したのにここへ追加し忘れると素通りするのを防ぐ。
    // 非公開スキーマ (column / serverVariable) は上位型経由でカバーするため除外。
    const nestedOnly = new Set(["column", "serverVariable"]);
    const covered = new Set(cases.map(([n]) => n));
    const missing = Object.keys(fixtures).filter(
      (k) => !covered.has(k as keyof typeof fixtures) && !nestedOnly.has(k),
    );
    expect(missing).toEqual([]);
  });
});
