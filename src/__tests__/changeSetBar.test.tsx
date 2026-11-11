import { describe, expect, it, vi } from "vitest";
import { ChangeSetBar, hasChangeSet } from "../components/ChangeSetBar";
import { t } from "../i18n";
import { fireEvent, renderWithProviders, screen } from "./testUtils";

const base = {
  editCells: 0,
  editRows: 0,
  inserts: 0,
  deletes: 0,
  canPreview: false,
  previewTitle: "preview",
  onDiscard: () => {},
};

describe("ChangeSetBar (#2235)", () => {
  it("3 種のどれも無ければ何も出さない", () => {
    expect(hasChangeSet(base)).toBe(false);
    renderWithProviders(<ChangeSetBar {...base} />);
    expect(screen.queryByRole("group", { name: t("changeSetAria") })).toBeNull();
  });

  it("種類別のピルを出し、適用は 1 つだけで送る文の内訳をツールチップに出す", () => {
    const onApply = vi.fn();
    renderWithProviders(
      <ChangeSetBar
        {...base}
        editCells={4}
        editRows={3}
        inserts={1}
        deletes={2}
        onApply={onApply}
        applyShortcut="Ctrl+S"
      />,
    );
    expect(screen.getByText(t("editPendingCount", { cells: 4, rows: 3 }))).toBeInTheDocument();
    expect(screen.getByText(t("changeSetPillInsert", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("changeSetPillDelete", { count: 2 }))).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: new RegExp(t("editApplyButton")) })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("editApplyButton")) }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it("削除予定だけでもバーが出て、更新・追加のピルは出ない", () => {
    renderWithProviders(<ChangeSetBar {...base} deletes={2} onApply={() => {}} />);
    expect(screen.getByText(t("changeSetPillDelete", { count: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(t("changeSetPillInsert", { count: 1 }))).toBeNull();
  });

  it("適用できない理由があるとき適用ボタンは無効", () => {
    const onApply = vi.fn();
    renderWithProviders(
      <ChangeSetBar {...base} editCells={1} editRows={1} applyBlockedReason="blocked" onApply={onApply} />,
    );
    const btn = screen.getByRole("button", { name: new RegExp(t("editApplyButton")) });
    expect(btn).toBeDisabled();
  });

  it("破棄ボタンで onDiscard", () => {
    const onDiscard = vi.fn();
    renderWithProviders(<ChangeSetBar {...base} deletes={1} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("editCancelButton")) }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
