import { describe, expect, it } from "vitest";
import { firstBodyFocusable } from "../components/Modal";

/**
 * モーダルを開いたときの既定フォーカス先。ヘッダの × に当たるとツールチップ
 * 「閉じる」が開いた瞬間に出てしまうので、本文の最初の操作要素に当てる。
 */

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("firstBodyFocusable", () => {
  it("ヘッダの × ではなく本文の最初の入力欄を返す", () => {
    const root = mount(
      `<button id="x">×</button><div data-modal-body><label>名前</label><input id="a" /><button id="b">送信</button></div>`,
    );
    expect(firstBodyFocusable(root)?.id).toBe("a");
  });

  it("無効な要素と hidden 入力は飛ばす", () => {
    const root = mount(
      `<div data-modal-body><input type="hidden" /><input id="d" disabled /><select id="s"></select></div>`,
    );
    expect(firstBodyFocusable(root)?.id).toBe("s");
  });

  it("ラジオグループは選択中の項目に当てる", () => {
    const root = mount(
      `<div data-modal-body><input type="radio" name="fmt" id="r1" /><input type="radio" name="fmt" id="r2" checked /></div>`,
    );
    expect(firstBodyFocusable(root)?.id).toBe("r2");
  });

  it("本文に操作要素が無ければ null (Dialog の既定に任せる)", () => {
    expect(firstBodyFocusable(mount(`<div data-modal-body><p>説明だけ</p></div>`))).toBeNull();
    expect(firstBodyFocusable(null)).toBeNull();
  });
});
