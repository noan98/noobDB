import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { SchemaCompareView } from "../components/SchemaCompareView";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * スキーマ / データ比較ビュー (#604)。マウント時に Tauri 呼び出しを持たない
 * (接続 / 比較はユーザ操作時のみ)。プロファイル一覧を与えて例外なくマウントでき、
 * タイトルが可視であること・閉じるボタンで `onClose` が呼ばれることを固定する。
 */
const PROFILES = [
  makeProfile({ id: "p-a", name: "Alpha" }),
  makeProfile({ id: "p-b", name: "Beta" }),
];

describe("SchemaCompareView render smoke (#604)", () => {
  it("mounts with a profile list and shows the compare title", () => {
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={() => {}} />);
    expect(screen.getByText(t("schemaCompareTitle"))).toBeInTheDocument();
  });

  it("mounts with an empty profile list without throwing", () => {
    renderWithProviders(<SchemaCompareView profiles={[]} onClose={() => {}} />);
    expect(screen.getByText(t("schemaCompareTitle"))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<SchemaCompareView profiles={PROFILES} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("schemaCompareClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
