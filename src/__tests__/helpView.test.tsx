import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("HelpView 節ナビ・検索・導線 (#1273 / #1274)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("検索欄でカードを絞り込める", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    expect(screen.getByText(t("helpDryRunTitle"))).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(t("helpSearchPlaceholder")), {
      target: { value: t("helpExplainTitle") },
    });
    expect(screen.getAllByText(t("helpExplainTitle")).length).toBeGreaterThan(0);
    expect(screen.queryByText(t("helpDryRunTitle"))).toBeNull();
  });

  it("一致が無いと空表示になる", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(t("helpSearchPlaceholder")), {
      target: { value: "zzzz-no-such-entry" },
    });
    expect(screen.getByText(t("helpSearchNoMatch"))).toBeInTheDocument();
  });

  it("節ボタンのクリックで該当節へスクロールする", () => {
    renderWithProviders(<HelpView onClose={() => {}} />);
    const nav = screen.getByRole("navigation", { name: t("helpTitle") });
    fireEvent.click(within(nav).getByRole("button", { name: t("helpSectionGuards") }));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
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
});
