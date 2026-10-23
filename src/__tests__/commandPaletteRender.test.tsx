import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { CommandPalette } from "../components/CommandPalette";
import type { CommandItem } from "../components/commandPaletteSearch";

/** コマンドパレットの大規模スキーマ対策 (#1320): 件数上限・さらに表示・キーボード操作。 */
function tables(n: number, run = () => {}): CommandItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    group: "tables" as const,
    label: `table_${i}`,
    run,
  }));
}

describe("CommandPalette 大規模候補 (#1320)", () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => {
    scrollIntoView.mockClear();
    // jsdom には scrollIntoView が無い。
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  it("↓ でアクティブ行へ scrollIntoView で追従する", () => {
    renderWithProviders(<CommandPalette items={tables(30)} onClose={() => {}} />);
    scrollIntoView.mockClear();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("空クエリでは多数のテーブルを一部だけ描画し、「さらに表示」で展開する", async () => {
    renderWithProviders(<CommandPalette items={tables(100)} onClose={() => {}} />);
    expect(screen.getAllByRole("option")).toHaveLength(8);
    fireEvent.click(await screen.findByRole("button", { name: /92/ }));
    expect(screen.getAllByRole("option")).toHaveLength(100);
  });

  it("↑↓ でアクティブ行が移動し、Enter で選択した候補を実行して閉じる", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<CommandPalette items={tables(30, run)} onClose={onClose} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it("末尾で ↓ を押すと隠れた候補が展開されて次の行へ進む", () => {
    renderWithProviders(<CommandPalette items={tables(30)} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "End", ctrlKey: true });
    expect(screen.getAllByRole("option")).toHaveLength(8);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const opts = screen.getAllByRole("option");
    expect(opts).toHaveLength(30);
    expect(opts[8]).toHaveAttribute("aria-selected", "true");
  });

  it("Home / End は入力欄のカーソル移動に任せ、候補は動かさない (Ctrl+Home / End で先頭・末尾)", () => {
    renderWithProviders(<CommandPalette items={tables(30)} onClose={() => {}} />);
    const input = screen.getByRole("combobox");
    // preventDefault されなければ fireEvent は true を返す (= ブラウザ既定のカーソル移動が走る)。
    expect(fireEvent.keyDown(input, { key: "End" })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Home" })).toBe(true);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    expect(fireEvent.keyDown(input, { key: "End", ctrlKey: true })).toBe(false);
    expect(screen.getAllByRole("option")[7]).toHaveAttribute("aria-selected", "true");
    expect(fireEvent.keyDown(input, { key: "Home", ctrlKey: true })).toBe(false);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("入力すると絞り込まれ、先頭が選択される", async () => {
    renderWithProviders(<CommandPalette items={tables(300)} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "table_299" } });
    const opts = await screen.findAllByRole("option");
    expect(opts[0]).toHaveTextContent("table_299");
    expect(opts[0]).toHaveAttribute("aria-selected", "true");
  });
});

describe("CommandPalette 無効な候補 (#1617)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("理由を行に出し、選択しても実行せずパレットも閉じない", () => {
    const run = vi.fn();
    const onClose = vi.fn();
    const items: CommandItem[] = [
      { id: "editor:run", group: "navigation", label: "Run", disabledReason: "接続してから実行", run },
    ];
    renderWithProviders(<CommandPalette items={items} onClose={onClose} />);
    expect(screen.getByTestId("cmdk-disabled-reason").textContent).toBe("接続してから実行");
    expect(screen.getByRole("option")).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    fireEvent.click(screen.getByRole("option"));
    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
