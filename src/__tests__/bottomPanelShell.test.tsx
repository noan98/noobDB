import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { t } from "../i18n";
import { BottomPanel, WorkspaceSplit } from "../components/BottomPanel";
import { BOTTOM_PANEL_TABS, type BottomPanelTab } from "../components/bottomPanelTabs";

/**
 * ボトムパネルのシェル (#1112 / Epic #1110 Phase 2)。
 *
 * 中身のパネル (`AdvisorPanel` など) から見出しと閉じるボタンを取り上げ、ここへ
 * 集約したので、**タイトルと閉じる導線・タブの WAI-ARIA 構造はここが唯一の持ち主**に
 * なる。壊すとどのパネルを見ているか分からなくなり、閉じる手段も無くなる。
 */

const label = (tab: BottomPanelTab) =>
  tab === "advisor" ? t("advisorTitle") : tab === "inspector" ? t("inspectorTitle") : t("processTitle");

function renderShell(overrides: Partial<Parameters<typeof BottomPanel>[0]> = {}) {
  const props = {
    tab: "advisor" as BottomPanelTab,
    tabs: BOTTOM_PANEL_TABS,
    label,
    onSelect: vi.fn(),
    onClose: vi.fn(),
    children: <div data-testid="panel-body">body</div>,
    ...overrides,
  };
  renderWithProviders(<BottomPanel {...props} />);
  return props;
}

describe("BottomPanel シェル (#1112)", () => {
  it("開けるタブをすべて tab ロールで並べ、選択中だけ aria-selected を立てる", () => {
    renderShell();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.textContent)).toEqual([
      t("advisorTitle"),
      t("inspectorTitle"),
      t("processTitle"),
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("選択中のタブだけがタブ順に乗る (ローピング tabindex)", () => {
    renderShell({ tab: "inspector" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("本体は選択中のタブに紐づく tabpanel として描かれる", () => {
    renderShell({ tab: "processes" });
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "bottom-panel-tab-processes");
    expect(screen.getByTestId("panel-body")).toBeInTheDocument();
  });

  it("タブをクリックすると onSelect が呼ばれる", () => {
    const props = renderShell();
    fireEvent.click(screen.getByRole("tab", { name: t("processTitle") }));
    expect(props.onSelect).toHaveBeenCalledWith("processes");
  });

  it("閉じるボタンで onClose が呼ばれる (中身側には閉じる導線を持たせない)", () => {
    const props = renderShell();
    fireEvent.click(screen.getByRole("button", { name: t("bottomPanelClose") }));
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("矢印キーで隣のタブへ、Home / End で端へ移動する", () => {
    const props = renderShell({ tab: "inspector" });
    const active = screen.getByRole("tab", { name: t("inspectorTitle") });
    fireEvent.keyDown(active, { key: "ArrowRight" });
    expect(props.onSelect).toHaveBeenLastCalledWith("processes");
    fireEvent.keyDown(active, { key: "ArrowLeft" });
    expect(props.onSelect).toHaveBeenLastCalledWith("advisor");
    fireEvent.keyDown(active, { key: "Home" });
    expect(props.onSelect).toHaveBeenLastCalledWith("advisor");
    fireEvent.keyDown(active, { key: "End" });
    expect(props.onSelect).toHaveBeenLastCalledWith("processes");
  });

  it("タブバー上の Escape でパネルを閉じる", () => {
    const props = renderShell();
    fireEvent.keyDown(screen.getByRole("tab", { name: t("advisorTitle") }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });
});

describe("WorkspaceSplit (#1112)", () => {
  it("パネルが閉じているときは分割を作らず中身を素通しする", () => {
    renderWithProviders(
      <WorkspaceSplit bottom={null}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    // セパレータが残ると、閉じているのに掴めない線が main の下端に居座る。
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("パネルが開いているときはワークスペースと縦に分割する", () => {
    renderWithProviders(
      <WorkspaceSplit bottom={<div data-testid="bottom">bottom</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    expect(screen.getByTestId("workspace")).toBeInTheDocument();
    expect(screen.getByTestId("bottom")).toBeInTheDocument();
    const separator = screen.getByRole("separator");
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    expect(separator).toHaveAccessibleName(t("bottomPanelResizeAria"));
  });
});
