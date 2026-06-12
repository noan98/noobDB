import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { ReactElement } from "react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import { DangerousQueryDialog } from "../../components/DangerousQueryDialog";
import type { Column, QueryResult } from "../../api/tauri";
import type { DangerFinding } from "../../dangerousSql";
import type { Theme } from "../../settings";

// Phase 2 — ビジュアル回帰テスト。
//
// Phase 1 の主要画面のうち見た目の退行検出価値が高いものに絞り、ライト/ダークの
// 両テーマでスクリーンショットを撮ってベースライン PNG と比較する。
// テーマ追従 (色・余白・コントラスト) の退行を捕まえる。
//
// 決定性の確保 (`setup.browser.ts` でアニメーション無効化・ロケール固定済み) に
// 加え、ここでは:
//   - 固定サイズのラッパ (`visual-root`) に収め、要素単位のスクリーンショットを撮る
//     ことでビューポート差の影響を受けないようにする。
//   - データを props で固定 (時刻・ランダム ID を排除)。
//
// ベースライン PNG は CI と同一環境 (Linux/Chromium) で生成してリポジトリにコミット
// する運用 (詳細は CLAUDE.md / .github/workflows/visual-baseline.yml)。ローカル
// (macOS/Windows) では描画差で false positive になりうるため、ローカルでの比較は
// 行わず CI に委ねる。意図的な変更時は workflow_dispatch の更新ワークフローで
// ベースラインを再生成・コミットする。

/** テーマ属性を `<html data-theme>` に適用する (theme.ts の dark 条件に合わせる)。 */
function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/**
 * 固定幅のラッパ (`visual-root`) に収めて描画する。Portal を使わない通常の
 * コンポーネント向け。スクリーンショット対象の locator を返す。
 */
async function renderVisual(ui: ReactElement, theme: Theme) {
  applyTheme(theme);
  await renderInBrowser(
    <div
      data-testid="visual-root"
      style={{ width: "640px", padding: "16px", background: "var(--app-bg, #fff)" }}
    >
      {ui}
    </div>,
  );
  return page.getByTestId("visual-root");
}

const RESULT: QueryResult = {
  columns: [
    { name: "name", type_name: "VARCHAR" },
    { name: "qty", type_name: "INT" },
  ] satisfies Column[],
  rows: [
    ["banana", 2],
    ["apple", 5],
    ["cherry", 9],
  ],
  rows_affected: 0,
  elapsed_ms: 3,
};

const FINDINGS: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];

// ビジュアル回帰は**コミット済みベースライン PNG との比較**であり、ベースラインが
// 無い環境では `toMatchScreenshot` が (skip ではなく) 失敗する。ベースラインは
// 比較を行う CI と同一環境 (Linux/Chromium) で生成・コミットする運用のため、
// 通常の CI / ローカルでは既定で**スキップ**し、`VITE_RUN_VISUAL=1` のときだけ実行
// する。ベースライン生成 (`pnpm test:browser:update` →
// .github/workflows/visual-baseline.yml) はこのフラグを立てて走らせる。
// ベースラインがリポジトリに揃ったら、CI の frontend-visual ジョブでも
// `VITE_RUN_VISUAL=1` を立てて比較を必須化できる。
const RUN_VISUAL = import.meta.env.VITE_RUN_VISUAL === "1";

describe.runIf(RUN_VISUAL)("ビジュアル回帰 (実ブラウザ)", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`結果グリッド (${theme})`, async () => {
      const root = await renderVisual(<ResultGrid result={RESULT} />, theme);
      await expect(root).toMatchScreenshot(`result-grid-${theme}`);
    });

    it(`危険クエリ確認ダイアログ (${theme})`, async () => {
      // Modal は Chakra の Dialog + Portal で document.body 直下へ描画されるため、
      // visual-root には収まらない。ダイアログ本体 (role="dialog") を直接撮る。
      applyTheme(theme);
      await renderInBrowser(
        <DangerousQueryDialog
          findings={FINDINGS}
          isProduction
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      );
      const dialog = page.getByRole("dialog");
      await expect(dialog).toMatchScreenshot(`dangerous-dialog-${theme}`);
    });
  }
});
