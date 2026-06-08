// フロントエンドのバンドルサイズ計測スクリプト (#443)。
//
// `pnpm run build` 後の `dist/` を走査し、各 JS/CSS アセットの生サイズと gzip 後
// サイズを集計して Markdown テーブルを出力する。CI ではこの出力を Job Summary
// (`$GITHUB_STEP_SUMMARY`) に書き込み、PR ごとにバンドルサイズを可視化する。
//
// 方針はカバレッジ可視化 (#290) と同じく「当面は閾値による fail を設けず可視化
// のみ」。size-limit / visualizer のような追加ツールを増やさず、Node 標準の
// zlib だけで完結させて依存とメンテコストを抑える。肥大化が常態化したら閾値
// (環境変数 BUNDLE_SIZE_LIMIT_KB など) による fail を後段で検討する。
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = "dist";

/** dist/ 配下の全ファイルパスを再帰的に集める。 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** バイト数を読みやすい単位 (KB) に整形する。 */
function kb(bytes) {
  return (bytes / 1024).toFixed(1);
}

async function main() {
  let distExists = true;
  try {
    await stat(DIST);
  } catch {
    distExists = false;
  }
  if (!distExists) {
    console.error(`バンドルサイズ計測: '${DIST}/' が見つかりません。先に pnpm run build を実行してください。`);
    process.exit(1);
  }

  const all = await walk(DIST);
  // 計測対象は JS / CSS のみ (画像やフォントは対象外)。
  const assets = all.filter((f) => /\.(js|css)$/.test(f));

  const rows = [];
  let totalRaw = 0;
  let totalGzip = 0;
  for (const file of assets) {
    const buf = await readFile(file);
    const raw = buf.byteLength;
    const gzip = gzipSync(buf).byteLength;
    totalRaw += raw;
    totalGzip += gzip;
    rows.push({ name: relative(DIST, file), raw, gzip });
  }

  // gzip サイズの大きい順に並べる (肥大化の主因を上に出す)。
  rows.sort((a, b) => b.gzip - a.gzip);

  const lines = [];
  lines.push("### フロントエンドバンドルサイズ");
  lines.push("");
  lines.push("| アセット | 生サイズ | gzip |");
  lines.push("| --- | ---: | ---: |");
  for (const r of rows) {
    lines.push(`| \`${r.name}\` | ${kb(r.raw)} KB | ${kb(r.gzip)} KB |`);
  }
  lines.push(`| **合計 (JS+CSS)** | **${kb(totalRaw)} KB** | **${kb(totalGzip)} KB** |`);
  lines.push("");

  const report = lines.join("\n");
  console.log(report);

  // CI では Job Summary に追記して PR ごとに可視化する。
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(summaryPath, report + "\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
