// ブラウザテストの「揺らぎ (flake)」可視化用 Vitest カスタムレポーター (#1396)。
//
// `vitest.browser.config.ts` は描画 / 操作系テストに限って `retry: 1` を設定している。
// retry で通ったテストは緑のままで気付けないため、ここで「再試行を要して最終的に
// 合格したテスト」を集め、(1) GitHub Actions の Job Summary (`$GITHUB_STEP_SUMMARY`) に
// 表を追記し、(2) `::warning::` アノテーションを出す。fail はさせない (可視化のみ。
// バンドルサイズ #443 / 所要時間 #565 と同じ漸進方針)。揺らぎが常態化したテストは
// この一覧を見て原因を直す (retry を増やして隠さない)。
//
// Vitest の JSON reporter は retryCount を出力しないため、`TestCase#diagnostic()` を
// 直接読むカスタムレポーターにしている。判定・整形は純関数にしてユニットテスト
// (`flaky-reporter.test.mjs`) で固定する。
import { appendFileSync } from "node:fs";

/**
 * 再試行を要して最終的に合格したテストだけを抜き出す。
 * @param {Array<{ name: string, file: string, state: string, retryCount: number }>} results
 */
export function pickFlaky(results) {
  return results.filter((r) => r.state === "passed" && r.retryCount > 0);
}

/** Markdown テーブルのセル用にエスケープする (`|` と改行)。 */
function cell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ");
}

/**
 * Job Summary 用の Markdown。揺らぎが無ければ空文字 (何も書かない)。
 * @param {ReturnType<typeof pickFlaky>} flaky
 */
export function renderSummary(flaky) {
  if (flaky.length === 0) return "";
  const rows = flaky
    .map((f) => `| ${cell(f.file)} | ${cell(f.name)} | ${f.retryCount} |`)
    .join("\n");
  return [
    "### ブラウザテストの揺らぎ (retry で合格したテスト)",
    "",
    `${flaky.length} 件が再試行を要しました。緑でも非決定的な落ち方をしている可能性があります。`,
    "",
    "| ファイル | テスト | 再試行回数 |",
    "| --- | --- | --- |",
    rows,
    "",
  ].join("\n");
}

/** `::warning::` アノテーション (改行・`%` は GitHub のコマンド構文に従いエスケープ)。 */
export function renderAnnotation(f) {
  const msg = `flaky: ${f.name} (retry x${f.retryCount})`
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::warning file=${f.file.replaceAll(",", "%2C")}::${msg}`;
}

export default class FlakyReporter {
  results = [];

  onTestCaseResult(testCase) {
    const diag = testCase.diagnostic();
    this.results.push({
      name: testCase.fullName,
      file: testCase.module.relativeModuleId ?? testCase.module.moduleId,
      state: testCase.result().state,
      retryCount: diag?.retryCount ?? 0,
    });
  }

  onTestRunEnd() {
    const flaky = pickFlaky(this.results);
    if (flaky.length === 0) return;
    for (const f of flaky) console.log(renderAnnotation(f));
    const path = process.env.GITHUB_STEP_SUMMARY;
    if (path) {
      try {
        appendFileSync(path, `${renderSummary(flaky)}\n`);
      } catch (e) {
        // 可視化の失敗でテスト結果を変えない。
        console.warn(`flaky summary を書けませんでした: ${e}`);
      }
    }
  }
}
