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

function render(onSandboxRegistered: () => void = () => {}) {
  return renderInBrowser(
    <SubsetExtractModal
      sessionId="s1"
      sourceProfileId="p1"
      database="app"
      table="customers"
      profiles={[]}
      onSandboxRegistered={onSandboxRegistered}
      onOpenSandbox={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("サブセット抽出の進捗と完了 (実ブラウザ)", () => {
  it("プレビュー済みなら確定進捗バーを出し、完了後も JobOutcome と表別の内訳が残る", async () => {
    const screen = await render();
    await startRun(screen);
    // collect 中は分母を出さない (不定表示)。write で確定進捗になり、0% に戻らない。
    emitTauriEvent("subset-stream:progress", { streamId, phase: "collect", rows: 10 });
    await expect.element(screen.getByText(t("subsetRunningCollect"))).toBeVisible();
    expect(screen.getByTestId("subset-progress-bar").elements().length).toBe(0);
    emitTauriEvent("subset-stream:progress", { streamId, phase: "write", rows: 5 });
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

describe("サブセット抽出: サンドボックス出力の登録 (実ブラウザ)", () => {
  it("完了表示のボタンを押さなくても、完了時に登録 (切断・一覧追加) が呼ばれる", async () => {
    const record = {
      id: "sb1",
      name: "customers (subset)",
      source_profile_id: "p1",
      source_driver: "sqlite",
      source_database: "app",
      tables: ["customers"],
      row_limit: 1000,
      file_path: "/tmp/sb1.sqlite",
      created_at: "2026-01-01T00:00:00Z",
      truncated_tables: [],
      row_filters: [],
    };
    onCommand("create_sandbox", () => ({ sandbox: record, session_id: "sess-sb" }));
    const registered = vi.fn();
    const screen = await render(registered);
    await screen.getByRole("button", { name: t("subsetPreviewButton") }).click();
    await expect.element(screen.getByTestId("subset-preview")).toBeVisible();
    await screen.getByRole("combobox", { name: t("subsetOutputLabel") }).click();
    await screen.getByRole("option", { name: t("subsetOutputSandbox") }).click();
    await screen.getByRole("button", { name: t("subsetPreviewButton") }).click();
    await expect.element(screen.getByTestId("subset-preview")).toBeVisible();
    await screen.getByRole("button", { name: t("subsetExecute") }).click();
    await expect.element(screen.getByTestId("subset-outcome")).toBeVisible();
    expect(registered).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("button", { name: t("subsetOpenSandbox") })).toBeVisible();
  });
});
