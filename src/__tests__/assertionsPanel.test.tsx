import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { Assertion } from "../api/tauri";

/**
 * データ品質アサーション (#742) ボトムパネルの初回ロード表示 (#1174)。
 *
 * `listAssertions` が返るまでの間は中央の bare Spinner ではなく、実データの表と
 * 同じ 5 列の骨格 (`SkeletonTableRows`) を出し、「アサーション無し」の空状態
 * (実データ 0 件の確定表示) を誤って出さないことを固定する (#1160 と同じ
 * loading 優先の分岐)。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listAssertions: vi.fn(),
    },
  };
});

import { AssertionsPanel } from "../components/AssertionsPanel";
import { api } from "../api/tauri";

function renderPanel() {
  return renderWithProviders(
    <AssertionsPanel
      sessionId="s1"
      driver="mysql"
      profile={null}
      database="app"
      queryTimeoutSecs={0}
      onOpenSql={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssertionsPanel 初回ロードのスケルトン (#1174)", () => {
  it("取得中は 5 列の表スケルトンを出し、完了後に実データ0件なら空状態に差し替わる", async () => {
    let resolveList: (list: Assertion[]) => void = () => {};
    const pending = new Promise<Assertion[]>((resolve) => {
      resolveList = resolve;
    });
    vi.mocked(api.listAssertions).mockReturnValueOnce(pending);

    const { container } = renderPanel();

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });
    expect(screen.queryByText(t("assertEmptyTitle"))).not.toBeInTheDocument();

    resolveList([]);

    await waitFor(() => {
      expect(screen.getByText(t("assertEmptyTitle"))).toBeInTheDocument();
    });
    expect(container.querySelector("tbody > tr")).toBeNull();
  });
});
