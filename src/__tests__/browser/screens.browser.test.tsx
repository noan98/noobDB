import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { ConnectionForm } from "../../components/ConnectionForm";
import { ResultGrid } from "../../components/ResultGrid";
import { ContextMenu } from "../../components/ContextMenu";
import { DangerousQueryDialog } from "../../components/DangerousQueryDialog";
import { SettingsView } from "../../components/SettingsView";
import { HelpView } from "../../components/HelpView";
import type { Column, QueryResult } from "../../api/tauri";
import type { DangerFinding } from "../../dangerousSql";

// Phase 1 — 画面レンダリングのスモークテスト。
//
// jsdom の純ロジック/挙動テストでは「実ブラウザで本物の CSS と一緒に主要画面が
// 描画されるか」は検証できないため、ここでは実 Chromium (Playwright provider) に
// 主要画面をマウントし、
// **例外なく描画され、要のロール/テキストが可視である**ことを確認する。
//
// バックエンド (IPC) は `setup.browser.ts` の Tauri スタブで無害化しており、各画面は
// props でデータを注入する (実 DB 不要)。文言はロケールで変わるため i18n の `t()`
// から期待値を引く。
//
// jsdom の既存ユニットテストとは実行環境が異なるため、本ファイルは
// `*.browser.test.tsx` という別 glob に分け、`vitest.browser.config.ts` でのみ
// 実行する (jsdom スイートとは衝突させない)。
//
// `src/api/tauri.ts` のモックシームの一例として、マウント時に IPC を
// 呼ぶ画面 (SettingsView の `api.readLogs`) はここで差し替え、実 DB なしに状態を
// 注入する。`setup.browser.ts` の Tauri スタブは `invoke` を解決済み null にするが、
// api ラッパは応答を zod で検証するため、応答形を持つコマンドは個別にモックして
// 未処理 rejection を避ける。それ以外の実 API は温存する (該当画面はマウント時に
// 呼ばないため問題ない)。
vi.mock("../../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      readLogs: vi.fn(async () => ({ text: "", path: "/tmp/noobdb.log" })),
      // SettingsView の KnownHostsPanel がマウント時に呼ぶ (#682)。実 DB 無しで空一覧。
      listKnownHosts: vi.fn(async () => []),
    },
  };
});

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

describe("主要画面のレンダリング (実ブラウザ)", () => {
  it("接続フォームが描画され、保存ボタンが可視である", async () => {
    const screen = await renderInBrowser(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );

    await expect.element(screen.getByText(t("formNewTitle"))).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: t("formSave") }))
      .toBeVisible();
  });

  it("結果グリッドが列ヘッダと行を描画する", async () => {
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
    const screen = await renderInBrowser(
      <ResultGrid result={result} onChangeView={() => {}} />,
    );

    // 列ヘッダはソート可能なのでボタンとして描画される。
    await expect.element(screen.getByRole("button", { name: /^name/ })).toBeVisible();
    await expect.element(screen.getByText("banana")).toBeVisible();
    // 表示切替セグメント (グリッド/ピボット/チャート、#975 の Segmented) が
    // 排他ラジオグループとして可視であること。
    await expect
      .element(screen.getByRole("radiogroup", { name: t("resultViewSwitchAria") }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("radio", { name: t("gridViewLabel") }))
      .toBeVisible();
  });

  it("危険クエリ確認ダイアログ (安全網 UI) が描画される", async () => {
    const findings: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];
    const screen = await renderInBrowser(
      <DangerousQueryDialog
        findings={findings}
        isProduction={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    await expect.element(screen.getByText(t("dangerousTitle"))).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: t("dangerousConfirm") }))
      .toBeVisible();
  });

  it("設定画面が描画される", async () => {
    const screen = await renderInBrowser(<SettingsView theme="light" onClose={() => {}} />);
    await expect.element(
      screen.getByRole("heading", { name: t("settingsTitle"), exact: true }),
    ).toBeVisible();
    // 密度設定のスライドするセグメント (#975 の Segmented) が排他ラジオグループ
    // として可視であること。
    await expect
      .element(screen.getByRole("radiogroup", { name: t("settingsDensity") }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("radio", { name: t("settingsDensityNormal") }))
      .toBeVisible();
  });

  it("ヘルプ画面が描画される", async () => {
    const screen = await renderInBrowser(<HelpView onClose={() => {}} />);
    await expect.element(screen.getByText(t("helpTitle"))).toBeVisible();
  });
});

// #961: ブラウザテストのハーネスが `App.css` を一度も読み込んでおらず、
// `:root` で定義されるデザイントークン (`--font-scale` / `--text-*` /
// `--control-*` ほか、Chakra の recipe や `calc()` 式が参照する CSS 変数) が
// 全て未定義のまま描画されていた回帰の固定テスト。`setup.browser.ts` が
// `App.css` を import するようになったことの直接の証拠として、未定義なら
// 空文字列を返す `getComputedStyle` でトークンが実際に解決されていることを
// 確認する。
describe("デザイントークン (App.css) の解決 (#961)", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it(":root のトークンが未定義 (空文字列) のまま描画されていない", () => {
    document.documentElement.removeAttribute("data-theme");
    const root = getComputedStyle(document.documentElement);

    // `--font-scale` は `calc(13px * var(--font-scale))` (`Icon.tsx`) のような
    // 式の分母にあたり、未定義だと calc() 自体が invalid になってアイコンが
    // 巨大化する (Issue 本文の症状)。
    expect(root.getPropertyValue("--font-scale").trim()).not.toBe("");
    // `--text-md` / `--control-px` はツールバーの余白・文字サイズを決めるトークン。
    expect(root.getPropertyValue("--text-md").trim()).not.toBe("");
    expect(root.getPropertyValue("--control-px").trim()).not.toBe("");
    // `--bg` はページ全体の背景色トークン (`html, body, #root { background:
    // var(--bg); }`)。ダークテーマのベースラインが白背景のまま描画される問題
    // (Issue 本文) の直接の原因だった。
    expect(root.getPropertyValue("--bg").trim()).not.toBe("");
  });

  it("`data-theme=\"dark\"` で `--bg` トークンがライトテーマと異なる値へ切り替わる", () => {
    document.documentElement.removeAttribute("data-theme");
    const lightBg = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();

    document.documentElement.setAttribute("data-theme", "dark");
    const darkBg = getComputedStyle(document.documentElement)
      .getPropertyValue("--bg")
      .trim();

    expect(darkBg).not.toBe("");
    expect(darkBg).not.toBe(lightBg);
  });
});

// 右クリックメニューのサブメニュー (#1018)。開いた子パネルが実際にどこへ描画され
// るかは CSS とレイアウト依存で、jsdom (矩形が常に 0) では検証できない。ここでは
// 実 Chromium で「親項目の右側に出る」「ビューポート内に収まる」「親パネルを
// 覆い隠さない」という位置決めの要点だけを押さえる (算術自体は
// `menuPosition.test.ts` の領分)。
describe("ContextMenu のサブメニュー (実ブラウザ)", () => {
  it("親項目の右側に開き、ビューポート内へ収まる", async () => {
    const screen = await renderInBrowser(
      <ContextMenu
        x={120}
        y={140}
        onClose={() => {}}
        items={[
          { label: "トップ項目", onSelect: () => {} },
          {
            label: "参照元を表示",
            items: [
              { label: "orders.user_id", onSelect: () => {} },
              { label: "comments.user_id", onSelect: () => {} },
            ],
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("menuitem", { name: "参照元を表示" });
    await expect.element(trigger).toBeVisible();
    await trigger.hover();

    const childItem = screen.getByRole("menuitem", { name: "orders.user_id" });
    await expect.element(childItem).toBeVisible();

    const triggerRect = (await trigger.element()).getBoundingClientRect();
    const childPanel = (await childItem.element()).closest("[role=menu]");
    expect(childPanel).not.toBeNull();
    const panelRect = (childPanel as HTMLElement).getBoundingClientRect();

    // 親項目の右側 (= 親パネルに重ならない位置) に出ている。
    expect(panelRect.left).toBeGreaterThanOrEqual(triggerRect.right);
    // 先頭の子項目は親項目とおおよそ同じ高さに並ぶ。
    expect(Math.abs(panelRect.top - triggerRect.top)).toBeLessThan(16);
    // 画面外へはみ出していない。
    expect(panelRect.left).toBeGreaterThanOrEqual(0);
    expect(panelRect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(panelRect.top).toBeGreaterThanOrEqual(0);
    expect(panelRect.bottom).toBeLessThanOrEqual(window.innerHeight);
  });
});
