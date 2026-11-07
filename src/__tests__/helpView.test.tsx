import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, within } from "./testUtils";
import { HelpView } from "../components/HelpView";
import { t } from "../i18n";

/**
 * ヘルプ画面 (#604 レンダリング死角の解消)。純粋に表示のみのモーダルで、
 * マウント時に Tauri 呼び出しを持たない。ダイアログとしてマウントでき、
 * 見出しが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
describe("HelpView render smoke (#604)", () => {
  it("mounts as a dialog and shows the help title", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("helpTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<HelpView onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("helpClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/** 目次の項目ボタン (タイトルで引く)。 */
function navItem(title: string) {
  const nav = screen.getByRole("navigation", { name: t("helpTitle") });
  return within(nav).getByRole("button", {
    name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
}

/** 詳細ペインの見出し (h3)。 */
function detailHeading() {
  return within(screen.getByTestId("help-detail")).getByRole("heading", { level: 3 });
}

describe("HelpView 目次 + 詳細 (#1273 / #1274 / ヘルプ刷新)", () => {
  it("最初は目次の先頭項目を表示し、目次のクリックで詳細が切り替わる", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(detailHeading()).toHaveTextContent(t("helpRunTitle"));
    fireEvent.click(navItem(t("helpDryRunTitle")));
    expect(detailHeading()).toHaveTextContent(t("helpDryRunTitle"));
    expect(navItem(t("helpDryRunTitle"))).toHaveAttribute("aria-current", "true");
    // 手順は番号付きリスト、注意は Callout で出る。
    expect(screen.getByText(t("helpDryRunStep1"))).toBeInTheDocument();
    expect(screen.getByText(t("helpDryRunNote"))).toBeInTheDocument();
  });

  it("DB に書き込む項目だけに目印が付き、詳細にもバッジが出る", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(navItem(t("helpRunTitle"))).toHaveTextContent(t("helpImpactWrites"));
    expect(navItem(t("helpDryRunTitle"))).not.toHaveTextContent(t("helpImpactWrites"));
    expect(within(screen.getByTestId("help-detail")).getByText(t("helpImpactWrites"))).toBeInTheDocument();
    fireEvent.click(navItem(t("helpExplainTitle")));
    expect(within(screen.getByTestId("help-detail")).getByText(t("helpImpactReadOnly"))).toBeInTheDocument();
  });

  it("前へ / 次へで目次順に移動できる", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.queryByTestId("help-prev")).toBeNull();
    fireEvent.click(screen.getByTestId("help-next"));
    expect(detailHeading()).toHaveTextContent(t("helpDryRunTitle"));
    fireEvent.click(screen.getByTestId("help-prev"));
    expect(detailHeading()).toHaveTextContent(t("helpRunTitle"));
  });

  it("目次で ↓ / ↑ キーを押すと選択が移る", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: t("helpTitle") });
    fireEvent.keyDown(nav, { key: "ArrowDown" });
    expect(detailHeading()).toHaveTextContent(t("helpDryRunTitle"));
    fireEvent.keyDown(nav, { key: "ArrowUp" });
    expect(detailHeading()).toHaveTextContent(t("helpRunTitle"));
  });

  it("検索欄で目次を絞り込み、表示中の項目が消えたら残った先頭を出す", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(t("helpSearchPlaceholder")), {
      target: { value: t("helpExplainTitle") },
    });
    const nav = screen.getByRole("navigation", { name: t("helpTitle") });
    expect(within(nav).queryByRole("button", { name: t("helpDryRunTitle") })).toBeNull();
    expect(detailHeading()).toHaveTextContent(t("helpExplainTitle"));
  });

  it("一致が無いと空表示になる", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(t("helpSearchPlaceholder")), {
      target: { value: "zzzz-no-such-entry" },
    });
    expect(screen.getAllByText(t("helpSearchNoMatch")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation", { name: t("helpTitle") })).toBeNull();
  });

  it("ショートカットはキーと説明の表で出る", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    fireEvent.click(navItem(t("helpSectionShortcuts")));
    expect(detailHeading()).toHaveTextContent(t("helpSectionShortcuts"));
    const tables = within(screen.getByTestId("help-detail")).getAllByRole("table");
    expect(tables.length).toBeGreaterThan(0);
    expect(screen.getByText(t("shortcutCatGlobal"))).toBeInTheDocument();
  });

  it("ショートカットの説明で検索すると、ショートカット表だけが残る", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(t("helpSearchPlaceholder")), {
      target: { value: t("helpShortcutRunDesc") },
    });
    expect(detailHeading()).toHaveTextContent(t("helpSectionShortcuts"));
    expect(screen.getAllByRole("row")).toHaveLength(1);
  });

  it("ツアー / ショートカット一覧ボタンがコールバックを呼ぶ", () => {
    const onStartTour = vi.fn();
    const onOpenCheatSheet = vi.fn();
    renderWithProviders(
      <HelpView onClose={() => {}} onStartTour={onStartTour} onOpenCheatSheet={onOpenCheatSheet} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("helpReplayTour") }));
    fireEvent.click(screen.getByRole("button", { name: t("helpOpenCheatSheet") }));
    expect(onStartTour).toHaveBeenCalledOnce();
    expect(onOpenCheatSheet).toHaveBeenCalledOnce();
  });

  it("『試す』ボタンは行き先を onOpenFeature へ渡し、未指定なら出さない (#1631)", () => {
    const { unmount } = renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.queryAllByTestId("help-try")).toHaveLength(0);
    unmount();
    const onOpenFeature = vi.fn();
    renderWithProviders(<HelpView onClose={() => {}} onOpenFeature={onOpenFeature} />);
    fireEvent.click(navItem(t("helpSqlLintTitle")));
    fireEvent.click(screen.getByRole("button", { name: t("helpTryAria", { title: t("helpSqlLintTitle") }) }));
    expect(onOpenFeature).toHaveBeenCalledWith({ kind: "settings", section: "settings-sec-sql-lint" });
    fireEvent.click(navItem(t("helpSchemaCompareTitle")));
    fireEvent.click(
      screen.getByRole("button", { name: t("helpTryAria", { title: t("helpSchemaCompareTitle") }) }),
    );
    expect(onOpenFeature).toHaveBeenLastCalledWith({ kind: "view", view: "compare" });
  });

  it("SSM 経路の項目が表示され、『試す』で新規接続フォームを開く (#1977)", () => {
    const onOpenFeature = vi.fn();
    renderWithProviders(<HelpView onClose={() => {}} onOpenFeature={onOpenFeature} />);
    expect(navItem(t("helpSsmTroubleTitle"))).toBeInTheDocument();
    fireEvent.click(navItem(t("helpSsmTitle")));
    fireEvent.click(screen.getByRole("button", { name: t("helpTryAria", { title: t("helpSsmTitle") }) }));
    expect(onOpenFeature).toHaveBeenCalledWith({ kind: "view", view: "newConnection" });
  });

  it("SSM トラブル項目には『試す』ボタンが無い (#1977)", () => {
    renderWithProviders(<HelpView onClose={() => {}} onOpenFeature={vi.fn()} />);
    fireEvent.click(navItem(t("helpSsmTroubleTitle")));
    expect(detailHeading()).toHaveTextContent(t("helpSsmTroubleTitle"));
    expect(screen.queryByTestId("help-try")).toBeNull();
  });
});
