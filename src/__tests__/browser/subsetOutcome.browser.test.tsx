// サブセット抽出の進捗と完了表示 (#2264)。実 Chromium で、確定進捗バーと、完了 / 中断のときに
// モーダルが閉じず JobOutcome が残ることを固定する。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { renderInBrowser } from "./render";
import { emitTauriEvent, installTauriMock, invocationsOf, onCommand } from "./tauriMock";
import { SubsetExtractModal } from "../../components/SubsetExtractModal";
import { t } from "../../i18n";

afterEach(async () => {
  await cleanup();
});

const PREVIEW = {
  tables: [
    { table: "customers", rows: 3, rootRows: 3, childRows: 0, parentRows: 0, columns: [] },
    { table: "orders", rows: 7, rootRows: 0, childRows: 7, parentRows: 0, columns: [] },
  ],
  totalRows: 10,
  cycles: [],
  warnings: [],
};

let streamId = "";

beforeEach(() => {
  installTauriMock();
  onCommand("preview_subset", () => PREVIEW);
  onCommand("run_subset", (args) => {
    streamId = (args as { streamId: string }).streamId;
    return undefined;
  });
  onCommand("cancel_stream", () => ({ streamId, cancelled: true, deliveredRows: 4 }));
});

async function startRun(screen: Awaited<ReturnType<typeof renderInBrowser>>) {
  await screen.getByRole("button", { name: t("subsetPreviewButton") }).click();
  await expect.element(screen.getByTestId("subset-preview")).toBeVisible();
  await screen.getByRole("combobox", { name: t("subsetOutputLabel") }).click();
  await screen.getByRole("option", { name: t("subsetOutputScript") }).click();
  await screen.getByLabelText(t("subsetSavePath")).fill("/tmp/out.sql");
  await screen.getByRole("button", { name: t("subsetExecute") }).click();
  await vi.waitFor(() => expect(invocationsOf("run_subset").length).toBe(1));
}

function render() {
  return renderInBrowser(
    <SubsetExtractModal
      sessionId="s1"
      sourceProfileId="p1"
      database="app"
      table="customers"
      profiles={[]}
      onSandboxCreated={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("サブセット抽出の進捗と完了 (実ブラウザ)", () => {
  it("プレビュー済みなら確定進捗バーを出し、完了後も JobOutcome と表別の内訳が残る", async () => {
    const screen = await render();
    await startRun(screen);
    emitTauriEvent("subset-stream:progress", { streamId, phase: "collect", rows: 5 });
    await expect.element(screen.getByTestId("subset-progress-bar")).toBeVisible();
    emitTauriEvent("subset-stream:done", {
      streamId,
      rows: 10,
      elapsedMs: 1200,
      tables: PREVIEW.tables.map((x) => ({ table: x.table, rows: x.rows })),
      warnings: [],
      path: "/tmp/out.sql",
    });
    await expect.element(screen.getByTestId("subset-outcome")).toBeVisible();
    await expect.element(screen.getByTestId("subset-outcome-tables")).toBeVisible();
    expect(screen.getByTestId("subset-outcome-row").elements().length).toBe(2);
    await expect.element(screen.getByRole("button", { name: t("subsetOpenScriptDir") })).toBeVisible();
    // 自動では閉じない: フォームも残っている。
    await expect.element(screen.getByRole("button", { name: t("subsetExecute") })).toBeVisible();
  });

  it("中断すると JobOutcome (中断) が残る", async () => {
    const screen = await render();
    await startRun(screen);
    emitTauriEvent("subset-stream:progress", { streamId, phase: "write", rows: 4 });
    await screen.getByRole("button", { name: t("subsetCancelRun") }).click();
    await expect.element(screen.getByTestId("subset-outcome")).toBeVisible();
    await expect.element(screen.getByText(t("subsetCancelled", { rows: 4 }))).toBeVisible();
  });
});
