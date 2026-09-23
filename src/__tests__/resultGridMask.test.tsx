import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { setLocale, t } from "../i18n";
import {
  setColumnMaskCopyPlaceholder,
  setColumnMaskEnabled,
  setColumnMaskPatterns,
} from "../settings";
import { DEFAULT_MASK_PATTERNS, MASK_PLACEHOLDER, REVEAL_TIMEOUT_MS } from "../components/columnMask";

// 結果グリッドの機微カラム表示マスク (#1069) の UI 結線。
// 判定そのものは `columnMask.test.ts` が固定し、ここは「表示・コピー・reveal・
// ヘッダメニュー・編集ブロック」がグリッドに正しく結線されていることを見る。

vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.csv"),
}));

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "user_email", type_name: "VARCHAR" },
];

const RESULT = makeResult(COLUMNS, [
  [1, "alice", "alice@example.com"],
  [2, "bob", "bob@example.com"],
]);

const TABLE_COLUMNS: TableColumnInfo[] = COLUMNS.map((c, i) => ({
  name: c.name,
  data_type: c.type_name.toLowerCase(),
  nullable: i !== 0,
  key: i === 0 ? "PRI" : "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
}));

function dataCells(container: HTMLElement): HTMLElement[][] {
  return Array.from(container.querySelectorAll("tbody tr")).map(
    (tr) => Array.from(tr.querySelectorAll("td[role='gridcell']")) as HTMLElement[],
  );
}

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    writable: true,
    configurable: true,
  });
  return writeText;
}

describe("ResultGrid の機微カラム表示マスク (#1069)", () => {
  beforeEach(() => {
    setLocale("en");
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(DEFAULT_MASK_PATTERNS);
    setColumnMaskCopyPlaceholder(true);
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(DEFAULT_MASK_PATTERNS);
    setColumnMaskCopyPlaceholder(true);
  });

  it("既定パターンに一致する列を伏せ字で表示し、他の列はそのまま", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const cells = dataCells(container);
    expect(cells[0][1].textContent).toBe("alice");
    expect(cells[0][2].textContent).toBe(MASK_PLACEHOLDER);
    expect(cells[1][2].textContent).toBe(MASK_PLACEHOLDER);
    expect(container.textContent).not.toContain("alice@example.com");
    // ヘッダにマスク中の目印が出る。
    expect(screen.getAllByLabelText(t("gridMaskColumnIndicator")).length).toBeGreaterThan(0);
  });

  it("機能をオフにすると何もマスクしない", () => {
    setColumnMaskEnabled(false);
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    expect(dataCells(container)[0][2].textContent).toBe("alice@example.com");
  });

  it("マスク中のセルのコピーは伏せ字、設定オフなら実値", async () => {
    const writeText = mockClipboard();
    const { container, unmount } = renderWithProviders(<ResultGrid result={RESULT} />);
    let cells = dataCells(container);
    fireEvent.focus(cells[0][2]);
    fireEvent.keyDown(cells[0][2], { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MASK_PLACEHOLDER));
    unmount();

    setColumnMaskCopyPlaceholder(false);
    writeText.mockClear();
    const second = renderWithProviders(<ResultGrid result={RESULT} />);
    cells = dataCells(second.container);
    fireEvent.focus(cells[0][2]);
    fireEvent.keyDown(cells[0][2], { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("alice@example.com"));
  });

  it("行の TSV コピーでもマスク列だけ伏せ字になる", async () => {
    const writeText = mockClipboard();
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cells[0][1], { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cells[0][2], { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`1\talice\t${MASK_PLACEHOLDER}`));
  });

  it("右クリックでセルを一時表示し、タイムアウトで再マスクする", async () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    fireEvent.contextMenu(dataCells(container)[0][2]);
    const item = await screen.findByRole("menuitem", {
      name: t("gridMaskRevealCell", { secs: REVEAL_TIMEOUT_MS / 1000 }),
    });
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(item);
    });
    // そのセルだけ実値。同じ列の別の行はマスクのまま。
    expect(dataCells(container)[0][2].textContent).toBe("alice@example.com");
    expect(dataCells(container)[1][2].textContent).toBe(MASK_PLACEHOLDER);
    act(() => void vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(dataCells(container)[0][2].textContent).toBe(MASK_PLACEHOLDER);
  });

  it("列の一時表示はウィンドウのフォーカス喪失で再マスクする", async () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    fireEvent.contextMenu(dataCells(container)[1][2]);
    const item = await screen.findByRole("menuitem", {
      name: t("gridMaskRevealColumn", { secs: REVEAL_TIMEOUT_MS / 1000 }),
    });
    await act(async () => {
      fireEvent.click(item);
    });
    expect(dataCells(container)[0][2].textContent).toBe("alice@example.com");
    expect(dataCells(container)[1][2].textContent).toBe("bob@example.com");
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(dataCells(container)[0][2].textContent).toBe(MASK_PLACEHOLDER);
  });

  it("ヘッダメニューから列単位でマスクを ON/OFF できる", async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    await user.click(screen.getByRole("button", { name: t("gridFilterAria", { column: "name" }) }));
    await user.click(await screen.findByRole("button", { name: t("gridMaskColumnOn") }));
    expect(dataCells(container)[0][1].textContent).toBe(MASK_PLACEHOLDER);

    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column: "user_email" }) }),
    );
    await user.click(await screen.findByRole("button", { name: t("gridMaskColumnOff") }));
    expect(dataCells(container)[0][2].textContent).toBe("alice@example.com");
  });

  it("マスク中のセルはダブルクリックで編集を始めず、行の複製・値ビューアも無効", async () => {
    const onSetCellEdit = vi.fn();
    const onDuplicateRow = vi.fn();
    const { container } = renderWithProviders(
      <ResultGrid
        result={RESULT}
        editable
        tableColumns={TABLE_COLUMNS}
        onSetCellEdit={onSetCellEdit}
        onDuplicateRow={onDuplicateRow}
      />,
    );
    const cell = dataCells(container)[0][2];
    fireEvent.doubleClick(cell);
    expect(container.querySelector("input.cell-edit-input")).toBeNull();

    fireEvent.contextMenu(cell);
    const dup = await screen.findByRole("menuitem", { name: t("gridDuplicateRow") });
    expect(dup).toBeDisabled();
    // 値ビューアも開けない。
    expect(screen.getByRole("menuitem", { name: t("gridViewFull") })).toBeDisabled();
  });

  it("行インスペクタでもマスク中の値は伏せ字", () => {
    const { container } = renderWithProviders(<ResultGrid result={RESULT} />);
    const cells = dataCells(container);
    fireEvent.focus(cells[0][0]);
    fireEvent.keyDown(cells[0][0], { key: "Enter", altKey: true });
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("alice");
    expect(dialog.textContent).not.toContain("alice@example.com");
    expect(dialog.textContent).toContain(MASK_PLACEHOLDER);
  });
});
