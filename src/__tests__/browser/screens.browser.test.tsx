import { describe, expect, it, vi } from "vitest";
import { renderInBrowser } from "./render";
import { t } from "../../i18n";
import { ConnectionForm } from "../../components/ConnectionForm";
import { ResultGrid } from "../../components/ResultGrid";
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
    const screen = await renderInBrowser(<ResultGrid result={result} />);

    // 列ヘッダはソート可能なのでボタンとして描画される。
    await expect.element(screen.getByRole("button", { name: /^name/ })).toBeVisible();
    await expect.element(screen.getByText("banana")).toBeVisible();
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
  });

  it("ヘルプ画面が描画される", async () => {
    const screen = await renderInBrowser(<HelpView onClose={() => {}} />);
    await expect.element(screen.getByText(t("helpTitle"))).toBeVisible();
  });
});
