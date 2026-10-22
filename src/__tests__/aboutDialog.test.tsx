import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

/** About ダイアログ (#1770): バージョン表示・リンクは Rust コマンド経由・閉じる。 */
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn().mockResolvedValue("1.2.3") }));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, openExternalUrl: vi.fn().mockResolvedValue(undefined) } };
});

import { AboutDialog, ABOUT_DOCS_URL, ABOUT_REPOSITORY_URL } from "../components/AboutDialog";
import { api } from "../api/tauri";

beforeEach(() => vi.clearAllMocks());

describe("AboutDialog (#1770)", () => {
  it("バージョンとタグラインを表示する", async () => {
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("about-version").textContent).toBe(t("aboutVersion", { version: "1.2.3" })),
    );
    expect(screen.getByText(t("splashTagline"))).toBeTruthy();
  });

  it("リポジトリ / ドキュメントは openExternalUrl 経由で開く", () => {
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("aboutRepository") }));
    fireEvent.click(screen.getByRole("button", { name: t("aboutDocs") }));
    expect(api.openExternalUrl).toHaveBeenNthCalledWith(1, ABOUT_REPOSITORY_URL);
    expect(api.openExternalUrl).toHaveBeenNthCalledWith(2, ABOUT_DOCS_URL);
  });

  it("再生ボタンでアニメーションを作り直し、閉じるで onClose", () => {
    const onClose = vi.fn();
    renderWithProviders(<AboutDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("aboutReplay") }));
    fireEvent.click(screen.getAllByRole("button", { name: t("aboutClose") }).at(-1) as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
