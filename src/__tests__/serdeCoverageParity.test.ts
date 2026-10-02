import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/serdeResponseFixtures.json";

// IPC レスポンス型の serde ゴールデン網羅性パリティ (#1243)。
//
// `schemaParity.test.ts` / `serde_schema_parity.rs` が突き合わせるのは「フィクスチャに
// 載せた型」だけで、`#[tauri::command]` の戻り値型をフィクスチャへ載せ忘れても素通り
// していた (引数名の `ipcArgParity` / 登録の `commandRegistrationParity` と違い、出力側だけ
// 「相手言語のソースを機械的に全件取り込む」網羅化から取り残されていた)。
//
// ここでは `src-tauri/src/commands/**/*.rs` の `#[tauri::command]` 関数シグネチャから
// 戻り値型を機械的に抽出し、**すべての型が次のどれかに分類されている**ことを強制する:
//
//   - `COVERED`  : フィクスチャキー (`serdeResponseFixtures.json`) が存在する型
//   - `EXCLUDED` : golden 不要な型 (理由つき・最小限)
//
// 新しいコマンドの戻り値型を足したのにどちらにも書かないとここで落ちる。COVERED に
// 書いたのにフィクスチャに無い / 一覧が古い (もう返されない型が残っている) 場合も落ちる。
// `commandRegistrationParity.test.ts` と同じ `import.meta.glob` + `?raw` 方式。

const commandModules = import.meta.glob("../../src-tauri/src/commands/**/*.rs", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

/** Rust の型名 → フィクスチャキー。 */
const COVERED: Record<string, string> = {
  AlterTableContext: "alterTableContext",
  Assertion: "assertionVariants",
  AssertionOutcome: "assertionOutcome",
  AssertionRunRecord: "assertionRunRecord",
  AssertionSql: "assertionSql",
  CancelStreamResult: "cancelStreamResponse",
  CaptureOutcome: "timelapseCaptureOutcome",
  CellBlobProbe: "cellBlobProbe",
  ColumnProfile: "columnProfile",
  ColumnStatsOut: "resultColumnStats",
  ConnectResponse: "connectResult",
  ConnectionProfile: "connectionProfile",
  CsvPreview: "csvPreview",
  DataDiffHandle: "dataDiffHandle",
  DatabaseTables: "databaseTables",
  DbUserInfo: "dbUserInfo",
  DriftSummary: "schemaDriftSummary",
  DumpToolStatus: "dumpToolStatusVariants",
  EncryptedExportResult: "encryptedProfileExportResult",
  EncryptedImportResult: "encryptedProfileImportResult",
  ExportResult: "exportResult",
  FindOutput: "resultFindOutput",
  ForeignKey: "foreignKey",
  GenerationDiff: "timelapseGenerationDiff",
  GenerationMeta: "schemaDriftGeneration",
  HealthProbeItem: "healthProbeItemVariants",
  HistoryEntry: "historyEntry",
  ImportResult: "profileImportResult",
  IncomingForeignKey: "incomingForeignKey",
  IndexInfo: "indexInfo",
  InsertRowsResult: "insertRowsResult",
  KillProcessesResult: "killProcessesResult",
  KnownHost: "knownHost",
  LiveQuery: "liveQuery",
  LocalTableMeta: "localTableMeta",
  LogView: "logView",
  ObjectHit: "objectSearchHit",
  OpenTableEntry: "openTableEntryVariants",
  OpenTableResult: "openTableResult",
  PlanWatchRefresh: "planWatchRefreshResult",
  ProcessListItem: "processInfo",
  ProfileWithSecretFlags: "connectionProfile",
  QueryResult: "queryResult",
  QueryStatsSupport: "queryStatsSupport",
  ResolvedSshAlias: "resolvedSshAlias",
  RoutineSignature: "routineSignature",
  SandboxCreateResponse: "sandboxCreateResponse",
  SandboxRecord: "sandboxRecord",
  SandboxSchemaDiffResult: "sandboxSchemaDiffResult",
  SandboxTableDiffResult: "sandboxTableDiffResult",
  SchedulerSettings: "schedulerSettings",
  SchemaDiff: "schemaDiff",
  SchemaDriftCapture: "schemaDriftCapture",
  SchemaHealthReport: "schemaHealthReport",
  SchemaObject: "schemaObject",
  SchemaTree: "schemaTree",
  ServerInfo: "serverInfo",
  ServerMetrics: "serverMetrics",
  Snippet: "snippet",
  StatementDeltaRow: "statementDeltaRow",
  SyncPlan: "syncPlan",
  TableColumnInfo: "tableColumnInfo",
  TableColumns: "schemaSnapshotTable",
  TableComment: "tableComment",
  TableRowEstimate: "tableRowEstimate",
  TableSchema: "tableSchema",
  TableStatistic: "tableStatistic",
  TableWatch: "tableWatch",
  TaskDefinition: "taskDefinitionVariants",
  TaskRun: "taskRun",
  UndoOutcome: "undoOutcome",
  UndoPreviewResponse: "undoPreviewResponse",
  UserPrivileges: "userPrivileges",
  WatchEntry: "planWatchEntryVariants",
  WatchOutcome: "timelapseWatchOutcome",
  WriteCaptureSummary: "writeCaptureSummaryVariants",
};

/**
 * golden 不要な型 (理由つき)。追加するときは「なぜ golden 不要か」を日本語で書く。
 * `Vec` / `Option` / `Result` / `String` などのラッパーと小文字のプリミティブは
 * 抽出時に自動で除外されるので、ここには書かない。
 */
const EXCLUDED: Record<string, string> = {
  Response:
    "tauri::ipc::Response は生バイト列をそのまま返す型で JSON を経由しないため serde の対象外",
  SessionId: "`type SessionId = String` の別名で、構造体ではなく文字列そのもの",
  Value:
    "`Value` 単体はコマンドの戻り値ではなく `Vec<Vec<Value>>` の要素。全形は queryResultVariants (#1195) の行で固定済み",
};

/** ラッパー型 (中身の型を再帰的に見るので型名としては数えない)。 */
const WRAPPERS = new Set(["Result", "Option", "Vec", "String", "HashMap", "BTreeMap", "HashSet"]);

/**
 * `#[tauri::command]` 関数の戻り値型に現れる型名 → 返すコマンド名の一覧。
 * `commandRegistrationParity.test.ts::extractDefinedCommands` と同様、行コメントを
 * 先に除去してから走査する (doc コメント中の記法を誤検出しない)。
 */
function extractReturnedTypes(sources: string[]): Map<string, string[]> {
  const re =
    /#\[tauri::command\](?:\s*#\[[^\]]*\])*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\([\s\S]*?\)\s*(?:->\s*([\s\S]*?))?\s*(?:where[^{]*)?\{/g;
  const returned = new Map<string, string[]>();
  for (const src of sources) {
    const cleaned = src
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, ""))
      .join("\n");
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(cleaned)) !== null) {
      const [, command, ret] = match;
      if (!ret) continue;
      for (const type of ret.match(/\b[A-Z]\w*/g) ?? []) {
        if (WRAPPERS.has(type)) continue;
        returned.set(type, [...(returned.get(type) ?? []), command]);
      }
    }
  }
  return returned;
}

const returned = extractReturnedTypes(Object.values(commandModules));

describe("IPC レスポンス型の serde ゴールデン網羅性 (#[tauri::command] 戻り値型 ⇔ フィクスチャ)", () => {
  it("commands/**/*.rs から十分な数の戻り値型を抽出できている (抽出ロジックの保険)", () => {
    expect(returned.size).toBeGreaterThanOrEqual(60);
    // 代表的な戻り値型 (Vec / Option / Result の入れ子を剥がせている)。
    expect(returned.has("QueryResult")).toBe(true); // Result<QueryResult>
    expect(returned.has("TableComment")).toBe(true); // Result<Vec<TableComment>>
    expect(returned.has("CellBlobProbe")).toBe(true); // Result<Option<CellBlobProbe>>
    // 戻り値ではなく引数にしか現れない型 / ラッパーは含まれない。
    expect(returned.has("State")).toBe(false);
    expect(returned.has("Result")).toBe(false);
  });

  it("すべての戻り値型が COVERED か EXCLUDED のどちらかに分類されている", () => {
    const unclassified = [...returned.keys()]
      .filter((t) => !(t in COVERED) && !(t in EXCLUDED))
      .sort()
      .map((t) => `${t} (${returned.get(t)?.slice(0, 2).join(", ")})`);
    expect(
      unclassified,
      "未分類の戻り値型があります。serde_schema_parity.rs へ代表インスタンスを足して " +
        "(NOOBDB_WRITE_SERDE_FIXTURES=1 で再生成) COVERED に追記するか、golden 不要なら " +
        "理由つきで EXCLUDED に追記してください",
    ).toEqual([]);
  });

  it("COVERED のフィクスチャキーが serdeResponseFixtures.json に実在する", () => {
    const missing = Object.entries(COVERED)
      .filter(([, key]) => !(key in fixtures))
      .map(([type, key]) => `${type} -> ${key}`);
    expect(missing).toEqual([]);
  });

  it("COVERED / EXCLUDED に、もう返されない型や二重登録が残っていない", () => {
    const stale = [...Object.keys(COVERED), ...Object.keys(EXCLUDED)]
      .filter((t) => !returned.has(t))
      .sort();
    expect(stale, "戻り値に現れない型が一覧に残っています").toEqual([]);
    const both = Object.keys(COVERED).filter((t) => t in EXCLUDED);
    expect(both).toEqual([]);
  });

  it("EXCLUDED の理由が空でない", () => {
    const empty = Object.entries(EXCLUDED)
      .filter(([, reason]) => reason.trim() === "")
      .map(([type]) => type);
    expect(empty).toEqual([]);
  });
});
