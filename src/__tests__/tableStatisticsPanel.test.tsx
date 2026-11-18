import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableStatistic } from "../api/tauri";

/**
 * テーブル/DB サイズ・構造統計ダッシュボード (#562/#660) の空状態統一 (#847)。
 * データベースにテーブルが 1 件もない真の空状態と、名前フィルタで 0 件になる
 * ケースの双方で、共有 `EmptyState` のタイトルが表示されることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      tableStatistics: vi.fn().mockResolvedValue([] as TableStatistic[]),
    },
  };
});

import { TableStatisticsPanel } from "../components/TableStatisticsPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TableStatisticsPanel empty state (#847)", () => {
  it("shows the shared EmptyState (illustration) title when the database has no tables", async () => {
    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(t("sizeEmpty"))).toBeInTheDocument();
    });
  });

  it("shows the shared compact EmptyState title when the name filter matches nothing", async () => {
    vi.mocked(api.tableStatistics).mockResolvedValueOnce([
      {
        name: "users",
        row_estimate: 10,
        data_bytes: 100,
        index_bytes: 10,
        total_bytes: 110,
        column_count: 1,
        index_count: 1,
        has_primary_key: true,
        foreign_key_count: 0,
        previous: null,
      },
    ]);

    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText("users")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByPlaceholderText(t("sizeFilterName")), {
      target: { value: "no-such-table" },
    });

    await waitFor(() => {
      expect(screen.getByText(t("sizeNoMatch"))).toBeInTheDocument();
    });
  });
});

/**
 * 取得失敗の共有イラスト + 再取得導線 (#848)。裸の赤テキストではなく共有
 * `EmptyState` (タイトル + 再取得ボタン) で表示され、ボタンで `api.tableStatistics`
 * (等) が再度呼ばれることを固定する。
 */
describe("TableStatisticsPanel error state (#848)", () => {
  it("shows the shared EmptyState title on load failure, and retries on click", async () => {
    vi.mocked(api.tableStatistics).mockRejectedValueOnce(new Error("connection refused"));

    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(t("sizeLoadError", { error: "Error: connection refused" })),
      ).toBeInTheDocument();
    });
    expect(api.tableStatistics).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("sizeRetry") }));

    await waitFor(() => {
      expect(api.tableStatistics).toHaveBeenCalledTimes(2);
    });
  });
});

/** 前回取得からの行数・サイズの増減 (#1621)。 */
describe("TableStatisticsPanel 前回取得からの増減 (#1621)", () => {
  it("行数と合計サイズの増減を表示し、前回値が無いテーブルには出さない", async () => {
    const base = {
      index_bytes: 0,
      column_count: 1,
      index_count: 1,
      has_primary_key: true,
      foreign_key_count: 0,
    };
    vi.mocked(api.tableStatistics).mockResolvedValueOnce([
      {
        ...base,
        name: "orders",
        row_estimate: 1500,
        data_bytes: 3 * 1024 * 1024,
        total_bytes: 3 * 1024 * 1024,
        previous: { at: "2026-01-01T00:00:00Z", row_estimate: 1000, total_bytes: 1024 * 1024 },
      },
      {
        ...base,
        name: "fresh",
        row_estimate: 5,
        data_bytes: 10,
        total_bytes: 10,
        previous: null,
      },
    ]);
    renderWithProviders(<TableStatisticsPanel sessionId="s1" database="testdb" onClose={() => {}} />);
    await screen.findByText("orders");
    const deltas = screen.getAllByTestId("stat-delta").map((d) => d.textContent);
    expect(deltas).toEqual(["+500", "+2.0 MB"]);
    expect(screen.getByText("fresh").closest("tr")?.querySelector("[data-testid=stat-delta]")).toBeNull();
  });
});

describe("TableStatisticsPanel treemap (#2408)", () => {
  const stat = (name: string, total: number | null): TableStatistic => ({
    name,
    row_estimate: 10,
    data_bytes: total == null ? null : Math.floor(total * 0.7),
    index_bytes: total == null ? null : Math.floor(total * 0.3),
    total_bytes: total,
    column_count: 1,
    index_count: 1,
    has_primary_key: true,
    foreign_key_count: 0,
    previous: null,
  });

  it("切り替えると同じフィルタでツリーマップを描き、クリックでテーブルを開く。サイズ不明は別枠", async () => {
    vi.mocked(api.tableStatistics).mockResolvedValueOnce([
      stat("users", 100000),
      stat("orders", 50000),
      stat("legacy", null),
    ]);
    const onOpen = vi.fn();
    renderWithProviders(
      <TableStatisticsPanel sessionId="s1" database="testdb" onOpenTable={onOpen} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("users")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: t("sizeViewTreemap") }));
    const tile = await waitFor(() => {
      const el = document.querySelector('[data-treemap-id="users"]');
      expect(el).not.toBeNull();
      return el as Element;
    });
    expect(tile.getAttribute("aria-label")).toContain("users");
    // サイズ不明の表はタイルにならず別枠のボタンになる。
    expect(document.querySelector('[data-treemap-id="legacy"]')).toBeNull();
    expect(screen.getByRole("button", { name: "legacy" })).toBeInTheDocument();

    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledWith("users");

    // 名前フィルタはツリーマップにも効く。
    fireEvent.change(screen.getByPlaceholderText(t("sizeFilterName")), { target: { value: "orders" } });
    await waitFor(() => expect(document.querySelector('[data-treemap-id="users"]')).toBeNull());
    expect(document.querySelector('[data-treemap-id="orders"]')).not.toBeNull();
  });

  const openTreemap = async (rows: TableStatistic[], onOpen = vi.fn()) => {
    vi.mocked(api.tableStatistics).mockResolvedValueOnce(rows);
    renderWithProviders(
      <TableStatisticsPanel sessionId="s1" database="testdb" onOpenTable={onOpen} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getAllByText(rows[0].name).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("radio", { name: t("sizeViewTreemap") }));
    await waitFor(() => expect(document.querySelector("[data-treemap-id]")).not.toBeNull());
    return onOpen;
  };
  const tileEl = (id: string) => document.querySelector(`[data-treemap-id="${id}"]`) as SVGGElement;
  const activeId = () => document.activeElement?.getAttribute("data-treemap-id");

  it("矢印キーでタイル間のフォーカスが動く", async () => {
    await openTreemap([stat("big", 100000), stat("small", 20000)]);
    const big = tileEl("big");
    big.focus();
    expect(activeId()).toBe("big");
    // 2 枚の配置は横並びか縦並び。いずれかの矢印で他方へ移り、逆向きで戻る。
    const pairs: Array<[string, string]> = [
      ["ArrowRight", "ArrowLeft"],
      ["ArrowDown", "ArrowUp"],
    ];
    let moved = false;
    for (const [fwd, back] of pairs) {
      fireEvent.keyDown(tileEl("big"), { key: fwd });
      if (activeId() === "small") {
        moved = true;
        fireEvent.keyDown(tileEl("small"), { key: back });
        expect(activeId()).toBe("big");
        break;
      }
    }
    expect(moved).toBe(true);
  });

  it("Enter / Space でテーブルを開く", async () => {
    const onOpen = await openTreemap([stat("big", 100000), stat("small", 20000)]);
    fireEvent.keyDown(tileEl("big"), { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("big");
    fireEvent.keyDown(tileEl("small"), { key: " " });
    expect(onOpen).toHaveBeenLastCalledWith("small");
  });

  it("「その他」タイルはクリックしても開かない", async () => {
    const tiny = Array.from({ length: 5 }, (_, i) => stat(`tiny${i}`, 10));
    const onOpen = await openTreemap([stat("huge", 10_000_000), ...tiny]);
    const other = document.querySelector("[data-treemap-other]");
    expect(other).not.toBeNull();
    fireEvent.click(other as Element);
    fireEvent.keyDown(other as Element, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("「その他」タイルへ矢印キーでフォーカスでき、DOM 属性に制御文字を含まない", async () => {
    const tiny = Array.from({ length: 5 }, (_, i) => stat(`tiny${i}`, 10));
    await openTreemap([stat("huge", 10_000_000), ...tiny]);
    // 属性に XML で不正な制御文字が無い (画像書き出しが壊れない)。
    for (const el of Array.from(document.querySelectorAll("[data-treemap-idx]"))) {
      for (const a of Array.from(el.attributes)) {
        expect(a.value).not.toMatch(/[\u0000-\u001f]/);
      }
    }
    const other = document.querySelector("[data-treemap-other]") as SVGGElement;
    tileEl("huge").focus();
    let reached = false;
    for (const key of ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"]) {
      fireEvent.keyDown(tileEl("huge"), { key });
      if (document.activeElement === other) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
  });

  it("「肥大のみ」はツリーマップにも効き、dead_rows が無い DB ではチェックボックスを出さない", async () => {
    const bloated = { ...stat("bloat", 100000), dead_rows: 5000, row_estimate: 1000 };
    const clean = { ...stat("clean", 100000), dead_rows: 0, row_estimate: 1000 };
    await openTreemap([bloated, clean]);
    expect(tileEl("clean")).not.toBeNull();
    fireEvent.click(screen.getByLabelText(t("sizeFilterBloated")));
    await waitFor(() => expect(document.querySelector('[data-treemap-id="clean"]')).toBeNull());
    expect(tileEl("bloat")).not.toBeNull();
  });

  it("dead_rows が全行 null (MySQL / SQLite) なら「肥大のみ」を出さない", async () => {
    await openTreemap([stat("a", 100000), stat("b", 50000)]);
    expect(screen.queryByLabelText(t("sizeFilterBloated"))).toBeNull();
  });
});
