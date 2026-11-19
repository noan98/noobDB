import { describe, expect, it } from "vitest";
import cacheRs from "../../src-tauri/src/cache/mod.rs?raw";
import bulkWriteRs from "../../src-tauri/src/commands/bulk_write.rs?raw";
import deadlockRs from "../../src-tauri/src/db/deadlock.rs?raw";
import profileRs from "../../src-tauri/src/db/profile.rs?raw";
import flightRecorderRs from "../../src-tauri/src/flight_recorder/mod.rs?raw";
import historyStoreRs from "../../src-tauri/src/history/store.rs?raw";
import dbModRs from "../../src-tauri/src/db/mod.rs?raw";
import cleanupRs from "../../src-tauri/src/profiles/cleanup.rs?raw";
import aiRs from "../../src-tauri/src/commands/ai.rs?raw";
import cellBlobRs from "../../src-tauri/src/commands/cell_blob.rs?raw";
import connectionRs from "../../src-tauri/src/commands/connection.rs?raw";
import diffRs from "../../src-tauri/src/commands/diff.rs?raw";
import exportRs from "../../src-tauri/src/commands/export.rs?raw";
import resultStoreRs from "../../src-tauri/src/db/result_store.rs?raw";
import rowMergeRs from "../../src-tauri/src/db/row_merge.rs?raw";
import resultRs from "../../src-tauri/src/commands/result.rs?raw";
import scriptRs from "../../src-tauri/src/commands/script.rs?raw";
import localRs from "../../src-tauri/src/commands/local.rs?raw";
import advisorRs from "../../src-tauri/src/db/advisor.rs?raw";
import broadcastDiffRs from "../../src-tauri/src/db/broadcast_diff.rs?raw";
import pgListenRs from "../../src-tauri/src/db/pg_listen.rs?raw";
import sqliteRs from "../../src-tauri/src/db/sqlite.rs?raw";
import profileStoreRs from "../../src-tauri/src/profiles/store.rs?raw";
import maintenanceRs from "../../src-tauri/src/tasks/maintenance.rs?raw";
import cloneRowsRs from "../../src-tauri/src/db/clone_rows.rs?raw";
import maskingRs from "../../src-tauri/src/db/masking.rs?raw";
import sandboxRs from "../../src-tauri/src/db/sandbox.rs?raw";
import subsetRs from "../../src-tauri/src/db/subset.rs?raw";
import backupRs from "../../src-tauri/src/profiles/backup.rs?raw";
import tasksRs from "../../src-tauri/src/tasks/mod.rs?raw";
import timelapseRs from "../../src-tauri/src/timelapse/mod.rs?raw";
import appTsx from "../App.tsx?raw";
import connectionFormTsx from "../components/ConnectionForm.tsx?raw";
import columnProfileTs from "../components/columnProfile.ts?raw";
import deadlockTs from "../components/deadlock.ts?raw";
import conversationTs from "../ai/conversation.ts?raw";
import schemaDocTs from "../ai/schemaDoc.ts?raw";
import cellEditTs from "../components/cellEdit.ts?raw";
import resultHandleTs from "../components/resultHandle.ts?raw";
import rowMergeTs from "../components/rowMerge.ts?raw";
import advisorTs from "../components/advisor.ts?raw";
import duplicateKeysTs from "../components/duplicateKeys.ts?raw";
import localQueryTs from "../components/localQuery.ts?raw";
import pgListenTs from "../components/pgListen.ts?raw";
import sqliteAttachTs from "../components/sqliteAttach.ts?raw";
import taskMaintenanceTs from "../components/taskMaintenance.ts?raw";
import broadcastCompareTs from "../broadcastCompare.ts?raw";
import openDatabaseTs from "../openDatabase.ts?raw";
import scriptRunTs from "../scriptRun.ts?raw";
import taskFormatTs from "../taskFormat.ts?raw";
import blobIoTs from "../components/blobIo.ts?raw";
import cloneRowsTs from "../components/cloneRows.ts?raw";
import exportMaskingTs from "../components/exportMasking.ts?raw";
import profileBackupTs from "../components/profileBackup.ts?raw";
import subsetExtractTs from "../components/subsetExtract.ts?raw";
import taskManagerTsx from "../components/TaskManager.tsx?raw";
import sandboxTs from "../sandbox.ts?raw";
import settingsTs from "../settings.ts?raw";

// Rust とフロントの二重実装になっている上限値・既定値を、ソースを読んで突き合わせる (#2301)。
// コメントで「バックエンドと揃える」と書くだけでは片側だけの変更を検出できず、UI では有効なのに
// IPC がバックエンドのエラーで失敗する、というズレになる (#1030 と同種)。
//
// 両側ともソース文字列から `const NAME: T = <式>;` を正規表現で抽出する。TS 側もソースから読むのは、
// `export` していない定数 (TaskManager.tsx など) も対象にするため。

type Src = { name: string; text: string };
const src = (name: string, text: string): Src => ({ name, text });

const SUBSET_TS = src("components/subsetExtract.ts", subsetExtractTs);
const TASK_TS = src("components/TaskManager.tsx", taskManagerTsx);
const SETTINGS_TS = src("settings.ts", settingsTs);
const SANDBOX_TS = src("sandbox.ts", sandboxTs);
const BACKUP_TS = src("components/profileBackup.ts", profileBackupTs);
const SCHEMA_DOC_TS = src("ai/schemaDoc.ts", schemaDocTs);
const CONVERSATION_TS = src("ai/conversation.ts", conversationTs);
const BLOB_TS = src("components/blobIo.ts", blobIoTs);
const MASKING_TS = src("components/exportMasking.ts", exportMaskingTs);
const ADVISOR_TS = src("components/advisor.ts", advisorTs);
const TASK_MAINTENANCE_TS = src("components/taskMaintenance.ts", taskMaintenanceTs);
const DUPLICATE_KEYS_TS = src("components/duplicateKeys.ts", duplicateKeysTs);
const PG_LISTEN_TS = src("components/pgListen.ts", pgListenTs);
const TASK_FORMAT_TS = src("taskFormat.ts", taskFormatTs);
const OPEN_DATABASE_TS = src("openDatabase.ts", openDatabaseTs);
const SCRIPT_RUN_TS = src("scriptRun.ts", scriptRunTs);
const BROADCAST_COMPARE_TS = src("broadcastCompare.ts", broadcastCompareTs);
const LOCAL_QUERY_TS = src("components/localQuery.ts", localQueryTs);
const CELL_EDIT_TS = src("components/cellEdit.ts", cellEditTs);
const EXPORT_RS = src("commands/export.rs", exportRs);
const RESULT_HANDLE_TS = src("components/resultHandle.ts", resultHandleTs);
const ROW_MERGE_TS = src("components/rowMerge.ts", rowMergeTs);
const SQLITE_ATTACH_TS = src("components/sqliteAttach.ts", sqliteAttachTs);

const SUBSET_RS = src("db/subset.rs", subsetRs);
const SANDBOX_RS = src("db/sandbox.rs", sandboxRs);
const DIFF_RS = src("commands/diff.rs", diffRs);
const TASKS_RS = src("tasks/mod.rs", tasksRs);
const TIMELAPSE_RS = src("timelapse/mod.rs", timelapseRs);
const CONNECTION_RS = src("commands/connection.rs", connectionRs);
const AI_RS = src("commands/ai.rs", aiRs);
const BACKUP_RS = src("profiles/backup.rs", backupRs);
const BLOB_RS = src("commands/cell_blob.rs", cellBlobRs);
const MASKING_RS = src("db/masking.rs", maskingRs);
const ADVISOR_RS = src("db/advisor.rs", advisorRs);
const TASK_MAINTENANCE_RS = src("tasks/maintenance.rs", maintenanceRs);
const RESULT_RS = src("commands/result.rs", resultRs);
const PG_LISTEN_RS = src("db/pg_listen.rs", pgListenRs);
const PROFILE_STORE_RS = src("profiles/store.rs", profileStoreRs);
const SCRIPT_RS = src("commands/script.rs", scriptRs);
const BROADCAST_DIFF_RS = src("db/broadcast_diff.rs", broadcastDiffRs);
const LOCAL_RS = src("commands/local.rs", localRs);
const RESULT_STORE_RS = src("db/result_store.rs", resultStoreRs);
const ROW_MERGE_RS = src("db/row_merge.rs", rowMergeRs);
const SQLITE_RS = src("db/sqlite.rs", sqliteRs);
const CLONE_ROWS_TS = src("components/cloneRows.ts", cloneRowsTs);
const CLONE_ROWS_RS = src("db/clone_rows.rs", cloneRowsRs);
const APP_TSX = src("App.tsx", appTsx);
const COLUMN_PROFILE_TS = src("components/columnProfile.ts", columnProfileTs);
const DEADLOCK_TS = src("components/deadlock.ts", deadlockTs);
const CACHE_RS = src("cache/mod.rs", cacheRs);
const BULK_WRITE_RS = src("commands/bulk_write.rs", bulkWriteRs);
const DEADLOCK_RS = src("db/deadlock.rs", deadlockRs);
const PROFILE_RS = src("db/profile.rs", profileRs);
const FLIGHT_RECORDER_RS = src("flight_recorder/mod.rs", flightRecorderRs);
const HISTORY_STORE_RS = src("history/store.rs", historyStoreRs);
const CLEANUP_RS = src("profiles/cleanup.rs", cleanupRs);
const DB_MOD_RS = src("db/mod.rs", dbModRs);
const CONNECTION_FORM_TSX = src("components/ConnectionForm.tsx", connectionFormTsx);

/** 対応表: [TS の定数名, Rust の定数名]。名前が違うものもあるので明示する。 */
const PAIRS: { ts: Src; rs: Src; names: [string, string][] }[] = [
  // #2464: 放置トランザクション自動切断 (分) の上限。フォームの検証と保存・接続時の検証がズレると、
  // フォームで通った値が保存時に弾かれる (または逆)。
  {
    ts: CONNECTION_FORM_TSX,
    rs: DB_MOD_RS,
    names: [["IDLE_IN_TX_TIMEOUT_MAX_MIN", "IDLE_IN_TX_TIMEOUT_MAX_MIN"]],
  },
  // #2446: Rust 側のコメントでフロントとの一致を求めている定数。
  // ID の除外キーがズレると、起動時の孤立データ掃除 (sweep_orphans_once) がローカル接続 /
  // サンドボックスのデータを「存在しないプロファイルのもの」として黙って消す。
  { ts: APP_TSX, rs: CLEANUP_RS, names: [["LOCAL_PROFILE_ID", "LOCAL_PROFILE_ID"]] },
  { ts: SANDBOX_TS, rs: CLEANUP_RS, names: [["SANDBOX_PROFILE_ID_PREFIX", "SANDBOX_ID_PREFIX"]] },
  // 縮退理由コード。Rust 側だけ変わると汎用文言へ黙って倒れる。キー集合は下の別テストでも検証する。
  {
    ts: COLUMN_PROFILE_TS,
    rs: PROFILE_RS,
    names: [
      ["NOTE_SAMPLED", "NOTE_SAMPLED"],
      ["NOTE_OVERVIEW_APPROX_NO_STATS", "NOTE_OVERVIEW_APPROX_NO_STATS"],
    ],
  },
  {
    ts: DEADLOCK_TS,
    rs: DEADLOCK_RS,
    names: [
      ["UNAVAILABLE_NEEDS_PROCESS", "UNAVAILABLE_NEEDS_PROCESS"],
      ["UNAVAILABLE_NO_REPORT", "UNAVAILABLE_NO_REPORT"],
      ["UNAVAILABLE_NO_DETAIL", "UNAVAILABLE_NO_DETAIL"],
    ],
  },
  { ts: SETTINGS_TS, rs: CACHE_RS, names: [["DEFAULT_AUTO_LIMIT_COUNT", "DEFAULT_QUERY_MAX_ROWS"]] },
  {
    ts: CELL_EDIT_TS,
    rs: BULK_WRITE_RS,
    names: [["FLOAT4_WHERE_REL_TOLERANCE", "FLOAT4_WHERE_REL_TOLERANCE"]],
  },
  {
    ts: SETTINGS_TS,
    rs: FLIGHT_RECORDER_RS,
    names: [["DEFAULT_FLIGHT_RECORDER_RETENTION_DAYS", "DEFAULT_RETENTION_DAYS"]],
  },
  {
    ts: SETTINGS_TS,
    rs: HISTORY_STORE_RS,
    names: [["MAX_FLIGHT_RECORDER_RETENTION_DAYS", "MAX_RETENTION_DAYS"]],
  },
  // #2412: コメントだけで揃えていた定数 (Rust 側だけの変更も検出する)。
  {
    ts: ADVISOR_TS,
    rs: ADVISOR_RS,
    names: [
      ["SEQUENCE_METER_WARN_PERCENT", "SEQUENCE_WARN_PERCENT"],
      ["SEQUENCE_METER_DANGER_PERCENT", "SEQUENCE_ERROR_PERCENT"],
    ],
  },
  { ts: TASK_MAINTENANCE_TS, rs: TASK_MAINTENANCE_RS, names: [["MAX_MAINTENANCE_TARGETS", "MAX_TARGETS"]] },
  {
    ts: DUPLICATE_KEYS_TS,
    rs: RESULT_RS,
    names: [
      ["DUPLICATE_INDEX_LIMIT", "DUPLICATE_INDEX_LIMIT"],
      ["DUPLICATE_TOP_MAX", "DUPLICATE_TOP_MAX"],
    ],
  },
  {
    ts: PG_LISTEN_TS,
    rs: PG_LISTEN_RS,
    names: [
      ["PG_LISTEN_MAX_CHANNELS", "MAX_CHANNELS"],
      ["PG_LISTEN_MAX_CHANNEL_BYTES", "MAX_CHANNEL_BYTES"],
    ],
  },
  { ts: TASK_FORMAT_TS, rs: TASKS_RS, names: [["ALL_WEEKDAYS_MASK", "ALL_WEEKDAYS"]] },
  // 区切りが片側だけ変わると、派生プロファイルから元の ID (keyring の秘密の参照先) を引けなくなる。
  { ts: OPEN_DATABASE_TS, rs: PROFILE_STORE_RS, names: [["DB_VARIANT_SEP", "DB_VARIANT_SEP"]] },
  // Rust 側だけ変わると、ファイル変更後の再解析を促す判定 (isAnalysisStaleError) が効かなくなる。
  { ts: SCRIPT_RUN_TS, rs: SCRIPT_RS, names: [["FILE_CHANGED_MARKER", "FILE_CHANGED_MARKER"]] },
  {
    ts: BROADCAST_COMPARE_TS,
    rs: BROADCAST_DIFF_RS,
    names: [["MAX_BROADCAST_COMPARE_ROWS", "MAX_BROADCAST_COMPARE_ROWS"]],
  },
  { ts: LOCAL_QUERY_TS, rs: LOCAL_RS, names: [["MAX_LOCAL_TABLE_ROWS", "MAX_LOCAL_TABLE_ROWS"]] },
  { ts: CELL_EDIT_TS, rs: EXPORT_RS, names: [["FALLBACK_INSERT_TABLE", "DEFAULT_SQL_TABLE"]] },
  { ts: RESULT_HANDLE_TS, rs: RESULT_STORE_RS, names: [["RESULT_GONE_MARKER", "RESULT_GONE"]] },
  { ts: ROW_MERGE_TS, rs: ROW_MERGE_RS, names: [["ROW_MERGE_MAX_ROWS", "MAX_MERGE_ROWS"]] },
  { ts: SQLITE_ATTACH_TS, rs: SQLITE_RS, names: [["MAX_ATTACHED", "SQLITE_MAX_ATTACHED"]] },
  { ts: CLONE_ROWS_TS, rs: CLONE_ROWS_RS, names: [["CLONE_MAX_ROWS", "MAX_CLONE_ROWS"]] },
  {
    ts: SUBSET_TS,
    rs: SUBSET_RS,
    names: [
      ["SUBSET_DEFAULT_ROOT_LIMIT", "DEFAULT_ROOT_ROW_LIMIT"],
      ["SUBSET_MAX_ROOT_LIMIT", "MAX_ROOT_ROW_LIMIT"],
      ["SUBSET_DEFAULT_CHILD_LIMIT", "DEFAULT_CHILD_ROW_LIMIT"],
      ["SUBSET_MAX_CHILD_LIMIT", "MAX_CHILD_ROW_LIMIT"],
      ["SUBSET_MAX_CHILD_DEPTH", "MAX_CHILD_DEPTH"],
    ],
  },
  { ts: SUBSET_TS, rs: SANDBOX_RS, names: [["SUBSET_MAX_WHERE_LEN", "MAX_ROW_FILTER_LEN"]] },
  { ts: SUBSET_TS, rs: DIFF_RS, names: [["SUBSET_MAX_SANDBOX_ROOT_LIMIT", "MAX_DATA_ROWS"]] },
  {
    ts: TASK_TS,
    rs: TASKS_RS,
    names: [
      ["MAX_PAUSE_AFTER_FAILURES", "MAX_PAUSE_AFTER_FAILURES"],
      // フロントの入力上限は「リトライ間隔の上限」ではなく遅延の上限 (15 分) と揃える。
      ["MAX_RETRY_INTERVAL_SECS", "MAX_RETRY_DELAY_SECS"],
    ],
  },
  {
    ts: SETTINGS_TS,
    rs: TIMELAPSE_RS,
    names: [
      ["DEFAULT_TIMELAPSE_MAX_GENERATIONS", "DEFAULT_MAX_GENERATIONS"],
      ["MAX_TIMELAPSE_MAX_GENERATIONS", "MAX_MAX_GENERATIONS"],
    ],
  },
  {
    ts: SETTINGS_TS,
    rs: CONNECTION_RS,
    names: [
      ["DEFAULT_CONNECT_TIMEOUT_SECS", "DEFAULT_CONNECT_TIMEOUT_SECS"],
      ["MIN_CONNECT_TIMEOUT_SECS", "MIN_CONNECT_TIMEOUT_SECS"],
      ["MAX_CONNECT_TIMEOUT_SECS", "MAX_CONNECT_TIMEOUT_SECS"],
    ],
  },
  {
    ts: SANDBOX_TS,
    rs: SANDBOX_RS,
    names: [
      ["SANDBOX_SHADOW_PREFIX", "SHADOW_PREFIX"],
      ["SANDBOX_DEFAULT_ROW_LIMIT", "DEFAULT_ROW_LIMIT"],
      ["SANDBOX_MAX_ROW_LIMIT", "MAX_ROW_LIMIT"],
    ],
  },
  { ts: SCHEMA_DOC_TS, rs: AI_RS, names: [["SCHEMA_DOC_MAX_PROMPT_BYTES", "MAX_PROMPT_BYTES"]] },
  { ts: CONVERSATION_TS, rs: AI_RS, names: [["MAX_PROMPT_BYTES", "MAX_PROMPT_BYTES"]] },
  { ts: BACKUP_TS, rs: BACKUP_RS, names: [["MIN_BACKUP_PASSPHRASE_LENGTH", "MIN_PASSPHRASE_CHARS"]] },
  { ts: BLOB_TS, rs: BLOB_RS, names: [["MAX_BLOB_BYTES", "MAX_CELL_BLOB_BYTES"]] },
  {
    ts: MASKING_TS,
    rs: MASKING_RS,
    names: [
      ["DEFAULT_FIXED_VALUE", "DEFAULT_FIXED_VALUE"],
      ["MAX_FIXED_VALUE_CHARS", "MAX_FIXED_VALUE_CHARS"],
      ["MAX_KEEP_CHARS", "MAX_KEEP_CHARS"],
      ["DEFAULT_HASH_LENGTH", "DEFAULT_HASH_LENGTH"],
      ["MIN_HASH_LENGTH", "MIN_HASH_LENGTH"],
      ["MAX_HASH_LENGTH", "MAX_HASH_LENGTH"],
      ["DEFAULT_EMAIL_KEEP_START", "DEFAULT_EMAIL_KEEP_START"],
    ],
  },
];

/** 式 (数値リテラル・`_` 区切り・文字列・`+ - *` と括弧・`<<`) を評価する。評価できなければ投げる。 */
function evalConstExpr(raw: string): number | string {
  const expr = raw.replace(/\/\/.*$/gm, "").trim();
  const str = /^b?"((?:[^"\\]|\\.)*)"$/.exec(expr);
  if (str) return str[1];
  // 許可する文字を絞ってから評価する (ソースは自リポジトリのものだが、念のため)。
  const cleaned = expr
    .replace(/\b0b([01_]+)/g, (_, bits: string) => String(Number.parseInt(bits.replace(/_/g, ""), 2)))
    .replace(/(\d)_(?=\d)/g, "$1")
    .replace(/(?<=\d)(u8|u16|u32|u64|usize|i32|i64)\b/g, "");
  if (!/^[\d\s+\-*()<]+$/.test(cleaned)) throw new Error(`評価できない式: ${raw}`);
  const v = new Function(`return (${cleaned});`)();
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`数値にならない式: ${raw}`);
  return v;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** TS ソースから `const NAME[: T] = <式>;` を取り出して評価する。 */
function extractTsConst(text: string, name: string): number | string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:export\\s+)?const\\s+${escapeRe(name)}(?:\\s*:[^=\\n]+)?\\s*=\\s*([^;\\n]+);`,
  );
  const m = re.exec(text);
  if (!m) throw new Error(`TS に const ${name} が見つからない`);
  return evalConstExpr(m[1]);
}

/** Rust ソースから `[pub[(..)]] const NAME: T = <式>;` を取り出して評価する。 */
function extractRustConst(text: string, name: string): number | string {
  const re = new RegExp(
    `(?:^|\\n)\\s*(?:pub(?:\\([a-z]+\\))?\\s+)?const\\s+${escapeRe(name)}\\s*:\\s*[^=\\n]+=\\s*([^;\\n]+);`,
  );
  const m = re.exec(text);
  if (!m) throw new Error(`Rust に const ${name} が見つからない`);
  return evalConstExpr(m[1]);
}

describe("Rust ⇔ TS 定数パリティ (#2301): 抽出ヘルパ", () => {
  it("`_` 区切り・乗算・型サフィックス・文字列を評価できる", () => {
    expect(evalConstExpr("100_000")).toBe(100000);
    expect(evalConstExpr("15 * 60")).toBe(900);
    expect(evalConstExpr("64 * 1024 * 1024")).toBe(67108864);
    expect(evalConstExpr("1024 * 1024 // 1 GiB")).toBe(1048576);
    expect(evalConstExpr('"***"')).toBe("***");
    expect(evalConstExpr("5_000u64")).toBe(5000);
    expect(evalConstExpr("0b111_1111")).toBe(127);
  });

  it("定数の宣言形 (pub / pub(crate) / 型注釈の有無) を拾う", () => {
    expect(extractRustConst("pub(crate) const A: usize = 5000;", "A")).toBe(5000);
    expect(extractRustConst("    const B: u64 = 15 * 60;", "B")).toBe(900);
    expect(extractRustConst('pub const C: &str = "x_y";', "C")).toBe("x_y");
    expect(extractTsConst("export const D = 1_000;", "D")).toBe(1000);
    expect(extractTsConst("const E: number = 2 * 3;", "E")).toBe(6);
    expect(() => extractRustConst("const F: u8 = 1;", "G")).toThrow();
    expect(() => extractTsConst("const F = 1;", "G")).toThrow();
  });
});

describe("Rust ⇔ TS 定数パリティ (#2301): 対応表", () => {
  for (const { ts, rs, names } of PAIRS) {
    for (const [tsName, rsName] of names) {
      it(`${ts.name} の ${tsName} は ${rs.name} の ${rsName} と一致する`, () => {
        expect(extractTsConst(ts.text, tsName)).toBe(extractRustConst(rs.text, rsName));
      });
    }
  }
});

// 対応表に無い「バックエンドと揃える」定数の追加を検出する。コメントを grep し、マーカーのコメント行から
// 次の空行までに宣言された `const NAME` を集めて、各 NAME が対応表 (PAIRS) の TS 名か、定数単位の
// EXEMPT にあることを確かめる (すでに対応表にあるファイルへ後から足した定数も検出できる)。
// 判定は「連続するコメント行を 1 ブロック」にまとめた文字列に対して行う (定数名と「バックエンド」が別の
// 行にあっても検出するため)。
const COMMENT_MARKERS: RegExp[] = [
  /(?:バックエンド|Rust|backend)[\s\S]*?と(?:揃える|同じ値)/i,
  /mirroring the backend (?:clamp|limit|bounds)/i,
  // 「バックエンド / Rust / backend」と大文字の定数名 (`NAME`) を同じブロックで言及している。
  /(?:バックエンド|Rust|[Bb]ackend)[\s\S]*?`[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+`/,
  // `src-tauri/.../local.rs::NAME` 形式、「`....rs` の `NAME`」形式。
  /\.rs`?::[A-Z][A-Z0-9]*_[A-Z0-9_]+/,
  /\.rs` の `[A-Z][A-Z0-9]*_[A-Z0-9_]+`/,
];

function isMarkerComment(block: string): boolean {
  return COMMENT_MARKERS.some((re) => re.test(block));
}

/** 対応表の外にある定数 ("ファイルパス:定数名" → 理由)。固定の仕組みが別にあるものだけ。 */
const EXEMPT: Record<string, string> = {
  "components/subsetExtract.ts:SUBSET_DEFAULT_CHILD_DEPTH":
    "UI の既定 (1 段) は意図的に Rust の未指定時の既定 (clamp_child_depth の 0) と違う。上限 SUBSET_MAX_CHILD_DEPTH は対応表で固定",
  "components/TaskManager.tsx:DEFAULT_PAUSE_AFTER_FAILURES":
    "新規タスクの UI 既定値で、Rust には対応する既定の定数が無い (Rust の既定は 0 = 無効)。上限は対応表で固定",
  "settings.ts:MIN_TIMELAPSE_MAX_GENERATIONS":
    "Rust は timelapse::clamp_max_generations で clamp(1, ..) とリテラルで書いていて定数が無い",
  "components/pgListen.ts:PG_LISTEN_PREVIEW_CHARS":
    "一覧の表示用の省略幅で UI だけの値。Rust に対応する定数は無い",
  "components/sqliteAttach.ts:MAX_ATTACH_ALIAS_LENGTH":
    "Rust は is_valid_attach_alias 内のリテラル (64) で定数が無い。境界は sqliteAttachVectors.json で固定。上限数 MAX_ATTACHED は対応表で固定",
  "dangerousSql.ts:ALTER_DROP_NON_COLUMN":
    "集合の一致は共有ゴールデンベクタ dangerousSqlVectors.json (Rust は db/script_analysis.rs の alter_drop_kind) で固定する",
  "dangerousSql.ts:LOCKING_CLAUSES":
    "ロック句の語彙は共有ゴールデンベクタ autoLimitVectors.json (Rust は db/mod.rs の LOCKING_CLAUSES / has_locking_clause) で固定する",
  "dangerousSql.ts:LOCKING_TABLE_HINTS":
    "ロックを強めるテーブルヒント (UPDLOCK / HOLDLOCK 等の全 7 語) は共有ゴールデンベクタ readOnlySqlVectors.json (Rust は db/mod.rs の LOCKING_TABLE_HINTS) で固定する",
  "dangerousSql.ts:READ_ONLY_PREFIXES_ALL_DRIVERS":
    "読み取り専用判定の語彙は共有ゴールデンベクタ readOnlySqlVectors.json (Rust は db/mod.rs の is_read_only_sql_masked) で固定する",
  "taskFormat.ts:WORKDAYS_MASK": "Rust に対応する定数は無い (表示用の平日判定)。全曜日マスクは対応表で固定",
};

const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../__tests__/**", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** マーカーのコメントブロックの直後 (次の空行まで) に宣言された const 名を "ファイル:NAME" で集める。 */
function markedConsts(files: Record<string, string>): string[] {
  const out: string[] = [];
  const isComment = (l: string) => /^\s*(?:\/\/|\/\*|\*)/.test(l);
  for (const [path, text] of Object.entries(files)) {
    const file = path.replace(/^\.\.\//, "");
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!isComment(lines[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < lines.length && isComment(lines[end])) end++;
      if (isMarkerComment(lines.slice(i, end).join("\n"))) {
        for (let j = end; j < lines.length && lines[j].trim() !== ""; j++) {
          const m = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b/.exec(lines[j]);
          if (m) out.push(`${file}:${m[1]}`);
        }
      }
      i = end;
    }
  }
  return [...new Set(out)];
}

describe("Rust ⇔ TS 定数パリティ (#2301): コメントの網羅チェック", () => {
  const covered = new Set(PAIRS.flatMap((p) => p.names.map(([t]) => `${p.ts.name}:${t}`)));
  const marked = markedConsts(sources);

  it("検出ロジックが既知の定数を拾えている (空振り防止)", () => {
    expect(marked).toContain("components/subsetExtract.ts:SUBSET_MAX_ROOT_LIMIT");
    expect(marked).toContain("components/TaskManager.tsx:MAX_PAUSE_AFTER_FAILURES");
    expect(marked).toContain("settings.ts:MAX_TIMELAPSE_MAX_GENERATIONS");
    // 定数名とバックエンドが別行 / `.rs::NAME` 形式 / 英語の backend (#2412)。
    expect(marked).toContain("scriptRun.ts:FILE_CHANGED_MARKER");
    expect(marked).toContain("components/localQuery.ts:MAX_LOCAL_TABLE_ROWS");
    expect(marked).toContain("openDatabase.ts:DB_VARIANT_SEP");
    expect(marked).toContain("components/resultHandle.ts:RESULT_GONE_MARKER");
  });

  it("「バックエンドと揃える」コメント直下の定数は対応表か EXEMPT にある", () => {
    const missing = marked.filter((c) => !covered.has(c) && !(c in EXEMPT));
    expect(missing, `対応表 (PAIRS) に追加するか、EXEMPT に理由つきで追加: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("EXEMPT は実在の定数で、対応表と重複せず、理由がある", () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(marked, `${key} がマーカー直下に無い`).toContain(key);
      expect(covered.has(key), `${key} は対応表にもある`).toBe(false);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});

// 長さの数え方 (コードポイント / UTF-16) の境界。Rust は `chars().count()`、TS は `Array.from(s).length`。
describe("Rust ⇔ TS 定数パリティ (#2301): 長さの数え方", () => {
  it("絵文字 (サロゲートペア) を 1 文字と数える。UTF-16 の .length とは違う", () => {
    const emoji = "\u{1F600}";
    expect(emoji.length).toBe(2);
    expect(Array.from(emoji).length).toBe(1);
  });

  it("長さ判定をする TS 側は `.length` でなくコードポイントで数える", () => {
    // subsetExtract の上限判定は `.length` を直接使わない。
    expect(subsetExtractTs).not.toMatch(/\b(?:condition|term|tuple)\.length\b/);
    expect(subsetExtractTs).toMatch(/codePointLength\(condition\)\s*>\s*SUBSET_MAX_WHERE_LEN/);
  });
});

// 逆方向 (#2446): Rust 側のコメントが「フロント」や `src/...ts` に言及している定数も、対応表に載せ忘れたら fail
// させる。TS 側のコメントを起点にする上の検査は、Rust だけにマーカーがある定数 (profiles/cleanup.rs の
// LOCAL_PROFILE_ID など) を拾えない。
const rustSources = import.meta.glob("../../src-tauri/src/**/*.rs", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Rust 側の除外 ("src-tauri/src からの相対パス:定数名" → 理由)。TS に写しを持たないものだけ。 */
const RUST_EXEMPT: Record<string, string> = {
  "commands/ai.rs:MAX_HISTORY_MESSAGES":
    "Rust は組み立て不具合を弾く緩い上限 (20 件)。フロントは直近 10 件に絞るだけで、等値は不要",
  "commands/bulk_write.rs:EXTRA_STATEMENT_ROWS":
    "フロントが 1 文 = 1 行で生成する規約で、TS に対応する定数は無い",
  "commands/diff.rs:MARKS":
    "テスト内の定数。フロントのソースに同じ文字列があることをそのテスト自身が検証する",
  "commands/file.rs:MAX_TEXT_FILE_BYTES": "Rust 側のガードのみ。TS に対応する定数は無い",
  "commands/file.rs:MAX_WRITE_FILE_BYTES": "Rust 側のガードのみ。TS に対応する定数は無い",
  "commands/query.rs:LOOKUP_DEFAULT_ROWS":
    "フロントは row_cap を渡す側で、Rust の上限以下であればよい (等値は不要)",
  "commands/query.rs:LOOKUP_MAX_ROWS":
    "フロントは row_cap を渡す側で、Rust の上限以下であればよい (等値は不要)",
  "db/profile.rs:NOTE_STATS_UNAVAILABLE":
    "TS は columnProfile.ts の NOTE_KEYS のキーとして持つ。値の集合は「コード集合」のテストで固定する",
  "db/profile.rs:NOTE_TOP_VALUES_UNAVAILABLE":
    "TS は columnProfile.ts の NOTE_KEYS のキーとして持つ。値の集合は「コード集合」のテストで固定する",
  "db/profile.rs:NOTE_HISTOGRAM_UNAVAILABLE":
    "TS は columnProfile.ts の NOTE_KEYS のキーとして持つ。値の集合は「コード集合」のテストで固定する",
  "db/profile.rs:NOTE_APPROX_UNSUPPORTED":
    "TS は columnProfile.ts の NOTE_KEYS のキーとして持つ。値の集合は「コード集合」のテストで固定する",
  "db/profile.rs:NOTE_APPROX_NO_STATS":
    "TS は columnProfile.ts の NOTE_KEYS のキーとして持つ。値の集合は「コード集合」のテストで固定する",
  "db/types.rs:JS_MAX_SAFE_INTEGER": "TS 側は言語組み込みの Number.MAX_SAFE_INTEGER を使う",
  "profiles/secrets.rs:ALL_KINDS":
    "kind 文字列の集合は enumParity.test.ts が ProfileSecretKind と commands::profiles::SecretKind で固定する",
  "snippets/transfer.rs:MAX_IMPORT_BYTES": "read_text_file の上限に揃えた Rust 側のガードで、TS に定数は無い",
  "ssm/keepalive.rs:KEEPALIVE_PING_TIMEOUT": "Rust 側の ping のタイムアウトで、TS に対応する定数は無い",
};

/** Rust ソースの「フロントや TS ファイルに言及するコメント」直下に連続して宣言された const を "パス:NAME" で集める。 */
function rustMarkedConsts(files: Record<string, string>): string[] {
  const out: string[] = [];
  const isComment = (l: string) => /^\s*\/\//.test(l);
  const marker = /フロント|\bsrc\/[\w/.-]+\.tsx?\b|\b[\w-]+\.tsx?\b/;
  for (const [path, text] of Object.entries(files)) {
    const file = path.replace(/^.*\/src-tauri\/src\//, "");
    const lines = text.split("\n");
    let i = 0;
    while (i < lines.length) {
      if (!isComment(lines[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < lines.length && isComment(lines[end])) end++;
      if (marker.test(lines.slice(i, end).join("\n"))) {
        // コメント直下から、const が途切れるまで (間にコメントを挟むと別のブロック)。
        for (let j = end; j < lines.length; j++) {
          const m = /^\s*(?:pub(?:\([a-z]+\))?\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:/.exec(lines[j]);
          if (!m) break;
          out.push(`${file}:${m[1]}`);
        }
      }
      i = end;
    }
  }
  return [...new Set(out)];
}

describe("Rust ⇔ TS 定数パリティ (#2446): Rust 側コメントの網羅チェック", () => {
  const coveredRs = new Set(PAIRS.flatMap((p) => p.names.map(([, r]) => `${p.rs.name}:${r}`)));
  const marked = rustMarkedConsts(rustSources);

  it("検出ロジックが既知の定数を拾えている (空振り防止)", () => {
    expect(marked).toContain("profiles/cleanup.rs:LOCAL_PROFILE_ID");
    expect(marked).toContain("profiles/cleanup.rs:SANDBOX_ID_PREFIX");
    expect(marked).toContain("db/profile.rs:NOTE_APPROX_NO_STATS");
    expect(marked).toContain("db/deadlock.rs:UNAVAILABLE_NEEDS_PROCESS");
    expect(marked).toContain("commands/script.rs:FILE_CHANGED_MARKER");
  });

  it("フロントに言及する Rust 定数は対応表か RUST_EXEMPT にある", () => {
    const missing = marked.filter((c) => !coveredRs.has(c) && !(c in RUST_EXEMPT));
    expect(
      missing,
      `対応表 (PAIRS) に追加するか、RUST_EXEMPT に理由つきで追加: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("RUST_EXEMPT は実在の定数で、対応表と重複せず、理由がある", () => {
    for (const [key, reason] of Object.entries(RUST_EXEMPT)) {
      expect(marked, `${key} がマーカー直下に無い`).toContain(key);
      expect(coveredRs.has(key), `${key} は対応表にもある`).toBe(false);
      expect(reason.length).toBeGreaterThan(0);
    }
  });

  it("メタテストが Rust だけにあるマーカーの載せ忘れを検出する", () => {
    const fake = {
      "../../src-tauri/src/x/new.rs": "/// フロントと揃える。\npub const NEW_LIMIT: usize = 3;\n",
    };
    expect(rustMarkedConsts(fake)).toEqual(["x/new.rs:NEW_LIMIT"]);
    expect(coveredRs.has("x/new.rs:NEW_LIMIT")).toBe(false);
  });
});

describe("Rust ⇔ TS 定数パリティ (#2446): コード集合", () => {
  /** Rust の `const NAME: &str = "value";` のうち、名前が prefix で始まるものの値を集める。 */
  const rustCodes = (text: string, prefix: string): string[] =>
    [...text.matchAll(new RegExp(`const (${prefix}[A-Z0-9_]*)\\s*:\\s*&str\\s*=\\s*"([^"]*)"`, "g"))].map(
      (m) => m[2],
    );

  it("縮退理由コード: Rust の NOTE_* の値は TS の写像表のキー + 直接比較する 1 件と一致する", () => {
    const rs = rustCodes(PROFILE_RS.text, "NOTE_").sort();
    const body = /const NOTE_KEYS = \{([\s\S]*?)\} as const;/.exec(COLUMN_PROFILE_TS.text)?.[1] ?? "";
    const keys = [...body.matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);
    const direct = String(extractTsConst(COLUMN_PROFILE_TS.text, "NOTE_OVERVIEW_APPROX_NO_STATS"));
    expect(keys.length).toBeGreaterThan(0);
    expect(rs).toEqual([...keys, direct].sort());
  });

  it("解析不能の理由コード: Rust の UNAVAILABLE_* の値は deadlock.ts の定数と一致する", () => {
    const rs = rustCodes(DEADLOCK_RS.text, "UNAVAILABLE_").sort();
    const ts = ["UNAVAILABLE_NEEDS_PROCESS", "UNAVAILABLE_NO_REPORT", "UNAVAILABLE_NO_DETAIL"]
      .map((n) => String(extractTsConst(DEADLOCK_TS.text, n)))
      .sort();
    expect(rs).toEqual(ts);
  });
});
