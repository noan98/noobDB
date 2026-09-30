import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableSchema } from "../api/tauri";

/**
 * スキーマ横断のグローバルオブジェクト検索 (#847)。未入力時のヒント / 入力あり
 * 検索一致なしの双方で、結果一覧領域全体が共有 `EmptyState` (illustration 付き)
 * に置き換わることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      schemaOverview: vi.fn().mockResolvedValue([
        { name: "users", columns: ["id", "name"] },
      ] as TableSchema[]),
    },
  };
});

import { api } from "../api/tauri";
import { ObjectSearchModal } from "../components/ObjectSearchModal";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ObjectSearchModal empty state (#847)", () => {
  it("shows the hint EmptyState title before the user types anything", async () => {
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument();
    });
  });

  it("shows the no-results EmptyState title once a query matches nothing", async () => {
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(t("objSearchPlaceholder")), {
      target: { value: "no-such-object" },
    });

    await waitFor(() => {
      expect(screen.getByText(t("objSearchNoResults"))).toBeInTheDocument();
    });
  });
});

describe("ObjectSearchModal skeleton + stagger (#1212)", () => {
  const renderModal = () =>
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );

  it("shows result-shaped skeleton rows while scanning, then swaps them for results", async () => {
    // jsdom には scrollIntoView が無い (アクティブ行の追従で呼ばれる)。
    Element.prototype.scrollIntoView = vi.fn();
    let resolve: (v: TableSchema[]) => void = () => {};
    vi.mocked(api.schemaOverview).mockReturnValueOnce(
      new Promise<TableSchema[]>((r) => {
        resolve = r;
      }),
    );
    renderModal();

    expect(screen.getAllByTestId("search-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(t("objSearchHint"))).not.toBeInTheDocument();

    resolve([{ name: "users", columns: ["id", "name"] } as unknown as TableSchema]);
    fireEvent.change(screen.getByPlaceholderText(t("objSearchPlaceholder")), {
      target: { value: "users" },
    });
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });
    expect(screen.queryAllByTestId("search-skeleton-row")).toHaveLength(0);
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "false");
  });
});
