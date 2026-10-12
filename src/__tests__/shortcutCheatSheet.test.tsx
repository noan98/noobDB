import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, within } from "./testUtils";
import { t } from "../i18n";
import { ShortcutCheatSheet } from "../components/ShortcutCheatSheet";
import { SHORTCUT_CATEGORY_LABEL, SHORTCUTS } from "../shortcuts";

/**
 * ショートカット チートシートの検索と再割り当て導線 (#1540)。表示順は
 * カテゴリ順のまま、検索で行が絞られ、再割り当て可能な行から設定へ移れる。
 */
describe("ShortcutCheatSheet (#1540)", () => {
  it("検索欄で表示名に絞り込め、カテゴリ見出しも一致のあるものだけ残る", () => {
    renderWithProviders(<ShortcutCheatSheet onClose={() => {}} />);
    const all = screen.getAllByText(t(SHORTCUT_CATEGORY_LABEL.global));
    expect(all.length).toBeGreaterThan(0);
    fireEvent.change(screen.getByTestId("cheat-sheet-search"), {
      target: { value: t("shortcutExplainDesc").slice(0, 6) },
    });
    expect(screen.getByText(t("shortcutExplainDesc"))).toBeInTheDocument();
    // エディタ以外のカテゴリ見出しは消える。
    expect(screen.queryByText(t(SHORTCUT_CATEGORY_LABEL.tabs))).toBeNull();
  });

  it("一致が無いと案内を出す", () => {
    renderWithProviders(<ShortcutCheatSheet onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("cheat-sheet-search"), {
      target: { value: "このショートカットは存在しない zzz" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(t("cheatSheetNoMatches"));
  });

  it("onRebind を渡すと再割り当て可能な行だけに変更ボタンが出て、押すと呼ばれる", () => {
    const onRebind = vi.fn();
    renderWithProviders(<ShortcutCheatSheet onClose={() => {}} onRebind={onRebind} />);
    const rebindable = SHORTCUTS.filter((s) => s.id !== undefined);
    const buttons = screen.getAllByRole("button", {
      name: new RegExp(t("cheatSheetRebindFor", { action: "" }).slice(0, 4)),
    });
    expect(buttons).toHaveLength(rebindable.length);
    const target = rebindable[0];
    fireEvent.click(
      within(document.body).getByRole("button", {
        name: t("cheatSheetRebindFor", { action: t(target.descKey) }),
      }),
    );
    expect(onRebind).toHaveBeenCalledTimes(1);
  });

  it("onRebind が無ければ変更ボタンは出ない", () => {
    renderWithProviders(<ShortcutCheatSheet onClose={() => {}} />);
    expect(screen.queryAllByRole("button", { name: /変更|Change the shortcut/ })).toHaveLength(0);
  });
});
