import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale, getLocale, t } from "../i18n";

// 結果ハンドル (#1264) 経由のソート。行数しきい値以上で、行配列にハンドルが紐づいている
// 結果は、ソートを `result_sort_filter` (バックエンド) に任せ、返った行インデックス順で
// 表示する。ハンドルが無い / 破棄済みなら従来どおり JS (TanStack) でソートする。
// 寸法モックは `ResultGrid.virtualized.test.tsx` と同じ理由・同じ方法 (仮想化経路を通す)。

// 5 万行を jsdom で描画すると遅すぎるので、しきい値の判定だけを差し替えて少ない行数で
// 経路を検証する。しきい値そのものの判定は `resultHandle.test.ts` が固定する。
vi.mock("../components/resultHandle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/resultHandle")>();
  return {
    ...actual,
    shouldUseHandleForGrid: (rows: Parameters<typeof actual.resultHandleFor>[0]) =>
      rows && rows.length >= 20 ? actual.resultHandleFor(rows) : null,
  };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resultSortFilter: vi.fn(),
      resultFind: vi.fn(),
      resultColumnStats: vi.fn(),
    },
  };
});

import { ResultGrid, type ResultGridHandle } from "../components/ResultGrid";
import { api } from "../api/tauri";
import { attachResultHandle } from "../components/resultHandle";

const VIEWPORT_H = 400;
const ROW_H = 28;

const protoOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const protoOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
let originalLocale: ReturnType<typeof getLocale>;

beforeAll(() => {
  originalLocale = getLocale();
  setLocale("en");
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.tagName === "TR" ? ROW_H : VIEWPORT_H;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
});

afterAll(() => {
  setLocale(originalLocale);
  if (originalResizeObserver === undefined) {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  }
  if (protoOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", protoOffsetHeight);
  if (protoOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", protoOffsetWidth);
});

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "label", type_name: "VARCHAR" },
];

const TOTAL = 30;

function makeBigResult(): QueryResult {
  return {
    columns: COLUMNS,
    rows: Array.from({ length: TOTAL }, (_, i) => [i + 1, `row-${i + 1}`]),
    rows_affected: TOTAL,
    elapsed_ms: 1,
  };
}

/** 描画されているデータ行の label セルのテキスト (先頭から)。 */
function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr"))
    .filter((tr) => tr.querySelector("td.row-index")?.textContent?.trim())
    .map((tr) => tr.querySelectorAll("td")[2]?.textContent ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

describe("ResultGrid 結果ハンドル経由のソート (#1264)", () => {
  it("ハンドルがあれば result_sort_filter の順序で表示し、JS ではソートしない", async () => {
    const result = makeBigResult();
    attachResultHandle(result.rows, "qs_handle");
    // 逆順を返す。
    const reversed = Array.from({ length: TOTAL }, (_, i) => TOTAL - 1 - i);
    vi.mocked(api.resultSortFilter).mockResolvedValue(reversed);

    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    expect(labels(container)[0]).toBe("row-1");

    await user.click(screen.getByRole("button", { name: /^id/ }));

    await waitFor(() => expect(labels(container)[0]).toBe(`row-${TOTAL}`));
    expect(api.resultSortFilter).toHaveBeenCalledWith({
      resultId: "qs_handle",
      // 数値列の 1 回目のクリックは降順 (ResultGrid の既定)。
      sort: [{ col: 0, kind: "numeric", desc: true }],
      filters: [],
      global: "",
    });
  });

  it("ハンドルが破棄済み (null) なら JS のソートにフォールバックする", async () => {
    const result = makeBigResult();
    attachResultHandle(result.rows, "qs_gone");
    vi.mocked(api.resultSortFilter).mockResolvedValue(null);

    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    await user.click(screen.getByRole("button", { name: /^id/ }));
    await waitFor(() => expect(api.resultSortFilter).toHaveBeenCalled());
    // null (ハンドル無し) が返ったら TanStack の JS ソート (降順) で末尾の行が先頭に来る。
    await waitFor(() => expect(labels(container)[0]).toBe(`row-${TOTAL}`));
  });

  it("ハンドルの無い結果は result_sort_filter を呼ばない", async () => {
    const result = makeBigResult();
    const user = userEvent.setup();
    renderWithProviders(<ResultGrid result={result} />);
    await user.click(screen.getByRole("button", { name: /^id/ }));
    expect(api.resultSortFilter).not.toHaveBeenCalled();
  });

  it("行数がしきい値未満ならハンドルがあっても JS で処理する", async () => {
    const small: QueryResult = {
      columns: COLUMNS,
      rows: Array.from({ length: 10 }, (_, i) => [i + 1, `row-${i + 1}`]),
      rows_affected: 10,
      elapsed_ms: 1,
    };
    attachResultHandle(small.rows, "qs_small");
    const user = userEvent.setup();
    renderWithProviders(<ResultGrid result={small} />);
    await user.click(screen.getByRole("button", { name: /^id/ }));
    expect(api.resultSortFilter).not.toHaveBeenCalled();
  });
});

describe("ResultGrid 結果ハンドル経由の結果内検索 (#1264)", () => {
  it("ハンドルがあれば result_find でヒットを受け取り、打ち切り時は総数を示す", async () => {
    const result = makeBigResult();
    attachResultHandle(result.rows, "qs_find");
    vi.mocked(api.resultFind).mockResolvedValue({
      hits: [
        { rowIdx: 4, colIdx: 1 },
        { rowIdx: 9, colIdx: 1 },
      ],
      total: 123,
      truncated: true,
    });
    const ref = createRef<ResultGridHandle>();
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid ref={ref} result={result} />);
    act(() => ref.current!.openFind());
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "row-5");

    await waitFor(() =>
      expect(
        screen.getByText(t("gridFindCountTruncated", { current: 1, total: 123, limit: 2 })),
      ).toBeInTheDocument(),
    );
    expect(api.resultFind).toHaveBeenLastCalledWith({
      resultId: "qs_find",
      query: "row-5",
      options: { caseSensitive: false, wholeCell: false },
      limit: 10_000,
    });
    expect(container.querySelector("td.is-find-current")?.textContent).toBe("row-5");
  });

  it("正規表現モードはハンドルがあっても JS で検索する", async () => {
    const result = makeBigResult();
    attachResultHandle(result.rows, "qs_find");
    const ref = createRef<ResultGridHandle>();
    const user = userEvent.setup();
    renderWithProviders(<ResultGrid ref={ref} result={result} />);
    act(() => ref.current!.openFind());
    await user.click(screen.getByRole("button", { name: t("gridFindRegexTitle") }));
    await user.type(screen.getByLabelText(t("gridFindInputAria")), "row-5$");
    await waitFor(() => expect(screen.getByText(t("gridFindCount", { current: 1, total: 1 }))).toBeInTheDocument());
    expect(api.resultFind).not.toHaveBeenCalled();
  });
});
