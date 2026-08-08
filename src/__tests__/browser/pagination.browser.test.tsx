// PaginationBar の実ブラウザ描画テスト。ページサイズ select とジャンプ入力の
// 値が「フォントサイズ拡大 + 表示密度」の組み合わせで縦横に見切れないことを
// 検証する。コントロールの箱を固定 26px にしていた頃は、フォント/縦 padding
// (--font-scale / --control-py) だけがスケールして値が下に欠けていた。
// jsdom はレイアウトを計算しないため、実 Chromium のブラウザモードで固定する。
import "../../App.css";
import { afterEach, expect, test } from "vitest";
import { PaginationBar } from "../../components/PaginationBar";
import { renderInBrowser } from "./render";

const noop = () => {};

function renderBar() {
  return renderInBrowser(
    <PaginationBar
      page={1}
      pageSize={100}
      rowsOnPage={100}
      totalPages={2}
      loading={false}
      onGoToPage={noop}
      onSetPageSize={noop}
    />,
  );
}

/** コントロールの中身がスクロール (= 見切れ) を起こしていないことを確かめる。 */
function expectNotClipped(el: HTMLElement) {
  expect(el.scrollHeight).toBeLessThanOrEqual(el.clientHeight);
  expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}

afterEach(() => {
  const root = document.documentElement;
  root.style.removeProperty("--font-scale");
  root.removeAttribute("data-density");
});

test("ページサイズ select が既定設定で見切れない", async () => {
  const screen = await renderBar();
  const select = screen.container.querySelector("select");
  expect(select).not.toBeNull();
  expectNotClipped(select as HTMLSelectElement);
});

test("ページサイズ select / ジャンプ入力が最大フォント + spacious 密度でも見切れない", async () => {
  // 設定の上限 (MAX_FONT_SIZE_PX=24, BASE=14) と最も padding が広い密度を再現する。
  const root = document.documentElement;
  root.style.setProperty("--font-scale", String(24 / 14));
  root.setAttribute("data-density", "spacious");
  const screen = await renderBar();
  const select = screen.container.querySelector("select");
  expect(select).not.toBeNull();
  expectNotClipped(select as HTMLSelectElement);
  const input = screen.container.querySelector("input");
  expect(input).not.toBeNull();
  expectNotClipped(input as HTMLInputElement);
});
