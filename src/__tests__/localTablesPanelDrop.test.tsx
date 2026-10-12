import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { LocalTableMeta } from "../api/tauri";
import { LocalTablesPanel } from "../components/LocalTablesPanel";

/** ローカルテーブルの削除は確認を挟み、キャンセルなら削除しない (#1532)。 */
const table = {
  name: "orders_copy",
  row_count: 3,
  fetched_at_ms: 0,
  source_profile: null,
  source_database: null,
  source_sql: "select 1",
} as unknown as LocalTableMeta;

function renderPanel(onDropTable = vi.fn()) {
  renderWithProviders(
    <LocalTablesPanel
      hasSession
      isActive={false}
      tables={[table]}
      onOpenLocal={() => {}}
      onDropTable={onDropTable}
      onSaveToFile={() => {}}
    />,
  );
  return onDropTable;
}

describe("LocalTablesPanel 削除確認", () => {
  it("キャンセルすると削除しない", async () => {
    const onDrop = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: t("localPanelDropTable") }));
    expect(await screen.findByText(t("localPanelDropConfirmTitle"))).toBeInTheDocument();
    expect(onDrop).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: t("confirmDefaultCancel") }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByText(t("localPanelDropConfirmTitle"))).toBeNull());
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("確認すると削除する", async () => {
    const onDrop = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: t("localPanelDropTable") }));
    fireEvent.click(await screen.findByRole("button", { name: t("localPanelDropConfirmOk") }));
    await waitFor(() => expect(onDrop).toHaveBeenCalledWith("orders_copy"));
  });
});

describe("LocalTablesPanel 再取得ボタン (#1541)", () => {
  it("onRefetchTable があれば各行に出て、押すとテーブル名で呼ぶ。再取得中は止める", () => {
    const onRefetch = vi.fn();
    const { unmount } = renderWithProviders(
      <LocalTablesPanel
        hasSession
        isActive={false}
        tables={[table]}
        onOpenLocal={() => {}}
        onDropTable={() => {}}
        onRefetchTable={onRefetch}
        onSaveToFile={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("localPanelRefetch", { table: "orders_copy" }) }));
    expect(onRefetch).toHaveBeenCalledWith("orders_copy");
    unmount();
    renderWithProviders(
      <LocalTablesPanel
        hasSession
        isActive={false}
        tables={[table]}
        onOpenLocal={() => {}}
        onDropTable={() => {}}
        onRefetchTable={onRefetch}
        refetchingTable="orders_copy"
        onSaveToFile={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: t("localPanelRefetch", { table: "orders_copy" }) })).toBeDisabled();
  });

  it("onRefetchTable が無ければ出さない", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: t("localPanelRefetch", { table: "orders_copy" }) })).toBeNull();
  });
});
