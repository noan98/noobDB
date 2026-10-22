import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

/** About ダイアログ (#1770): バージョン表示・リンクは Rust コマンド経由・再生・閉じる。 */
const getVersion = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/app", () => ({ getVersion }));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, openProjectLink: vi.fn().mockResolvedValue(undefined) } };
});

import { AboutDialog } from "../components/AboutDialog";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  getVersion.mockResolvedValue("1.2.3");
  document.documentElement.removeAttribute("data-theme");
});

describe("AboutDialog (#1770)", () => {
  it("バージョンとタグラインを表示する", async () => {
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("about-version").textContent).toBe(t("aboutVersion", { version: "1.2.3" })),
    );
    expect(screen.getByText(t("splashTagline"))).toBeTruthy();
  });

  it("バージョン取得に失敗したら「バージョン不明」を出す", async () => {
    getVersion.mockRejectedValue(new Error("boom"));
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("about-version").textContent).toBe(t("aboutVersionUnknown")),
    );
  });

  it("リポジトリ / ドキュメントは openProjectLink に種類だけ渡す", () => {
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("aboutRepository") }));
    fireEvent.click(screen.getByRole("button", { name: t("aboutDocs") }));
    expect(api.openProjectLink).toHaveBeenNthCalledWith(1, "repository");
    expect(api.openProjectLink).toHaveBeenNthCalledWith(2, "docs");
  });

  it("再生ボタンでロゴが再マウント (新しい DOM ノード) される", () => {
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    const before = document.querySelector(".brand-mark-anim");
    expect(before).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("aboutReplay") }));
    const after = document.querySelector(".brand-mark-anim");
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  });

  it("hc-* テーマではアニメが再生されないので再生ボタンを出さない", () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    renderWithProviders(<AboutDialog onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: t("aboutReplay") })).toBeNull();
  });

  it("閉じるで onClose", () => {
    const onClose = vi.fn();
    renderWithProviders(<AboutDialog onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("button", { name: t("aboutClose") }).at(-1) as HTMLElement);
    expect(onClose).toHaveBeenCalled();
  });
});
