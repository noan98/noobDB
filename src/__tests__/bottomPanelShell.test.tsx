import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import { BottomPanel, BottomPanelStrip, WorkspaceSplit } from "../components/BottomPanel";
import {
  BOTTOM_PANEL_TABS,
  type BottomPanelStripEntry,
  type BottomPanelTab,
  type BottomPanelUnavailableReason,
} from "../components/bottomPanelTabs";

/**
 * ボトムパネルのシェル (#1112 / Epic #1110 Phase 2)。
 *
 * 中身のパネル (`AdvisorPanel` など) から見出しと閉じるボタンを取り上げ、ここへ
 * 集約したので、**タイトルと閉じる導線・タブの WAI-ARIA 構造はここが唯一の持ち主**に
 * なる。壊すとどのパネルを見ているか分からなくなり、閉じる手段も無くなる。
 */

const label = (tab: BottomPanelTab) =>
  tab === "output"
    ? t("outputTitle")
    : tab === "messages"
      ? t("messagesTitle")
      : tab === "activity"
        ? t("activityCenterTitle")
        : tab === "advisor"
    ? t("advisorTitle")
    : tab === "inspector"
      ? t("inspectorTitle")
      : tab === "whereUsed"
        ? t("whereUsedTitle")
      : tab === "health"
        ? t("healthTitle")
        : t("processTitle");

function renderShell(overrides: Partial<Parameters<typeof BottomPanel>[0]> = {}) {
  const props = {
    tab: "advisor" as BottomPanelTab,
    // 「列を探索」(#974) と「構造」(#1112) は対象テーブルが決まったときだけ並ぶので、
    // 接続中に常設の診断タブ + 影響分析で検証する (ログ系 3 タブは別の it で扱う)。
    tabs: ["advisor", "inspector", "processes", "health", "whereUsed"] as BottomPanelTab[],
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
      t("healthTitle"),
      t("whereUsedTitle"),
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
  });

  it("選択中のタブだけがタブ順に乗る (ローピング tabindex)", () => {
    renderShell({ tab: "inspector" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1", "-1"]);
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
    expect(props.onSelect).toHaveBeenLastCalledWith("whereUsed");
  });

  it("用途グループ (ログ / 診断 / 参照、#1114) の切れ目に区切り線を引く", () => {
    renderShell({ tabs: BOTTOM_PANEL_TABS.filter((tab) => tab !== "profile" && tab !== "structure") });
    // ログ系 3 タブは接続に関係なく常に並ぶ。
    const tabs = screen.getAllByRole("tab");
    expect(tabs.slice(0, 3).map((el) => el.textContent)).toEqual([
      t("outputTitle"),
      t("messagesTitle"),
      t("activityCenterTitle"),
    ]);
    // ログ | 診断 | 参照 の 2 箇所。区切り線はタブではない (矢印キー巡回に乗らない)。
    const dividers = screen.getAllByTestId("bottom-panel-group-divider");
    expect(dividers).toHaveLength(2);
    for (const d of dividers) {
      expect(d).toHaveAttribute("aria-hidden");
      expect(d.getAttribute("role")).toBeNull();
    }
    expect(tabs).toHaveLength(BOTTOM_PANEL_TABS.length - 2);
  });

  it("グループが 1 つだけなら区切り線を引かない", () => {
    renderShell({ tab: "output", tabs: ["output", "messages", "activity"] });
    expect(screen.queryAllByTestId("bottom-panel-group-divider")).toHaveLength(0);
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

  it("閉じると退場アニメーションの後に分割を外し、開くと分割を作り直す (#1142)", async () => {
    const view = renderWithProviders(
      <WorkspaceSplit bottom={<div data-testid="bottom">bottom</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    view.rerender(
      <WorkspaceSplit bottom={null}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    // 退場が終われば分割 (セパレータ) ごと消え、ワークスペースだけが残る。
    await waitFor(() => expect(screen.queryByRole("separator")).toBeNull());
    expect(screen.queryByTestId("bottom")).toBeNull();
    expect(screen.getByTestId("workspace")).toBeInTheDocument();

    view.rerender(
      <WorkspaceSplit bottom={<div data-testid="bottom">again</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    // 開いた瞬間に同期で分割が作られる (1 フレーム遅れて出ない)。
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByTestId("bottom")).toHaveTextContent("again");
  });
});

describe("BottomPanelStrip (折りたたみ時のパネルバー)", () => {
  const reasonLabel = (reason: BottomPanelUnavailableReason) =>
    reason === "sqliteUnsupported"
      ? t("appProcessesUnsupported")
      : reason === "needsDatabase"
        ? t("appAdvisorUnsupported")
        : t("appToolsNeedsSession");
  const entries: BottomPanelStripEntry[] = [
    { tab: "output", enabled: true, reason: null },
    { tab: "messages", enabled: true, reason: null },
    { tab: "advisor", enabled: true, reason: null },
    { tab: "processes", enabled: false, reason: "needsSession" },
  ];

  function renderStrip(overrides: Partial<Parameters<typeof BottomPanelStrip>[0]> = {}) {
    const props = { entries, label, reasonLabel, onOpen: vi.fn(), ...overrides };
    renderWithProviders(<BottomPanelStrip {...props} />);
    return props;
  }

  it("閉じていても開けるタブを 1 行で見せ、クリックで開く", () => {
    const props = renderStrip();
    const nav = screen.getByRole("navigation", { name: t("bottomPanelStripAria") });
    expect(nav).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("advisorTitle") }));
    expect(props.onOpen).toHaveBeenCalledWith("advisor");
    // 用途グループ (ログ | 診断) の切れ目に区切り線。
    expect(screen.getAllByTestId("bottom-panel-group-divider")).toHaveLength(1);
  });

  it("今は開けない項目は aria-disabled で残し、クリックしても開かない", () => {
    const props = renderStrip();
    const btn = screen.getByRole("button", { name: t("processTitle") });
    expect(btn).toHaveAttribute("aria-disabled", "true");
    // `disabled` にするとホバー / フォーカスが効かず理由のツールチップが読めない。
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(props.onOpen).not.toHaveBeenCalled();
  });

  it("無効な項目にフォーカスすると理由をツールチップで示す", async () => {
    renderStrip();
    fireEvent.focus(screen.getByRole("button", { name: t("processTitle") }));
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent(t("appToolsNeedsSession")),
    );
  });

  it("項目が無ければ何も描かない", () => {
    renderStrip({ entries: [] });
    expect(screen.queryByTestId("bottom-panel-strip")).toBeNull();
  });

  it("WorkspaceSplit は閉じているときだけ collapsed を出す", async () => {
    const view = renderWithProviders(
      <WorkspaceSplit bottom={null} collapsed={<div data-testid="strip">strip</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    expect(screen.getByTestId("strip")).toBeInTheDocument();
    view.rerender(
      <WorkspaceSplit bottom={<div data-testid="bottom">bottom</div>} collapsed={<div data-testid="strip">strip</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    // 開いている間はタブバーが同じ役目を持つので、バーは二重に出さない。
    expect(screen.queryByTestId("strip")).toBeNull();
    view.rerender(
      <WorkspaceSplit bottom={null} collapsed={<div data-testid="strip">strip</div>}>
        <div data-testid="workspace">workspace</div>
      </WorkspaceSplit>,
    );
    await waitFor(() => expect(screen.getByTestId("strip")).toBeInTheDocument());
  });
});
