import { beforeEach, describe, expect, it, vi } from "vitest";
import axe from "axe-core";
import { renderInBrowser } from "./render";
// 実アプリと同じ配色 (CSS 変数 --bg / --text 等) で描画するために読み込む。
// これが無いと Chakra トークンの var() が解決されず、color-contrast が実アプリと
// 無関係な色で判定されてしまう (シナリオテストは <App /> 経由で同 CSS を読み込む)。
import "../../App.css";
import { t } from "../../i18n";
import { ConnectionForm } from "../../components/ConnectionForm";
import { ResultGrid } from "../../components/ResultGrid";
import { DangerousQueryDialog } from "../../components/DangerousQueryDialog";
import { SettingsView } from "../../components/SettingsView";
import { HelpView } from "../../components/HelpView";
import type { Column, QueryResult } from "../../api/tauri";
import type { DangerFinding } from "../../dangerousSql";

// アクセシビリティ自動テスト (#603) — axe-core をブラウザモードに統合。
//
// jsdom 版の `a11y.test.tsx` (vitest-axe) は構造・ラベル・ロールの違反を検出する
// が、jsdom はレイアウト/配色を計算しないため色コントラスト (`color-contrast`)
// を評価できない。本ファイルは実 Chromium (Playwright provider) に主要画面を
// マウントし、**実レンダリング結果に対して axe-core を直接実行**することで
// コントラストを含む a11y 違反を検出する。`@axe-core/playwright` は使わず、
// テストと同じ iframe 内で `axe.run(document)` を呼ぶ (ブラウザモードはテスト
// コードが実ブラウザで動くため注入が不要で、追加ツールも最小で済む)。
//
// 検証方針 (Issue #603):
//   - ルールは ARIA ロール / ラベル / ボタン名 / フォームラベル / コントラスト に
//     絞る (`AXE_RULES`)。全ルール実行は誤検出・実行時間の面で漸進方針に反する。
//   - 重大度 critical / serious の違反のみ fail させる (moderate 以下は当面対象外)。
//   - 既存違反はルール単位のベースライン許可リスト (`BASELINE_ALLOWED`) で除外し
//     て初期状態を green にする。**新規の違反のみ fail** する漸進方針 (#443 /
//     #482 と整合)。ベースラインの違反を修正したらリストから削除して網を狭める。
//
// バックエンド (IPC) は `setup.browser.ts` の Tauri スタブで無害化しており、各
// 画面は props でデータを注入する (実 DB 不要)。SettingsView はマウント時に
// `api.readLogs` を呼ぶため `screens.browser.test.tsx` と同じくモックする。
vi.mock("../../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readLogs: vi.fn(async () => ({ text: "", path: "/tmp/noobdb.log" })),
    },
  };
});

// 検証対象ルール。ARIA ロール / ラベル / ボタン名 / フォームラベル / コントラスト
// に対応する axe-core のルール ID (誤検出の少ない構造系 + 実ブラウザでしか測れ
// ない color-contrast)。ページ構造系 (landmark / region / page-title など) は
// コンポーネント単位のマウントでは常に偽陽性になるため対象にしない。
const AXE_RULES = [
  // ARIA ロール / 属性の妥当性
  "aria-allowed-attr",
  "aria-allowed-role",
  "aria-hidden-body",
  "aria-hidden-focus",
  "aria-required-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-roles",
  "aria-valid-attr",
  "aria-valid-attr-value",
  // 名前 (アクセシブルネーム) 系
  "aria-command-name",
  "aria-dialog-name",
  "aria-input-field-name",
  "aria-toggle-field-name",
  "button-name",
  "input-button-name",
  "link-name",
  // フォームラベル
  "label",
  "form-field-multiple-labels",
  "select-name",
  // コントラスト (実ブラウザのみ評価可能)
  "color-contrast",
] as const;

// fail させる重大度。moderate / minor は当面対象外 (漸進方針)。
const FAIL_IMPACTS = new Set(["critical", "serious"]);

// ベースライン許可リスト — 導入時点で既存だった違反を画面 × ルール ID ×
// 対象セレクタ単位で除外し、初期状態を green にする (**新規違反のみ fail**)。
// エントリを消化 (コンポーネント側を修正) したらここから削除して検出網を
// 狭めること。ルール ID 単位の丸ごと除外にすると同一画面へ後から入った
// 別要素の同種違反まで隠れてしまうため、除外は必ず targets で絞る。
//
// 導入時の走査で見つかったラベル系違反 (ConnectionForm の label / select-name、
// SettingsView の select-name) は htmlFor/id の関連付けで修正済み。残るのは
// 下記の color-contrast のみで、いずれもライトテーマの配色値そのものの調整
// (全テーマプリセットへの波及を含むデザイン変更) が必要なため、WCAG コントラスト
// ガード (#559) の対応に委ねてベースライン化する。
const BASELINE_ALLOWED: ReadonlyArray<{
  /** 対象画面 (テスト名と揃える)。 */
  screen: string;
  /** 除外する axe ルール ID。 */
  ruleId: string;
  /** 除外する違反ノードのセレクタ (axe の node.target に部分一致)。 */
  targets: readonly string[];
  /** なぜ即修正せずベースライン化するかの理由。 */
  reason: string;
}> = [
  {
    screen: "result-grid",
    ruleId: "color-contrast",
    targets: [".th-type"],
    reason:
      "列ヘッダの型ラベル (.th-type、#727c89 on #eef1f5 = 3.73:1 < 4.5:1)。" +
      "muted 系トークンの明度調整は全テーマプリセットに波及するため #559 で対応。",
  },
  {
    screen: "help",
    ruleId: "color-contrast",
    targets: [".th-type", ".help-impact-badge"],
    reason:
      "実行効果バッジ (#15803d on #d4e3df = 3.78:1) とサンプルグリッドの " +
      ".th-type (result-grid と同一)。配色調整は #559 で対応。",
  },
];

/**
 * マウント済みのドキュメントに対して axe を実行し、fail 対象 (critical/serious
 * かつベースライン外) の違反だけを返す。
 */
async function runAxe(screen: string): Promise<axe.Result[]> {
  // モーダル (Chakra Dialog) は motion (JS) の出現アニメーションで opacity 0 →
  // 1 にフェードインする。`setup.browser.ts` の CSS アニメーション無効化は JS
  // 駆動のアニメーションには効かないため、フェード途中 (半透明) で axe を実行
  // すると color-contrast がブレンド中の色で誤判定される。ダイアログが完全に
  // 表示される (opacity 1) まで待ってから検査する。
  const dialog = document.querySelector(
    '[data-scope="dialog"][data-part="content"]',
  );
  if (dialog) {
    await expect
      .poll(() => getComputedStyle(dialog).opacity, { timeout: 5_000 })
      .toBe("1");
  }
  const results = await axe.run(document, {
    runOnly: { type: "rule", values: [...AXE_RULES] },
    // 実験的ルール等は runOnly 指定なので混入しない。結果は違反のみ使う。
    resultTypes: ["violations"],
  });
  const allowed = BASELINE_ALLOWED.filter((b) => b.screen === screen);
  return results.violations
    .filter((v) => FAIL_IMPACTS.has(v.impact ?? ""))
    .map((v) => {
      // ベースライン照合は違反ノード単位: 許可済みセレクタに一致するノード
      // だけを取り除き、残ったノード (= 新規違反) があれば fail 対象に残す。
      const targets = allowed
        .filter((b) => b.ruleId === v.id)
        .flatMap((b) => b.targets);
      if (targets.length === 0) return v;
      const nodes = v.nodes.filter(
        (n) => !targets.some((sel) => n.target.join(" ").includes(sel)),
      );
      return { ...v, nodes };
    })
    .filter((v) => v.nodes.length > 0);
}

/** 違反を人間が読めるレポート文字列へ整形する (fail 時のデバッグ用)。 */
function formatViolations(violations: axe.Result[]): string {
  return violations
    .map(
      (v) =>
        `[${v.impact}] ${v.id}: ${v.help}\n` +
        v.nodes
          .map((n) => `    ${n.target.join(" ")} — ${n.failureSummary ?? ""}`)
          .join("\n"),
    )
    .join("\n");
}

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

describe("アクセシビリティ自動検査 (axe-core / 実ブラウザ)", () => {
  // テーマを明示してコントラスト判定を決定的にする (visual.browser.test.tsx と
  // 同じく `<html data-theme>` が theme.ts の dark 条件のトリガ)。ライトテーマを
  // 既定の検証対象とする。
  beforeEach(() => {
    document.documentElement.setAttribute("data-theme", "light");
  });

  it("接続フォームに新規の critical/serious 違反がない", async () => {
    const screen = await renderInBrowser(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: t("formSave") }))
      .toBeVisible();

    const violations = await runAxe("connection-form");
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("結果グリッドに新規の critical/serious 違反がない", async () => {
    const result = makeResult(
      [
        { name: "name", type_name: "VARCHAR" },
        { name: "qty", type_name: "INT" },
      ],
      [
        ["banana", 2],
        ["apple", 5],
      ],
    );
    const screen = await renderInBrowser(<ResultGrid result={result} />);
    await expect.element(screen.getByText("banana")).toBeVisible();

    const violations = await runAxe("result-grid");
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("危険クエリ確認ダイアログに新規の critical/serious 違反がない", async () => {
    const findings: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];
    const screen = await renderInBrowser(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: t("dangerousConfirm") }))
      .toBeVisible();

    const violations = await runAxe("dangerous-query-dialog");
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("設定画面に新規の critical/serious 違反がない", async () => {
    const screen = await renderInBrowser(
      <SettingsView theme="light" onClose={() => {}} />,
    );
    await expect.element(
      screen.getByRole("heading", { name: t("settingsTitle"), exact: true }),
    ).toBeVisible();

    const violations = await runAxe("settings");
    expect(violations, formatViolations(violations)).toEqual([]);
  });

  it("ヘルプ画面に新規の critical/serious 違反がない", async () => {
    const screen = await renderInBrowser(<HelpView onClose={() => {}} />);
    await expect.element(screen.getByText(t("helpTitle"))).toBeVisible();

    const violations = await runAxe("help");
    expect(violations, formatViolations(violations)).toEqual([]);
  });
});
