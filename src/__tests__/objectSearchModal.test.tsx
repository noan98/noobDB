import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { ObjectSearchHit } from "../api/tauri";

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
      // 検索は Rust 側 (#1261)。空クエリはウォームアップ (結果なし)、それ以外は "users" だけ
      // が一致する想定の固定応答を返す。
      searchSchemaObjects: vi.fn(async (params: { query: string }) =>
        params.query.trim().toLowerCase() === "users"
          ? ([{ kind: "table", database: "testdb", table: "users" }] as ObjectSearchHit[])
          : ([] as ObjectSearchHit[]),
      ),
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
    // 最初の要求 (ウォームアップ = 索引の構築) を保留して、読み込み中の表示を見る。
    let resolve: (v: ObjectSearchHit[]) => void = () => {};
    vi.mocked(api.searchSchemaObjects).mockReturnValueOnce(
      new Promise<ObjectSearchHit[]>((r) => {
        resolve = r;
      }),
    );
    renderModal();

    expect(screen.getAllByTestId("search-skeleton-row").length).toBeGreaterThan(0);
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(t("objSearchHint"))).not.toBeInTheDocument();

    resolve([]);
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

describe("ObjectSearchModal backend search (#1261)", () => {
  const renderModal = (currentDatabase: string | null = "testdb") =>
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase={currentDatabase}
        onOpenTable={() => {}}
        onClose={() => {}}
      />,
    );

  it("warms the index with an empty query in the current-database scope on open", async () => {
    renderModal();
    await waitFor(() => {
      expect(api.searchSchemaObjects).toHaveBeenCalledWith({
        sessionId: "s1",
        scope: { kind: "current", database: "testdb" },
        query: "",
        limit: 300,
      });
    });
  });

  it("uses the all-databases scope when there is no current database", async () => {
    renderModal(null);
    await waitFor(() => {
      expect(api.searchSchemaObjects).toHaveBeenCalledWith(
        expect.objectContaining({ scope: { kind: "all" }, query: "" }),
      );
    });
  });

  it("debounces key input into a single backend request with the final text", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderModal();
    await waitFor(() => expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument());
    vi.mocked(api.searchSchemaObjects).mockClear();

    const input = screen.getByPlaceholderText(t("objSearchPlaceholder"));
    for (const v of ["u", "us", "use", "user", "users"]) {
      fireEvent.change(input, { target: { value: v } });
    }
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    const queries = vi.mocked(api.searchSchemaObjects).mock.calls.map(([p]) => p.query);
    expect(queries).toEqual(["users"]);
  });

  it("opens the table of the activated result", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onOpenTable = vi.fn();
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={onOpenTable}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument());
    const input = screen.getByPlaceholderText(t("objSearchPlaceholder"));
    fireEvent.change(input, { target: { value: "users" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(1));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).toHaveBeenCalledWith("testdb", "users");
  });

  it("shows the backend error", async () => {
    vi.mocked(api.searchSchemaObjects).mockRejectedValueOnce(new Error("boom"));
    renderModal();
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });
});
