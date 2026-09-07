import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { ResultGrid } from "../components/ResultGrid";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale, getLocale, t } from "../i18n";

// ResultGrid の行仮想化を検証する。本体の ResultGrid.test.tsx は jsdom の
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
const protoClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const protoScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
// ロケールと ResizeObserver も書き換えるため、元の値を控えて afterAll で確実に戻す
// (Vitest はファイル単位で環境を隔離するが、後始末を漏らさないようにする)。
const originalResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
const originalScrollTo = Element.prototype.scrollTo;
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
  // react-virtual はスクロール可能距離のクランプに `scrollWidth`/`clientWidth`
  // (offsetWidth ではない) を直接読む (`scrollToIndex` の内部計算・#1095 の列
  // 仮想化テスト向け)。jsdom は両方とも常に 0 を返すため、そのままだと算出した
  // 目標オフセットが `Math.min(0, offset)` で必ず 0 に潰れる。列テストのみが
  // `scrollToIndex` (キーボード操作でウィンドウ外の列へ移動) を要求するので、
  // ここで実ブラウザ相当の値を与える。
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 800;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return 100000;
    },
  });
  // jsdom の `Element.scrollTo` はレイアウトを持たないため no-op で、
  // `scrollLeft`/`scrollTop` も "scroll" イベントも更新しない。react-virtual の
  // `scrollToIndex` はこの一連 (scrollTo → scrollLeft 反映 → "scroll" イベントで
  // 内部オフセットを再同期) に依存するため、キーボード操作でウィンドウ外のセルへ
  // 移動するテスト向けに実ブラウザ相当の版へ差し替える。イベントはマイクロタスクへ
  // 遅延させる — 同期発火だと `scrollToIndex` を呼んだ React イベントハンドラの
  // レンダー最中に "scroll" ハンドラ側の setState が割り込み、React の
  // flushSync 制約に触れる (実ブラウザでは scrollTo 自体が非同期のため起きない)。
  Element.prototype.scrollTo = function (this: Element, ...args: unknown[]) {
    const opts = (typeof args[0] === "object" && args[0] !== null ? args[0] : {}) as {
      left?: number;
      top?: number;
    };
    const left = typeof args[0] === "number" ? (args[0] as number) : opts.left;
    const top = typeof args[1] === "number" ? (args[1] as number) : opts.top;
    if (typeof left === "number") this.scrollLeft = left;
    if (typeof top === "number") this.scrollTop = top;
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  };
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
  if (protoClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", protoClientWidth);
  if (protoScrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", protoScrollWidth);
  Element.prototype.scrollTo = originalScrollTo;
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
  }, 15000);

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
  }, 15000);

  it("奇数番目の可視行に zebra ストライプのクラスが付く", () => {
    const { container } = renderWithProviders(<ResultGrid result={BIG_RESULT} />);
    const rendered = dataRows(container);
    // 0-based で奇数 index (= 2,4 行目…) にストライプクラス。
    expect(rendered[0].classList.contains("grid-row-stripe")).toBe(false);
    expect(rendered[1].classList.contains("grid-row-stripe")).toBe(true);
    expect(rendered[2].classList.contains("grid-row-stripe")).toBe(false);
  });
});

// 大量カラム時の横方向仮想化 (#1095)。列幅はテーブル state 由来の実寸 (DOM 計測では
// ない) なので、上の行仮想化と異なり列セルへの `measureElement` は不要 — スクロール枠
// (offsetWidth = 800、上の beforeAll でモック済み) と各列の既定幅 (VARCHAR = 180px) から
// 可視範囲が決まる。
const MANY_COLS = 60;
const WIDE_COLUMNS: Column[] = Array.from({ length: MANY_COLS }, (_, i) => ({
  name: `c${i}`,
  type_name: "VARCHAR",
}));
const WIDE_RESULT = makeResult(
  WIDE_COLUMNS,
  Array.from({ length: 20 }, (_, r) => Array.from({ length: MANY_COLS }, (_, c) => `r${r}c${c}`)),
);

describe("ResultGrid 列仮想化 (#1095)", () => {
  // 60 列 × 20 行の描画 + v8 coverage 計装は既定の 5000ms を超えることがあるため、
  // このファイル内の他テスト同様に個別の timeout を持たせる (振る舞いには無関係)。
  it("大量カラムでは可視範囲付近の列だけをマウントする", () => {
    const { container } = renderWithProviders(<ResultGrid result={WIDE_RESULT} />);
    const row0 = dataRows(container)[0];
    const cells = Array.from(row0.querySelectorAll("td[role='gridcell']"));

    // 全列 (60) はマウントされない。ビューポート (800px) / 列幅 (180px) + overscan
    // 程度に収まる。
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThan(MANY_COLS);

    // 省かれた列ぶんの幅を吸収する colSpan 付きスペーサ <td> が存在する
    // (縦方向のスペーサ <tr> と同じしくみ)。
    const spacer = Array.from(row0.querySelectorAll("td[aria-hidden='true']")).find(
      (td) => Number(td.getAttribute("colspan") ?? "0") > 1,
    );
    expect(spacer).toBeTruthy();
  }, 15000);

  it("末尾付近の列は先頭行から連続してマウントされている (欠番なし)", () => {
    const { container } = renderWithProviders(<ResultGrid result={WIDE_RESULT} />);
    const row0 = dataRows(container)[0];
    const texts = Array.from(row0.querySelectorAll("td[role='gridcell']")).map(
      (td) => td.textContent ?? "",
    );
    // 先頭は c0 (r0c0)。
    expect(texts[0]).toBe("r0c0");
    // マウントされた列は元の列順のまま連番 (c0, c1, c2, ...)。
    const indices = texts.map((t) => Number(t.replace("r0c", "")));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBe(indices[i - 1] + 1);
    }
  }, 15000);

  it("ArrowRight を繰り返すと初期ウィンドウ外の列にもフォーカスが移る (#1095)", async () => {
    // 15 列目は初期ウィンドウ (0〜10 付近) の外。table 要素 (role=grid) に
    // キーを送り続ける — 個々の <td> は移動のたびウィンドウ外へ出て
    // アンマウントされうるので、生存が保証された handler 直付け先へ送る。
    const { container } = renderWithProviders(<ResultGrid result={WIDE_RESULT} />);
    const table = container.querySelector("table[role='grid']") as HTMLElement;
    const firstCell = dataRows(container)[0].querySelector(
      "td[role='gridcell']",
    ) as HTMLElement;
    fireEvent.focus(firstCell);
    const TARGET_COL = 15;
    for (let i = 0; i < TARGET_COL; i++) {
      fireEvent.keyDown(table, { key: "ArrowRight" });
      // 1 手ごとに "scroll" イベント (マイクロタスク経由) と React の再描画を
      // 完了させる。まとめて連打すると `scrollToIndex` が毎回同じ古い
      // scrollOffset を基準に計算してしまい、最終的な列がウィンドウへ入らない
      // (実ブラウザでは各キー入力の間に十分な時間が空くため起きない)。
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    // ウィンドウ外だった列がスクロールでマウントされる (#1095 の
    // `scrollColumnIntoView`)。マウントされないままだと退行 (キーボード操作が
    // 大量カラムで壊れる)。
    const row0After = dataRows(container)[0];
    const targetCell = Array.from(
      row0After.querySelectorAll("td[role='gridcell']"),
    ).find((td) => td.textContent === `r0c${TARGET_COL}`);
    expect(targetCell).toBeTruthy();
    expect(targetCell?.classList.contains("is-active-cell")).toBe(true);
  }, 40000);

  it("右ピン留め列があっても、キーボード移動した列がその下に隠れない (#1099)", async () => {
    // PR #1099 のレビュー指摘 (実バグ): 列仮想化のビューポートは
    // スクロール枠の clientWidth 全体とみなされるが、実際には常時固定表示の
    // 行番号セル (ROW_INDEX_WIDTH) と固定列がその両端を覆う「死角」になる。
    // scrollPaddingStart/End (死角ぶんの余白確保) と scrollMargin (中央列の
    // 実座標が 0 始まりでないことの補正) が無いと、`scrollToIndex` が列を
    // ちょうど死角の下に着地させてしまう — フォーカスは移るが画面上は見えない。
    //
    // jsdom は実レイアウトを持たないため getBoundingClientRect で可視性を
    // 直接検証できない。代わりに、列幅 (VARCHAR = 180px 固定) と
    // ROW_INDEX_WIDTH (44px) から実座標を計算し、着地後の scrollLeft が
    // 死角を避けた範囲に収まることを数値で検証する。
    const user = userEvent.setup();
    const { container } = renderWithProviders(<ResultGrid result={WIDE_RESULT} />);

    // 最終列 (c59) を右に固定する。
    await user.click(
      screen.getByRole("button", { name: t("gridFilterAria", { column: `c${MANY_COLS - 1}` }) }),
    );
    const pinSelect = screen.getByText(t("gridPinRight")).closest("select") as HTMLSelectElement;
    await user.selectOptions(pinSelect, "right");
    expect(container.querySelector("td.is-pinned-right")).not.toBeNull();

    const table = container.querySelector("table[role='grid']") as HTMLElement;
    const firstCell = dataRows(container)[0].querySelector(
      "td[role='gridcell']",
    ) as HTMLElement;
    fireEvent.focus(firstCell);
    // 中央列の途中 (最終センター列 = count-1 は virtual-core が
    // scrollPaddingEnd を経由しない別経路 (getMaxScrollOffset) を使うため
    // 意図的に避ける — #1099 の指摘が実際に効く経路はここ)。
    const TARGET_COL = 18;
    for (let i = 0; i < TARGET_COL; i++) {
      fireEvent.keyDown(table, { key: "ArrowRight" });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 0));
    }

    const scrollEl = table.parentElement as HTMLElement;
    const COL_WIDTH = 180; // VARCHAR の既定幅 (defaultColumnSize)
    const ROW_INDEX_WIDTH = 44;
    const RIGHT_PINNED_WIDTH = 180; // 固定した c59 も VARCHAR
    const leftDeadZone = ROW_INDEX_WIDTH; // 左固定列なし
    const rightDeadZone = RIGHT_PINNED_WIDTH;
    const clientWidth = 800; // beforeAll でモック済み
    // 対象列 (c30) の実コンテンツ座標。中央列は行番号セルの直後から並ぶ。
    const itemStart = leftDeadZone + TARGET_COL * COL_WIDTH;
    const itemEnd = itemStart + COL_WIDTH;

    // 列が実際に見えている行 (row-index/固定列の死角の外) にあることを確認する。
    // 右端: 列の右端が「ビューポート右端 − 右固定列幅」を超えて死角へ食い込んで
    // いない。左端: 列の左端が「行番号 + 左固定列幅」より手前 (死角側) に出ていない。
    expect(itemEnd - scrollEl.scrollLeft).toBeLessThanOrEqual(clientWidth - rightDeadZone);
    expect(itemStart - scrollEl.scrollLeft).toBeGreaterThanOrEqual(leftDeadZone);

    // フォーカス自体は従来どおり移っている (#1095 の退行防止と両立させる)。
    const targetCell = Array.from(
      dataRows(container)[0].querySelectorAll("td[role='gridcell']"),
    ).find((td) => td.textContent === `r0c${TARGET_COL}`);
    expect(targetCell).toBeTruthy();
    expect(targetCell?.classList.contains("is-active-cell")).toBe(true);
  }, 60000);
});
