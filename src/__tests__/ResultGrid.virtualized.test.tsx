import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderWithProviders } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale } from "../i18n";

// ResultGrid の行仮想化 (#403) を検証する。本体の ResultGrid.test.tsx は jsdom の
// ビューポート寸法が 0 なので「全行描画フォールバック」経路を通る (= 仮想化されない)。
// ここではスクロール枠と行に実寸を与える (getBoundingClientRect / ResizeObserver を
// モック) ことで仮想化経路を強制し、大きな結果でも可視範囲付近の行だけがマウント
// され、行番号・スペーサが正しいことを確認する。
//
// 寸法モックは getBoundingClientRect に依存する他テストへ波及しないよう、本ファイル
// 限定で beforeAll/afterAll により設置・復元する (別ファイルに分離している)。

const VIEWPORT_H = 400;
const ROW_H = 28;

// react-virtual (virtual-core) はビューポート/各行の寸法を `offsetHeight` から取る
// (getBoundingClientRect ではない)。jsdom はこれを常に 0 で返すため、本ファイル限定で
// プロトタイプの getter を差し替えて実寸を与える。<tr> は固定行高、それ以外
// (スクロール枠の <div> など) はビューポート高を返す。
const protoOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const protoOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeAll(() => {
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
  if (protoOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", protoOffsetHeight);
  if (protoOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", protoOffsetWidth);
});

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

const COLUMNS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "label", type_name: "VARCHAR" },
];

const TOTAL = 500;
const BIG_RESULT = makeResult(
  COLUMNS,
  Array.from({ length: TOTAL }, (_, i) => [i + 1, `row-${i + 1}`]),
);

/** tbody のうち、行番号セルを持つ実データ行だけを返す (スペーサ行は除外)。 */
function dataRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>("tbody tr")).filter(
    (tr) => tr.querySelector("td.row-index")?.textContent?.trim(),
  );
}

describe("ResultGrid 行仮想化 (#403)", () => {
  it("大きな結果では可視範囲付近の行だけをマウントする", () => {
    const { container } = renderWithProviders(<ResultGrid result={BIG_RESULT} />);

    const rendered = dataRows(container);
    // 全行 (500) はマウントされない。ビューポート (400px) / 行高 (28px) + overscan
    // 程度に収まる。
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(TOTAL);
  });

  it("先頭から連番の行番号が描画され、オフスクリーン高をスペーサ行が吸収する", () => {
    const { container } = renderWithProviders(<ResultGrid result={BIG_RESULT} />);

    const rendered = dataRows(container);
    // 先頭は行番号 1 から始まり、描画ウィンドウ内は連番。
    const numbers = rendered.map((tr) =>
      Number(tr.querySelector("td.row-index")!.textContent!.trim()),
    );
    expect(numbers[0]).toBe(1);
    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]).toBe(numbers[i - 1] + 1);
    }

    // 末尾のオフスクリーン分を吸収するスペーサ行 (aria-hidden, 高さ付き単一セル) が
    // 存在する。
    const spacer = Array.from(
      container.querySelectorAll<HTMLTableRowElement>('tbody tr[aria-hidden="true"]'),
    ).find((tr) => {
      const td = tr.querySelector("td");
      return td && parseFloat((td as HTMLElement).style.height || "0") > 0;
    });
    expect(spacer).toBeTruthy();
  });

  it("奇数番目の可視行に zebra ストライプのクラスが付く", () => {
    const { container } = renderWithProviders(<ResultGrid result={BIG_RESULT} />);
    const rendered = dataRows(container);
    // 0-based で奇数 index (= 2,4 行目…) にストライプクラス。
    expect(rendered[0].classList.contains("grid-row-stripe")).toBe(false);
    expect(rendered[1].classList.contains("grid-row-stripe")).toBe(true);
    expect(rendered[2].classList.contains("grid-row-stripe")).toBe(false);
  });
});
