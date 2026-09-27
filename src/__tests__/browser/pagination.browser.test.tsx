// PaginationBar の実ブラウザ描画テスト。ページサイズ選択 (#1143 で ListboxSelect
// = role="combobox" のトリガーボタンへ移行) とジャンプ入力の値が「フォントサイズ
// 拡大 + 表示密度」の組み合わせで縦横に見切れないことを検証する。コントロールの箱を
// 固定 26px にしていた頃は、フォント/縦 padding (--font-scale / --control-py) だけが
// スケールして値が下に欠けていた。
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

test("ページサイズ選択トリガーが既定設定で見切れない", async () => {
  const screen = await renderBar();
  const trigger = screen.container.querySelector('button[role="combobox"]');
  expect(trigger).not.toBeNull();
  expectNotClipped(trigger as HTMLButtonElement);
});

test("ページサイズ選択トリガー / ジャンプ入力が最大フォント + spacious 密度でも見切れない", async () => {
  // 設定の上限 (MAX_FONT_SIZE_PX=24, BASE=14) と最も padding が広い密度を再現する。
  const root = document.documentElement;
  root.style.setProperty("--font-scale", String(24 / 14));
  root.setAttribute("data-density", "spacious");
  const screen = await renderBar();
  const trigger = screen.container.querySelector('button[role="combobox"]');
  expect(trigger).not.toBeNull();
  expectNotClipped(trigger as HTMLButtonElement);
  const input = screen.container.querySelector("input");
  expect(input).not.toBeNull();
  expectNotClipped(input as HTMLInputElement);
});
