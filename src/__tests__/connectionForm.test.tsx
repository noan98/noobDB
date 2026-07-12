import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { ConnectionForm } from "../components/ConnectionForm";
import { t } from "../i18n";

/**
 * 接続フォーム (#604)。マウント時に Tauri 呼び出しを持たない (テスト接続 / 保存は
 * ボタン押下時のみ)。新規作成時に例外なくマウントでき、保存 / テスト / キャンセルの
 * 主要ボタンが可視であること・キャンセルで `onCancel` が呼ばれることを固定する。
 */
describe("ConnectionForm render smoke (#604)", () => {
  it("mounts for a new profile and shows the primary action buttons", () => {
    renderWithProviders(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: t("formSave") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formTest") })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("formCancel") })).toBeInTheDocument();
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <ConnectionForm
        initial={null}
        profiles={[]}
        onSaved={() => {}}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("formCancel") }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
