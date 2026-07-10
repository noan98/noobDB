import { describe, it, expect, vi } from "vitest";
import { fireEvent, renderWithProviders } from "./testUtils";
import { WelcomeView } from "../components/WelcomeView";
import { t } from "../i18n";

/**
 * 初回起動ウェルカム画面 (#599)。プロファイル 0 件の未接続時にメインペインへ
 * 表示する主要導線カード (接続追加 / SQLite を開く / ツアー開始) を固定する。
 * SQLite カードはネイティブのファイル選択ダイアログ (`@tauri-apps/plugin-dialog`)
 * を開くため、jsdom 環境でクリックすると Tauri ランタイム不在で失敗しうる —
 * ここでは存在と役割 (button) だけを確認し、クリックの実駆動は行わない。
 * 文言はロケール非依存にするため `t(...)` 経由で参照する (テスト環境の既定
 * ロケールは "en")。
 */
describe("WelcomeView (#599)", () => {
  it("renders the welcome heading and all three primary action cards", () => {
    const { getByText, getByRole } = renderWithProviders(
      <WelcomeView
        onCreateConnection={() => {}}
        onOpenSqlite={() => {}}
        onStartTour={() => {}}
      />,
    );
    expect(getByText(t("welcomeTitle"))).toBeTruthy();
    expect(getByRole("button", { name: t("welcomeCreateConnectionTitle") })).toBeTruthy();
    expect(getByRole("button", { name: t("welcomeOpenSqliteTitle") })).toBeTruthy();
    expect(getByRole("button", { name: t("welcomeStartTourTitle") })).toBeTruthy();
  });

  it("invokes onCreateConnection when the connection card is activated", () => {
    const onCreateConnection = vi.fn();
    const { getByRole } = renderWithProviders(
      <WelcomeView
        onCreateConnection={onCreateConnection}
        onOpenSqlite={() => {}}
        onStartTour={() => {}}
      />,
    );
    fireEvent.click(getByRole("button", { name: t("welcomeCreateConnectionTitle") }));
    expect(onCreateConnection).toHaveBeenCalledOnce();
  });

  it("invokes onStartTour when the tour card is activated", () => {
    const onStartTour = vi.fn();
    const { getByRole } = renderWithProviders(
      <WelcomeView
        onCreateConnection={() => {}}
        onOpenSqlite={() => {}}
        onStartTour={onStartTour}
      />,
    );
    fireEvent.click(getByRole("button", { name: t("welcomeStartTourTitle") }));
    expect(onStartTour).toHaveBeenCalledOnce();
  });
});
