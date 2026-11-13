import { describe, expect, it } from "vitest";
import aiRs from "../../src-tauri/src/commands/ai.rs?raw";
import cellBlobRs from "../../src-tauri/src/commands/cell_blob.rs?raw";
import connectionRs from "../../src-tauri/src/commands/connection.rs?raw";
import diffRs from "../../src-tauri/src/commands/diff.rs?raw";
import cloneRowsRs from "../../src-tauri/src/db/clone_rows.rs?raw";
import maskingRs from "../../src-tauri/src/db/masking.rs?raw";
import sandboxRs from "../../src-tauri/src/db/sandbox.rs?raw";
import subsetRs from "../../src-tauri/src/db/subset.rs?raw";
import backupRs from "../../src-tauri/src/profiles/backup.rs?raw";
import tasksRs from "../../src-tauri/src/tasks/mod.rs?raw";
import timelapseRs from "../../src-tauri/src/timelapse/mod.rs?raw";
import conversationTs from "../ai/conversation.ts?raw";
import schemaDocTs from "../ai/schemaDoc.ts?raw";
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
const CLONE_ROWS_TS = src("components/cloneRows.ts", cloneRowsTs);
const CLONE_ROWS_RS = src("db/clone_rows.rs", cloneRowsRs);

/** 対応表: [TS の定数名, Rust の定数名]。名前が違うものもあるので明示する。 */
const PAIRS: { ts: Src; rs: Src; names: [string, string][] }[] = [
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
  const cleaned = expr.replace(/(\d)_(?=\d)/g, "$1").replace(/(?<=\d)(u8|u16|u32|u64|usize|i32|i64)\b/g, "");
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
const COMMENT_MARKER =
  /(?:バックエンド|Rust)[^\n]*と(?:揃える|同じ値)|mirroring the backend (?:clamp|limit|bounds)/i;

/** 対応表の外にある定数 ("ファイルパス:定数名" → 理由)。固定の仕組みが別にあるものだけ。 */
const EXEMPT: Record<string, string> = {
  "components/subsetExtract.ts:SUBSET_DEFAULT_CHILD_DEPTH":
    "UI の既定 (1 段) は意図的に Rust の未指定時の既定 (clamp_child_depth の 0) と違う。上限 SUBSET_MAX_CHILD_DEPTH は対応表で固定",
  "components/TaskManager.tsx:DEFAULT_PAUSE_AFTER_FAILURES":
    "新規タスクの UI 既定値で、Rust には対応する既定の定数が無い (Rust の既定は 0 = 無効)。上限は対応表で固定",
  "settings.ts:MIN_TIMELAPSE_MAX_GENERATIONS":
    "Rust は timelapse::clamp_max_generations で clamp(1, ..) とリテラルで書いていて定数が無い",
};

const sources = import.meta.glob(["../**/*.ts", "../**/*.tsx", "!../__tests__/**", "!../**/*.test.*"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** マーカーのコメント行から次の空行までに宣言された const 名を "ファイル:NAME" で集める。 */
function markedConsts(files: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    const file = path.replace(/^\.\.\//, "");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!(/^\s*(?:\/\/|\/?\*)/.test(line) && COMMENT_MARKER.test(line))) return;
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ""; j++) {
        const m = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\b/.exec(lines[j]);
        if (m) out.push(`${file}:${m[1]}`);
      }
    });
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
