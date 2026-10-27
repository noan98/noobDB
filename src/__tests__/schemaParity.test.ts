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
//   3. (#1871) ネスト構造体 (配列要素・判別ユニオンのバリアント含む) も再帰的に同じ
//      キー集合比較をする。`column` / `tableDiff` / `columnDiff` / `syncStatement` /
//      `rowDiff` / `sshProfile` / `skippedRowInfo` などは個別 case を持たなくても、
//      上位型のフィクスチャから降下して検査される。
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
// #1871 以降はネスト降下 (`collectKeyMismatches`) で、上記の「上位型経由の間接カバー」
// 対象も含むネスト構造体のキー集合まで検査する (個別 case の追加は不要)。
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
  ["tableExtrasInfo", schemas.tableExtrasInfo],
  ["tableTrigger", schemas.tableTrigger],
  ["schemaObject", schemas.schemaObject],
  ["routineSignature", schemas.routineSignature],
  ["tableRowEstimate", schemas.tableRowEstimate],
  ["tableRowIdentity", schemas.tableRowIdentity],
  ["tableSizeInfo", schemas.tableSizeInfo],
  ["serverInfo", schemas.serverInfo],
  ["serverMetrics", schemas.serverMetrics],
  ["sqliteMaintenanceResult", schemas.sqliteMaintenanceResult],
  ["indexOverlap", schemas.indexOverlap],
  ["processInfo", schemas.processInfo],
  ["queryStatsSupport", schemas.queryStatsSupport],
  ["liveQuery", schemas.liveQuery],
  ["statementDeltaRow", schemas.statementDeltaRow],
  ["columnProfile", schemas.columnProfile],
  ["tableProfileOverview", schemas.tableProfileOverview],
  ["schemaCacheTime", schemas.schemaCacheTime],
  ["healthFinding", schemas.healthFinding],
  ["skippedRule", schemas.skippedRule],
  ["schemaHealthReport", schemas.schemaHealthReport],
  ["connectionProfile", schemas.connectionProfile],
  ["snippet", schemas.snippet],
  ["historyEntry", schemas.historyEntry],
  ["logView", schemas.logView],
  ["perfStatus", schemas.perfStatus],
  ["keyringStatus", schemas.keyringStatus],
  ["csvPreview", schemas.csvPreview],
  ["cellBlobProbe", schemas.cellBlobProbe],
  ["blobFolderSaveResult", schemas.blobFolderSaveResult],
  ["transferPreview", schemas.transferPreview],
  ["connectResult", schemas.connectResult],
  ["localTableMeta", schemas.localTableMeta],
  ["profileImportResult", schemas.profileImportResult],
  ["cancelStreamResponse", schemas.cancelStreamResponse],
  // AI 基盤 (#690)
  ["aiConnectionTestResult", schemas.aiConnectionTestResult],
  ["aiUsageRecord", schemas.aiUsageRecord],
  // #1534: AI ストリーム (Channel) とタスク進捗。
  ["aiStreamDeltaMessage", schemas.aiStreamDeltaMessage],
  ["aiStreamRetryingMessage", schemas.aiStreamRetryingMessage],
  ["aiStreamDoneMessage", schemas.aiStreamDoneMessage],
  ["aiStreamErrorMessage", schemas.aiStreamErrorMessage],
  ["channelCancelledMessageAi", schemas.channelCancelledMessage],
  ["taskRunProgressEvent", schemas.taskRunProgressEvent],
  ["knownHost", schemas.knownHost],
  ["knownHostEvent", schemas.knownHostEvent],
  ["importScan", schemas.importScan],
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
  ["resultDuplicateKeys", schemas.resultDuplicateKeys],
  ["queryStreamPatchMessage", schemas.queryStreamPatchMessage],
  // #1257: ブロードキャスト比較の Channel メッセージ。
  ["broadcastEnvMessage", schemas.broadcastEnvMessage],
  ["broadcastCancelledMessage", schemas.broadcastCancelledMessage],
  ["broadcastDoneMessage", schemas.broadcastDoneMessage],
  // #1773: Where-used / 値検索 (`find_where_used` / `data_search_stream`) の Channel メッセージ。
  ["whereUsedProgressMessage", schemas.whereUsedProgressMessage],
  ["whereUsedDoneMessage", schemas.whereUsedDoneMessage],
  ["whereUsedErrorMessage", schemas.whereUsedErrorMessage],
  ["whereUsedCancelledMessage", schemas.whereUsedCancelledMessage],
  ["dataSearchProgressMessage", schemas.dataSearchProgressMessage],
  // table メッセージは `entry.status` の全バリアント (hit / no-hit / skipped) を配列で検証。
  ["dataSearchTableMessageVariants", schemas.dataSearchTableMessage],
  ["dataSearchDoneMessage", schemas.dataSearchDoneMessage],
  ["dataSearchErrorMessage", schemas.dataSearchErrorMessage],
  // cancelled は他の Channel と共有の `channelCancelledMessage` (`deliveredRows`)。
  ["dataSearchCancelledMessage", schemas.channelCancelledMessage],
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
  // #1623: 取り込みの事前検証の結果と、保存済みマッピングテンプレート。
  ["importDryRunResult", schemas.importDryRunResult],
  ["importTemplate", schemas.importTemplate],
  // #973: `.sql` スクリプト実行の `sql-script:*` (scriptFailure は done/error 内で間接カバー)。
  ["scriptProgressEvent", schemas.scriptProgressEvent],
  ["scriptDoneEvent", schemas.scriptDoneEvent],
  ["scriptErrorEvent", schemas.scriptErrorEvent],
  // #1535: 事前確認 (ドライラン) の完了イベントと、文字コード付きの SQL ファイル読み込み結果。
  ["scriptAnalyzedEvent", schemas.scriptAnalyzedEvent],
  ["sqlFileContent", schemas.sqlFileContent],
  ["sqlEncodingPreview", schemas.sqlEncodingPreview],
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
  ["sqliteRebuildPlan", schemas.sqliteRebuildPlan],
  ["assertionSql", schemas.assertionSql],
  ["assertionOutcome", schemas.assertionOutcome],
  ["acceptedValuesCandidates", schemas.acceptedValuesCandidates],
  ["importAssertionsResult", schemas.importAssertionsResult],
  ["snippetImportPreview", schemas.snippetImportPreview],
  ["snippetImportResult", schemas.snippetImportResult],
  ["assertionVariants", schemas.assertion],
  ["assertionRowCountOpVariants", schemas.assertion],
  ["assertionRunRecord", schemas.assertionRunRecord],
  ["writeCaptureSummaryVariants", schemas.writeCaptureSummary],
  ["healthProbeItemVariants", schemas.healthProbeItem],
  ["incomingForeignKey", schemas.incomingForeignKey],
  ["columnDependencyReport", schemas.columnDependencyReport],
  ["tableStatistic", schemas.tableStatistic],
  ["insertRowsResult", schemas.insertRowsResult],
  // #1777: `status` タグ付き enum は shape が違うので、バリアントごとに 1 キーずつ検証する。
  ["bulkWriteOutcomeApplied", schemas.bulkWriteOutcomeApplied],
  ["bulkWriteOutcomeRowCountExceeded", schemas.bulkWriteOutcomeRowCountExceeded],
  ["bulkWriteOutcomeOptimisticConflict", schemas.bulkWriteOutcomeOptimisticConflict],
  ["bulkWriteOutcomeRollbackIncomplete", schemas.bulkWriteOutcomeRollbackIncomplete],
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
  ["sandboxResetResult", schemas.sandboxResetResult],
  ["dataDiffHandle", schemas.dataDiffHandle],
  ["undoPreviewResponse", schemas.undoPreviewResponse],
  ["undoOutcome", schemas.undoOutcome],
  ["undoBatchPreviewResponse", schemas.undoBatchPreviewResponse],
  ["exportPlanOutcome", schemas.exportPlanOutcome],
  ["taskDefinitionVariants", schemas.taskDefinition],
  ["taskExportFormatVariants", schemas.taskDefinition],
  ["taskRun", schemas.taskRun],
  ["schedulerSettings", schemas.schedulerSettings],
  ["timelapseWatchOutcome", schemas.timelapseWatchOutcome],
  ["timelapseCaptureOutcome", schemas.timelapseCaptureOutcome],
  ["tableWatch", schemas.tableWatch],
  ["timelapseGenerationDiff", schemas.timelapseGenerationDiff],
  ["timelapseRowHistory", schemas.timelapseRowHistory],
  ["schemaDriftRevertSql", schemas.schemaDriftRevertSql],
  ["schemaDriftGeneration", schemas.schemaDriftGeneration],
  ["schemaDriftSummary", schemas.schemaDriftSummary],
  ["schemaDriftCapture", schemas.schemaDriftCapture],
  ["planWatchEntryVariants", schemas.planWatchEntry],
  ["planWatchRefreshResult", schemas.planWatchRefreshResult],
  ["skippedProfileVariants", schemas.skippedProfile],
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

// ---- ネスト構造体への降下 (#1871) ----
//
// トップレベルのキー集合比較だけでは、ネスト構造体 (`ColumnDiff` / `TableDiff` など) に
// Rust 側でフィールドを足しても、親の zod parse が未知キーを黙って捨てるため何も落ちない。
// zod スキーマとフィクスチャ値を並行して降下し、各階層のオブジェクトでキー集合を突き合わせる。

/** zod 4 の内部定義 (`_zod.def`) の必要最小限の形。 */
type ZodDef = {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  in?: z.ZodType;
  options?: z.ZodType[];
  valueType?: z.ZodType;
  items?: z.ZodType[];
  getter?: () => z.ZodType;
};

function defOf(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/**
 * 意図的に zod 側へ持たないネストフィールド (フィクスチャ名 → パス → 許容する余剰キー)。
 * パスは配列を `[]` で表した `.` 区切り。ここへ足すときは理由を必ずコメントで残すこと。
 */
const usedNestedExtras = new Set<string>();

const KNOWN_NESTED_EXTRA_KEYS: Record<string, Record<string, string[]>> = {
  // #824: `rowDiff.key_unreliable` は往復時に zod が意図的に落とす (スキーマに含めない)。
  dataDiff: { "rows[]": ["key_unreliable"] },
  dataDiffVariants: { "rows[]": ["key_unreliable"] },
  timelapseGenerationDiff: { "diff.rows[]": ["key_unreliable"] },
};

function isOmittable(schema: z.ZodType | undefined): boolean {
  if (!schema) return false;
  const t = defOf(schema).type;
  return t === "optional" || t === "default" || t === "prefault";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `schema` をたどりながら `value` の各ネストオブジェクトのキー集合を zod の shape と比較し、
 * 食い違いを `パス: 余剰/不足` の文字列で集める。ルート (path = "") も含む。
 */
function collectKeyMismatches(
  schema: z.ZodType,
  value: unknown,
  path: string,
  out: string[],
  allowed: Record<string, string[]> = {},
  used: Set<string> = new Set(),
): void {
  const def = defOf(schema);
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      if (def.innerType) collectKeyMismatches(def.innerType, value, path, out, allowed, used);
      return;
    case "pipe":
      // `.transform()` は in 側 (入力 = Rust が吐いた JSON の形) を比較する。
      if (def.in) collectKeyMismatches(def.in, value, path, out, allowed, used);
      return;
    case "lazy":
      if (def.getter) collectKeyMismatches(def.getter(), value, path, out, allowed, used);
      return;
    case "array":
      if (Array.isArray(value) && def.element) {
        for (const item of value) collectKeyMismatches(def.element, item, `${path}[]`, out, allowed, used);
      }
      return;
    case "tuple":
      if (Array.isArray(value) && def.items) {
        def.items.forEach((item, i) => {
          collectKeyMismatches(item, value[i], `${path}[${i}]`, out, allowed, used);
        });
      }
      return;
    case "record":
      if (isPlainObject(value) && def.valueType) {
        for (const v of Object.values(value)) {
          collectKeyMismatches(def.valueType, v, `${path}{}`, out, allowed, used);
        }
      }
      return;
    case "union": {
      // 値を通すバリアント (判別ユニオンなら判別子が一致するもの) へ降下する。
      const match = def.options?.find((o) => o.safeParse(value).success);
      if (match) collectKeyMismatches(match, value, path, out, allowed, used);
      return;
    }
    case "object": {
      if (!isPlainObject(value) || !def.shape) return;
      const schemaKeys = Object.keys(def.shape);
      const valueKeys = Object.keys(value);
      const extra = valueKeys.filter((k) => !schemaKeys.includes(k) && !allowed[path]?.includes(k));
      // zod 側が optional / default のフィールドは、Rust が `skip_serializing_if` で省く
      // ことがあるのでフィクスチャに無くてもよい (必須フィールドの欠落だけを不足と見なす)。
      for (const k of valueKeys) {
        if (!schemaKeys.includes(k) && allowed[path]?.includes(k)) used.add(`${path}:${k}`);
      }
      const missing = schemaKeys.filter((k) => !valueKeys.includes(k) && !isOmittable(def.shape?.[k]));
      if (extra.length > 0) out.push(`${path || "(root)"}: zod に無い (Rust のみ) ${extra.join(", ")}`);
      if (missing.length > 0) {
        out.push(`${path || "(root)"}: フィクスチャに無い (zod のみ) ${missing.join(", ")}`);
      }
      for (const [key, child] of Object.entries(def.shape)) {
        if (key in value)
          collectKeyMismatches(child, value[key], path ? `${path}.${key}` : key, out, allowed, used);
      }
      return;
    }
    default:
      return;
  }
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

      // #1871: ネスト構造体 (配列要素・判別ユニオンのバリアント含む) のキー集合も同様に比較する。
      it("ネスト構造体のキー集合も zod スキーマの shape と一致する", () => {
        const mismatches: string[] = [];
        const used = new Set<string>();
        for (const instance of instancesOf(name, fixture)) {
          collectKeyMismatches(schema, instance, "", mismatches, KNOWN_NESTED_EXTRA_KEYS[name] ?? {}, used);
        }
        for (const u of used) usedNestedExtras.add(`${name}|${u}`);
        expect([...new Set(mismatches)]).toEqual([]);
      });
    });
  }

  it("KNOWN_NESTED_EXTRA_KEYS の各エントリが実際に使われている (陳腐化防止)", () => {
    // フィクスチャ側から該当キーが消えたのに許可リストだけ残る、を検出する。
    const unused: string[] = [];
    for (const [name, byPath] of Object.entries(KNOWN_NESTED_EXTRA_KEYS)) {
      for (const [path, keys] of Object.entries(byPath)) {
        for (const key of keys) {
          if (!usedNestedExtras.has(`${name}|${path}:${key}`)) unused.push(`${name} ${path}:${key}`);
        }
      }
    }
    expect(unused).toEqual([]);
  });

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
