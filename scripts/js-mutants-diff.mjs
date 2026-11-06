// js-mutants-diff.yml (#2021) が使う、PR 差分から Stryker の --mutate 指定を作る純関数 + CLI。
//
// 対象ファイルの単一ソースは stryker.conf.json の mutate。ワークフロー側に二重管理しない。
//
// 2 つのモードがある (Summary に明示する)。
// - 差分行のみ (lines): 対象ソースの追加・変更行だけを `path:開始行-終了行` で変異させる。
// - ファイル全体 (files): 「テストを弱める PR」の検出用。vitest.mutants.config.ts の include に
//   入っているテストや共有ゴールデン (fixtures/*.json) が変わったら、対応するソース全体を変異させる
//   (対応が分からなければ conf.mutate 全件)。stryker.conf.json / vitest.mutants.config.ts の変更も
//   全件。既存の生存変異も出てくる点に注意。
//
// 限界: `git diff -U0` の行範囲で絞るため、複数行にまたがる式の途中行だけを変えると、
// 式の他の行にある変異が範囲から漏れる (全体モードか js-mutants.yml の手動実行で補う)。
//
// 使い方: node scripts/js-mutants-diff.mjs <diff ファイル> <specs 出力> <summary 出力>
//         (diff は git diff -U0 origin/main...HEAD の出力)
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CELL = "src/components/cellEdit.ts";
const DANGER = "src/dangerousSql.ts";
const SCRIPT = "src/sqlScript.ts";
const CHUNKED = "src/components/chunkedDml.ts";
const PREFLIGHT = "src/components/preflight.ts";

// テスト / 共有ゴールデン → 検証対象のソース (import とゴールデン参照から作った対応表。推移的な
// import も含む。js-mutants-diff.test.mjs が import の推移閉包と照合する)。
// vitest.mutants.config.ts の include にあるのにここに無いテストは、対応が分からないので
// conf.mutate 全件にフォールバックする (js-mutants-diff.test.mjs が include との整合を検査)。
const T = "src/__tests__/";
const F = "src/__tests__/fixtures/";
export const TEST_TO_SOURCES = {
  [`${T}blobIo.test.ts`]: [CELL],
  [`${T}bulkEdit.test.ts`]: [CELL],
  [`${T}cellEdit.test.ts`]: [CELL],
  [`${T}columnReplace.test.ts`]: [CELL],
  [`${T}editApplyState.test.ts`]: [CELL],
  [`${T}pasteEdit.test.ts`]: [CELL],
  [`${T}quickSetValues.test.ts`]: [CELL],
  [`${T}rowInspectorEdit.test.ts`]: [CELL],
  [`${T}streamStats.test.ts`]: [CELL],
  [`${T}chunkedDmlGolden.test.ts`]: [CHUNKED],
  [`${T}dangerousSql.test.ts`]: [DANGER],
  [`${T}dangerousSqlGolden.test.ts`]: [DANGER],
  [`${T}maskGolden.test.ts`]: [DANGER],
  [`${T}maskLiteralsIdentifiers.test.ts`]: [DANGER],
  [`${T}readOnlyGolden.test.ts`]: [DANGER],
  [`${T}relatedRows.test.ts`]: [DANGER, CELL],
  [`${T}schemaMutatingGolden.test.ts`]: [DANGER],
  [`${T}valuePicker.test.ts`]: [DANGER, CELL],
  [`${T}preflight.test.ts`]: [PREFLIGHT, DANGER],
  [`${T}scriptSplitGolden.test.ts`]: [SCRIPT, DANGER],
  [`${T}sqlScript.test.ts`]: [SCRIPT, DANGER],
  [`${T}statementSplitGolden.test.ts`]: [SCRIPT, DANGER],
};
export const FIXTURE_TO_SOURCES = {
  [`${F}chunkedDmlVectors.json`]: [CHUNKED],
  [`${F}dangerousSqlVectors.json`]: [DANGER],
  [`${F}maskVectors.json`]: [DANGER],
  [`${F}readOnlySqlVectors.json`]: [DANGER],
  [`${F}schemaMutatingVectors.json`]: [DANGER],
  [`${F}scriptSplitVectors.json`]: [SCRIPT, DANGER],
  [`${F}statementSplitVectors.json`]: [SCRIPT, DANGER],
};
export const CONFIG_FILES = ["stryker.conf.json", "vitest.mutants.config.ts"];

/** vitest.mutants.config.ts の include に列挙されたテストを取り出す。 */
export function parseVitestInclude(configText) {
  return [...configText.matchAll(/"(src\/__tests__\/[^"]+\.test\.ts)"/g)].map((m) => m[1]);
}

/**
 * `git diff -U0` の出力から、ファイルごとの追加/変更行範囲 (1 始まり、両端含む) を取り出す。
 * 純削除だけのファイルも空配列で載る (テスト削除の検出用)。`---` / `+++` は
 * `diff --git` 直後のヘッダ部でだけ解釈し、内容が `++ ` で始まる追加行と混同しない。
 */
export function parseDiffRanges(diffText) {
  const out = new Map();
  let file = null;
  let oldFile = null;
  let inHeader = false;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHeader = true;
      file = null;
      oldFile = null;
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- ")) {
        const p = line.slice(4).trim();
        oldFile = p.startsWith("a/") ? p.slice(2) : null;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        // 削除されたファイルは旧パスで記録する (テスト削除も「弱める」変更)。
        file = p.startsWith("b/") ? p.slice(2) : oldFile;
        if (file && !out.has(file)) out.set(file, []);
        continue;
      }
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      inHeader = false;
      if (!file) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      // count 0 = 純粋な削除。変異させる行が無い。
      if (count === 0) continue;
      out.get(file).push([start, start + count - 1]);
    }
  }
  return out;
}

/**
 * 差分から変異対象を決める。
 * @returns {{specs: string[], mode: "none"|"lines"|"files"|"mixed", wholeFiles: string[], lineFiles: string[]}}
 */
export function planMutation(ranges, mutate, includeTests) {
  const targets = new Set(mutate);
  const whole = new Set();
  const includeSet = new Set(includeTests);
  const addAll = () => {
    for (const f of mutate) whole.add(f);
  };
  for (const file of ranges.keys()) {
    if (CONFIG_FILES.includes(file)) {
      addAll();
    } else if (includeSet.has(file) || file in TEST_TO_SOURCES) {
      // include に入っているが対応表に無いテストは、対応が分からないので全件。
      const srcs = TEST_TO_SOURCES[file];
      if (srcs) for (const s of srcs) whole.add(s);
      else addAll();
    } else if (file in FIXTURE_TO_SOURCES) {
      for (const s of FIXTURE_TO_SOURCES[file]) whole.add(s);
    }
  }
  const wholeFiles = [...whole].filter((f) => targets.has(f)).sort();
  const specs = [...wholeFiles];
  const lineFiles = [];
  for (const [file, list] of [...ranges].sort(([a], [b]) => a.localeCompare(b))) {
    if (!targets.has(file) || whole.has(file) || list.length === 0) continue;
    lineFiles.push(file);
    for (const [a, b] of list) specs.push(`${file}:${a}-${b}`);
  }
  const mode =
    wholeFiles.length && lineFiles.length
      ? "mixed"
      : wholeFiles.length
        ? "files"
        : lineFiles.length
          ? "lines"
          : "none";
  return { specs, mode, wholeFiles, lineFiles };
}

function main() {
  const [diffPath, specsOut, summaryOut] = process.argv.slice(2);
  if (!diffPath || !specsOut || !summaryOut) {
    console.error("usage: js-mutants-diff.mjs <diff file> <specs out> <summary out>");
    process.exit(2);
  }
  const conf = JSON.parse(readFileSync("stryker.conf.json", "utf8"));
  const include = parseVitestInclude(readFileSync("vitest.mutants.config.ts", "utf8"));
  const plan = planMutation(parseDiffRanges(readFileSync(diffPath, "utf8")), conf.mutate, include);
  // Stryker 10 の --mutate は値をカンマで分割して上書きするため、1 引数にまとめて渡す。
  writeFileSync(specsOut, plan.specs.length ? `${plan.specs.join(",")}\n` : "");
  const label = {
    none: "対象なし",
    lines: "差分行のみ",
    files: "ファイル全体 (テスト / ゴールデン / 設定の変更。既存の生存変異も出ます)",
    mixed: "差分行 + ファイル全体 (全体側は既存の生存変異も出ます)",
  }[plan.mode];
  writeFileSync(
    summaryOut,
    `${JSON.stringify({ count: plan.specs.length, mode: plan.mode, label })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
