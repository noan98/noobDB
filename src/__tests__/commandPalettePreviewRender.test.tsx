import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { CommandPalette } from "../components/CommandPalette";
import type { CommandItem } from "../components/commandPaletteSearch";
import { PREVIEW_DEBOUNCE_MS } from "../components/useCommandPreviewDetail";
import { api, type TableColumnInfo } from "../api/tauri";

const col = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: false,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

function items(run: { insert: () => void; open: () => void }): CommandItem[] {
  return [
    {
      id: "table:db\0order_items",
      group: "tables",
      label: "order_items",
      preview: { kind: "table", database: "db", table: "order_items", columns: ["id", "order_id"] },
      previewActions: [
        { kind: "insert", run: run.insert },
        { kind: "open", run: run.open },
      ],
      run: () => {},
    },
    {
      id: "table:db\0order_item_logs",
      group: "tables",
      label: "order_item_logs",
      preview: { kind: "table", database: "db", table: "order_item_logs", columns: ["log_id"] },
      run: () => {},
    },
    {
      id: "snippet:1",
      group: "snippets",
      label: "recent",
      preview: {
        kind: "snippet",
        name: "recent",
        sql: "SELECT * FROM t WHERE id = {{id}}",
        folder: null,
        tags: [],
        scope: { kind: "any" },
        scopeProfileName: null,
        driver: "mysql",
      },
      run: () => {},
    },
    {
      id: "history:0",
      group: "history",
      label: "SELECT 1",
      preview: {
        kind: "history",
        sql: "SELECT 1\nFROM dual",
        meta: {
          executedAt: "2026-01-01T00:00:00Z",
          elapsedMs: 12,
          rows: 1,
          rowsAffected: null,
          ok: true,
          error: null,
        },
        connectionName: "local",
        driver: "mysql",
      },
      run: () => {},
    },
    {
      id: "conn:1",
      group: "connections",
      label: "prod",
      preview: {
        kind: "connection",
        name: "prod",
        driver: "postgres",
        host: "db.example",
        port: 5432,
        database: "app",
        group: null,
        isProduction: true,
        readOnly: true,
        connected: false,
      },
      run: () => {},
    },
  ];
}

describe("CommandPalette プレビューペイン (#2425)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_DEBOUNCE_MS + 10);
    });
  };

  it("先頭候補は待たずに出る", () => {
    renderWithProviders(
      <CommandPalette items={items({ insert: vi.fn(), open: vi.fn() })} onClose={() => {}} />,
    );
    const pane = screen.getByTestId("cmdk-preview");
    expect(pane).toHaveTextContent("prod");
    expect(pane).toHaveTextContent("db.example:5432");
  });

  it("移動が速いあいだは描画を間引き、止まってから追従する", async () => {
    renderWithProviders(
      <CommandPalette items={items({ insert: vi.fn(), open: vi.fn() })} onClose={() => {}} />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // 止まるまでは先頭 (接続) のまま。
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("db.example");
    await settle();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("log_id");
  });

  it("テーブル詳細は止まった候補だけ 1 回取得し、戻ってもキャッシュを使う", async () => {
    const loader = vi.fn(async (_db: string, table: string) => ({
      columns: [
        col("id", { key: "PRI", data_type: "bigint" }),
        col("order_id", { referenced_table: "orders", referenced_column: "id" }),
      ],
      rowEstimate: table === "order_items" ? 1200 : null,
    }));
    renderWithProviders(
      <CommandPalette
        items={items({ insert: vi.fn(), open: vi.fn() })}
        onClose={() => {}}
        loadTableDetail={loader}
      />,
    );
    const input = screen.getByRole("combobox");
    // 接続 (テーブルではない) の間は取得しない。
    await settle();
    expect(loader).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("~1.2K");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("bigint");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("PK");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("orders.id");

    // 素早く 2 回動かして元に戻る: 通過した候補は取得しない。
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await settle();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("取得に失敗しても列名は残り、案内を出す", async () => {
    const loader = vi.fn(async () => {
      throw new Error("x");
    });
    renderWithProviders(
      <CommandPalette
        items={items({ insert: vi.fn(), open: vi.fn() })}
        onClose={() => {}}
        loadTableDetail={loader}
      />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await settle();
    expect(screen.getByTestId("cmdk-preview-detail-error")).toBeInTheDocument();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("order_id");
  });

  it("スニペットは本文とプレースホルダ、履歴は全文と実行メタ、接続はバッジを出す", async () => {
    renderWithProviders(
      <CommandPalette items={items({ insert: vi.fn(), open: vi.fn() })} onClose={() => {}} />,
    );
    const input = screen.getByRole("combobox");
    // 表示順: 接続 → テーブル → スニペット → 履歴
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await settle();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("{{id}}");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await settle();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("dual");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("12 ms");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("local");
    fireEvent.keyDown(input, { key: "Home", ctrlKey: true });
    await settle();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("db.example:5432");
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("POSTGRES");
  });

  it("Tab でプレビューのアクションへ移り、Enter で実行してパレットを閉じる", async () => {
    const insert = vi.fn();
    const open = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette items={items({ insert, open })} onClose={onClose} />);
    const input = screen.getByRole("combobox");
    // 接続の次がテーブル (order_items)。
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // デバウンス待ちのまま Tab: 追いつかせてから移る。
    fireEvent.keyDown(input, { key: "Tab" });
    await settle();
    const [insertBtn] = screen.getAllByRole("button", { name: /エディタへ挿入|Insert into editor/ });
    expect(document.activeElement).toBe(insertBtn);
    fireEvent.click(insertBtn);
    expect(onClose).toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("アクションを持たない候補では Tab は従来どおり候補を進める", () => {
    renderWithProviders(
      <CommandPalette items={items({ insert: vi.fn(), open: vi.fn() })} onClose={() => {}} />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  });

  it("プレビューを持つ候補が無いときはペインを出さない", () => {
    renderWithProviders(
      <CommandPalette
        items={[{ id: "a", group: "navigation", label: "x", run: () => {} }]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("cmdk-preview")).toBeNull();
  });

  it("loader を渡さなければ、テーブル候補に置いても describeTable / tableRowEstimate を呼ばず列名だけを出す", async () => {
    const describe = vi.spyOn(api, "describeTable");
    const estimate = vi.spyOn(api, "tableRowEstimate");
    renderWithProviders(
      <CommandPalette items={items({ insert: vi.fn(), open: vi.fn() })} onClose={() => {}} />,
    );
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await settle();
    expect(screen.getByTestId("cmdk-preview")).toHaveTextContent("order_id");
    expect(describe).not.toHaveBeenCalled();
    expect(estimate).not.toHaveBeenCalled();
    describe.mockRestore();
    estimate.mockRestore();
  });
});
