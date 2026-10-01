import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import { t } from "../../i18n";
import type { QueryResult } from "../../api/tauri";

// 結果グリッドのツールバー幅適応 (#1270) を実ブラウザで検証する。jsdom ではレイアウトが
// 計算されないため、「1280px でも切れない」「狭いほど「…」へ畳む」はここで確かめる。

const RESULT: QueryResult = {
  columns: [
    { name: "id", type_name: "INT" },
    { name: "name", type_name: "VARCHAR" },
  ],
  rows: [
    [1, "apple"],
    [2, "banana"],
  ],
  rows_affected: 0,
  elapsed_ms: 3,
};

function Grid(props: { width: number }) {
  return (
    <div style={{ width: props.width, height: 400, display: "flex", flexDirection: "column" }}>
      <ResultGrid
        result={RESULT}
        onChangeView={() => {}}
        onSaveAsTable={() => {}}
        onSaveAsView={() => {}}
        onRegisterLocalTable={() => {}}
        onTransferResult={() => {}}
        onSetAutoRefresh={() => {}}
        autoRefreshAllowed
        onPinResult={() => {}}
        canPinResult
        onToggleMaximize={() => {}}
      />
    </div>
  );
}

function toolbar(): HTMLElement {
  const el = document.querySelector("input[type=search]")?.parentElement;
  if (!el) throw new Error("toolbar not found");
  return el as HTMLElement;
}

describe("結果グリッドのツールバー (#1270, 実ブラウザ)", () => {
  it("1280px 幅でははみ出さず、全操作が見えている", async () => {
    await renderInBrowser(<Grid width={1280} />);
    await expect.element(page.getByRole("button", { name: t("exportButton") })).toBeVisible();
    const el = toolbar();
    await expect.poll(() => el.scrollWidth <= el.clientWidth + 1).toBe(true);
    expect(el.querySelectorAll("[data-toolbar-action]").length).toBeGreaterThan(0);
  });

  it("狭い幅では副次操作が「…」メニューに畳まれ、はみ出さない", async () => {
    await renderInBrowser(<Grid width={760} />);
    const more = page.getByRole("button", { name: t("resultToolbarMoreTitle") });
    await expect.element(more).toBeVisible();
    const el = toolbar();
    await expect.poll(() => el.scrollWidth <= el.clientWidth + 1).toBe(true);
    // Export は常時表示。
    await expect.element(page.getByRole("button", { name: t("exportButton") })).toBeVisible();

    await more.click();
    // 畳まれた項目はメニューから到達できる (最初に畳まれる自動更新はサブメニュー)。
    await expect.element(page.getByRole("menuitem", { name: t("autoRefreshLabel") })).toBeVisible();
    // Esc で閉じ、ボタンへフォーカスが戻る。
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector("[role=menu]")).toBeNull();
  });
});
