// Biome の lint を実行し、error と「警告の件数上限」で CI を落とす。
// Biome には ESLint の `--max-warnings` 相当が無いため、JSON レポートを読んで自前で判定する。
//
// 警告 (useExhaustiveDependencies) は既存の依存配列漏れが多く段階導入中。違反フックの数を
// WARNING_BUDGET で固定し、新規の違反は CI で落とす。直して件数が減ったらこの値も下げる。
import { spawnSync } from "node:child_process";

const WARNING_BUDGET = 74;

const result = spawnSync(
  "pnpm",
  ["exec", "biome", "lint", "--reporter=json", "--max-diagnostics=none", "src"],
  { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: process.platform === "win32" },
);

let report;
try {
  // 先頭に注意書き等が混ざっても JSON 本体 (最初の `{`) から読む。
  report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
} catch {
  console.error("Biome の出力を JSON として読めませんでした。");
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(2);
}

const diagnostics = report.diagnostics ?? [];
const errors = diagnostics.filter((d) => d.severity === "error" || d.severity === "fatal");
// useExhaustiveDependencies は不足している依存 1 つにつき 1 件を出すため、同じフックを
// 一括りにして「違反フックの数」で数える (依存を 1 つ直しても件数が揺れないように)。
const warnings = [
  ...new Map(
    diagnostics
      .filter((d) => d.severity === "warning")
      .map((d) => [`${d.category}@${d.location?.path}:${d.location?.start?.line}`, d]),
  ).values(),
];

const where = (d) => {
  const loc = d.location ?? {};
  return `${loc.path ?? "(unknown)"}:${loc.start?.line ?? "?"}`;
};

for (const d of errors) {
  console.error(`error   ${where(d)}  ${d.category}  ${d.message}`);
}
console.log(`Biome: ${errors.length} errors / ${warnings.length} warnings (warning budget ${WARNING_BUDGET})`);

if (errors.length > 0) process.exit(1);
if (warnings.length > WARNING_BUDGET) {
  console.error(
    `警告が上限 ${WARNING_BUDGET} 件を超えました (${warnings.length} 件)。新しい違反を直してください。`,
  );
  for (const d of warnings) console.error(`warning ${where(d)}  ${d.category}`);
  process.exit(1);
}
if (warnings.length < WARNING_BUDGET) {
  console.log(`警告が減りました。scripts/biome-lint.mjs の WARNING_BUDGET を ${warnings.length} に下げてください。`);
}
