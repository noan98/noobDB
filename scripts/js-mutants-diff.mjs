// js-mutants-diff.yml (#2021) が使う、PR 差分から Stryker の --mutate 指定を作る純関数 + CLI。
//
// 対象ファイルの単一ソースは stryker.conf.json の mutate。ここに足すのは
// EXTRA_FILES (mutants-diff.yml の EXTRA_FILES と同じ位置付け = 手動 js-mutants の
// 対象には入れず、PR 差分ジョブだけで足す安全網ファイル) だけで、関数名やファイルを
// ワークフロー側に二重管理しない。
//
// 出力は `path:開始行-終了行` (Stryker の mutate 範囲構文) を 1 行 1 件。追加・変更された
// 行だけを変異させるので、実行時間は差分の大きさに比例する。
//
// 使い方: node scripts/js-mutants-diff.mjs <diff ファイル>
//         (git diff -U0 origin/main...HEAD の出力。標準出力に範囲、件数は終了コードに影響しない)
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// stryker.conf.json の mutate に無いが、PR 差分では変異させる安全網。
// 危険検出前のコメント/文字列マスク (二側ゴールデン maskVectors.json)。
// vitest.mutants.config.ts の include には既に入っている。
export const EXTRA_FILES = ["src/maskLiteralsIdentifiers.ts"];

/** `git diff -U0` の出力から、ファイルごとの追加/変更行範囲 (1 始まり、両端含む) を取り出す。 */
export function parseDiffRanges(diffText) {
  const out = new Map();
  let file = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ ")) {
      // "+++ b/path" か "+++ /dev/null" (削除)。
      const p = line.slice(4).trim();
      file = p.startsWith("b/") ? p.slice(2) : null;
      continue;
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && file) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      // count 0 = 純粋な削除。変異させる行が無い。
      if (count === 0) continue;
      const list = out.get(file) ?? [];
      list.push([start, start + count - 1]);
      out.set(file, list);
    }
  }
  return out;
}

/** 対象ファイル (mutate + extra) と交差する範囲だけを `path:a-b` に直す。 */
export function buildMutateSpecs(ranges, mutate, extra = EXTRA_FILES) {
  const targets = new Set([...mutate, ...extra]);
  const specs = [];
  for (const [file, list] of [...ranges].sort(([a], [b]) => a.localeCompare(b))) {
    if (!targets.has(file)) continue;
    for (const [a, b] of list) specs.push(`${file}:${a}-${b}`);
  }
  return specs;
}

function main() {
  const diffPath = process.argv[2];
  if (!diffPath) {
    console.error("usage: js-mutants-diff.mjs <diff file>");
    process.exit(2);
  }
  const conf = JSON.parse(readFileSync("stryker.conf.json", "utf8"));
  const specs = buildMutateSpecs(parseDiffRanges(readFileSync(diffPath, "utf8")), conf.mutate);
  process.stdout.write(specs.map((s) => `${s}\n`).join(""));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
