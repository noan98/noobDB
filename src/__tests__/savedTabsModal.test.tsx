import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { SavedTabsModal } from "../components/SavedTabsModal";
import { GroupNameModal } from "../components/GroupNameModal";
import type { SavedWorkspaceSummary } from "../savedTabsSummary";

const summary: SavedWorkspaceSummary = {
  total: 2,
  panes: [
    {
      tabs: [
        { title: "Query 1", kind: "query", target: null, sqlHead: "SELECT * FROM users" },
        { title: "orders", kind: "table", target: "shop.orders", sqlHead: "" },
      ],
    },
  ],
};

/** 保存済みタブの確認・消去 (#1630)。 */
describe("SavedTabsModal (#1630)", () => {
  it("タブ数・タイトル・先頭の SQL を一覧し、消去を呼べる", () => {
    const onClear = vi.fn();
    renderWithProviders(
      <SavedTabsModal
        profileName="Prod"
        summary={summary}
        isActive={false}
        onClear={onClear}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(t("savedTabsSummary", { count: 2 }))).toBeInTheDocument();
    expect(screen.getByText("SELECT * FROM users")).toBeInTheDocument();
    expect(screen.getByText("Query 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("savedTabsClear") }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("接続中の接続では消去できず、理由を示す", () => {
    renderWithProviders(
      <SavedTabsModal profileName="Prod" summary={summary} isActive onClear={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByRole("button", { name: t("savedTabsClear") })).toBeDisabled();
    expect(screen.getByText(t("savedTabsActiveNote"))).toBeInTheDocument();
  });

  it("タブが無ければ空の案内を出し、消去は無効", () => {
    renderWithProviders(
      <SavedTabsModal
        profileName="Prod"
        summary={{ total: 0, panes: [] }}
        isActive={false}
        onClear={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(t("savedTabsEmpty"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("savedTabsClear") })).toBeDisabled();
  });
});

describe("GroupNameModal (#1630)", () => {
  it("空白だけでは移動できず、入力した名前は前後の空白を除いて確定する", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <GroupNameModal count={2} existingGroups={["A"]} onConfirm={onConfirm} onClose={() => {}} />,
    );
    const move = screen.getByRole("button", { name: t("groupNameMove") });
    expect(move).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t("groupNameLabel")), { target: { value: "  New  " } });
    expect(move).not.toBeDisabled();
    fireEvent.click(move);
    expect(onConfirm).toHaveBeenCalledWith("New");
  });
});
