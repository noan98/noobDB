import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * ER 図 (#560) の失敗表示統一 (#848)。グラフ取得失敗時、裸の赤テキストではなく
 * 共有 `EmptyState` (タイトル + 再取得ボタン) で図の描画領域全体を置き換え、
 * ボタンで再取得できることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      describeDatabase: vi.fn(),
      foreignKeys: vi.fn().mockResolvedValue([]),
    },
  };
});

import { ERDiagramView } from "../components/ERDiagramView";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ERDiagramView error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.describeDatabase).mockRejectedValueOnce(new Error("no such table"));

    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(t("erDiagramError", { error: "Error: no such table" }))).toBeInTheDocument();
    });
    expect(api.describeDatabase).toHaveBeenCalledTimes(1);

    vi.mocked(api.describeDatabase).mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole("button", { name: t("erDiagramRetry") }));

    await waitFor(() => {
      expect(api.describeDatabase).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText(t("erDiagramEmpty"))).toBeInTheDocument();
    });
  });
});

describe("ERDiagramView フォーカス (#1540)", () => {
  const tb = (name: string) => ({
    name,
    columns: [
      {
        name: "id",
        data_type: "int",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
  });
  const fkRow = (table: string, ref: string) => ({
    table,
    column: "id",
    referenced_table: ref,
    referenced_column: "id",
    constraint_name: `${table}_${ref}`,
  });

  it("テーブルを選ぶとその近傍だけの図になり、「データベース全体」で戻る", async () => {
    // jsdom に無い ResizeObserver (React Flow が使う) の最小スタブ。
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.mocked(api.describeDatabase).mockResolvedValueOnce(["a", "b", "c", "d"].map(tb) as never);
    vi.mocked(api.foreignKeys).mockResolvedValueOnce([
      fkRow("a", "b"),
      fkRow("b", "c"),
      fkRow("c", "d"),
    ] as never);
    renderWithProviders(
      <ERDiagramView
        sessionId="s1"
        driver="mysql"
        initialDatabase="appdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 4, relationships: 3 })),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(t("erDiagramFocus")), { target: { value: "a" } });
    // 1 ホップ: a と b だけ。
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 2, relationships: 1 })),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("erDiagramFocusHops")), { target: { value: "2" } });
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 3, relationships: 2 })),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(t("erDiagramFocus")), { target: { value: "" } });
    expect(
      await screen.findByText(t("erDiagramSummary", { tables: 4, relationships: 3 })),
    ).toBeInTheDocument();
    // フォーカスの切り替えで DB を取り直さない。
    expect(api.describeDatabase).toHaveBeenCalledTimes(1);
  });
});
