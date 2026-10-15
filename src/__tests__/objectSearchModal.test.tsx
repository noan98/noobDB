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
      <ObjectSearchModal sessionId="s1" currentDatabase="testdb" onOpenTable={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument();
    });
  });

  it("shows the no-results EmptyState title once a query matches nothing", async () => {
    renderWithProviders(
      <ObjectSearchModal sessionId="s1" currentDatabase="testdb" onOpenTable={() => {}} onClose={() => {}} />,
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
      <ObjectSearchModal sessionId="s1" currentDatabase="testdb" onOpenTable={() => {}} onClose={() => {}} />,
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

describe("ObjectSearchModal combobox a11y (#1529)", () => {
  it("入力欄の aria-activedescendant が、ハイライト中の候補 (role=option) の id を指す", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    renderWithProviders(
      <ObjectSearchModal sessionId="s1" currentDatabase="testdb" onOpenTable={() => {}} onClose={() => {}} />,
    );
    const input = screen.getByPlaceholderText(t("objSearchPlaceholder"));
    expect(input).not.toHaveAttribute("aria-activedescendant");

    fireEvent.change(input, { target: { value: "users" } });
    const option = (await screen.findAllByRole("option"))[0];
    expect(option.id).toBeTruthy();
    expect(input).toHaveAttribute("aria-activedescendant", option.id);
  });
});

describe("ObjectSearchModal Enter 判定 (#1604)", () => {
  const setup = () => {
    const onOpenTable = vi.fn();
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={onOpenTable}
        onClose={() => {}}
      />,
    );
    return { onOpenTable, input: screen.getByPlaceholderText(t("objSearchPlaceholder")) };
  };

  it("IME 変換確定の Enter ではテーブルを開かない", async () => {
    const { onOpenTable, input } = setup();
    fireEvent.change(input, { target: { value: "users" } });
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onOpenTable).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).toHaveBeenCalledWith("testdb", "users");
  });

  it("入力が結果より先へ進んだ間 (古い結果) の Enter では開かない", async () => {
    const { onOpenTable, input } = setup();
    fireEvent.change(input, { target: { value: "users" } });
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());
    // 追記した直後は users の結果が残っているが、対応するのは前の語。
    fireEvent.change(input, { target: { value: "usersx" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).not.toHaveBeenCalled();
  });
});

describe("ObjectSearchModal ビュー・ルーチン・列ジャンプ・行数 (#1629)", () => {
  const hits: ObjectSearchHit[] = [
    { kind: "table", database: "testdb", table: "users", row_estimate: 120000 },
    { kind: "view", database: "testdb", table: "v_users", object_kind: "view" },
    { kind: "routine", database: "testdb", table: "calc_users", object_kind: "function", object_id: "42" },
    { kind: "trigger", database: "testdb", table: "trg_users", object_kind: "trigger" },
    { kind: "column", database: "testdb", table: "users", column: "user_name" },
  ];
  const setup = async (extra: { onOpenObject?: (...a: unknown[]) => void } = {}) => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(api.searchSchemaObjects).mockImplementation(async (params: { query: string }) =>
      params.query.trim() ? hits : [],
    );
    const onOpenTable = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <ObjectSearchModal
        sessionId="s1"
        currentDatabase="testdb"
        onOpenTable={onOpenTable}
        onClose={onClose}
        {...extra}
      />,
    );
    await waitFor(() => expect(screen.getByText(t("objSearchHint"))).toBeInTheDocument());
    const input = screen.getByPlaceholderText(t("objSearchPlaceholder"));
    fireEvent.change(input, { target: { value: "user" } });
    await waitFor(() => expect(screen.getAllByRole("option").length).toBe(hits.length));
    return { input, onOpenTable, onClose };
  };

  it("テーブルの行に行数の目安が付く (ビューや列には付かない)", async () => {
    await setup();
    expect(screen.getByText("~120K")).toBeInTheDocument();
    expect(screen.getAllByText(/^~/)).toHaveLength(1);
  });

  it("ビュー / ルーチン / トリガーには種別が添えられる", async () => {
    await setup();
    expect(screen.getByText(`testdb · ${t("objSearchKind_view")}`)).toBeInTheDocument();
    expect(screen.getByText(`testdb · ${t("objSearchKind_function")}`)).toBeInTheDocument();
    expect(screen.getByText(`testdb · ${t("objSearchKind_trigger")}`)).toBeInTheDocument();
  });

  it("ビューはテーブルと同じようにデータを開く", async () => {
    const { input, onOpenTable } = await setup();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).toHaveBeenCalledWith("testdb", "v_users");
  });

  it("ルーチンは定義を開き、id も渡す", async () => {
    const onOpenObject = vi.fn();
    const { input, onOpenTable, onClose } = await setup({ onOpenObject });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenObject).toHaveBeenCalledWith("testdb", "function", "calc_users", "42");
    expect(onOpenTable).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("onOpenObject が無ければルーチンは開けず、閉じもしない", async () => {
    const { input, onOpenTable, onClose } = await setup();
    for (let i = 0; i < 2; i++) fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("列ヒットはテーブルを開いて列を伝える", async () => {
    const { input, onOpenTable } = await setup();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenTable).toHaveBeenCalledWith("testdb", "users", { column: "user_name" });
  });

  it("Shift+Enter は新しいタブで開く (列ヒットでも列を伝える)", async () => {
    const { input, onOpenTable } = await setup();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onOpenTable).toHaveBeenLastCalledWith("testdb", "users", { newTab: true });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onOpenTable).toHaveBeenLastCalledWith("testdb", "users", { column: "user_name", newTab: true });
  });

  it("Shift+クリックも新しいタブで開く", async () => {
    const { onOpenTable } = await setup();
    fireEvent.click(screen.getAllByRole("option")[1], { shiftKey: true });
    expect(onOpenTable).toHaveBeenCalledWith("testdb", "v_users", { newTab: true });
  });
});
