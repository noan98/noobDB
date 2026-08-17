import { describe, expect, it } from "vitest";
import {
  computeMenuPosition,
  MENU_MARGIN,
  SUBMENU_GAP,
  SUBMENU_OFFSET_Y,
  type MenuRect,
} from "../components/menuPosition";

// `ContextMenu` のパネル配置 (#1018)。実 DOM 無しで境界だけを固定する
// (`tooltipPosition.test.ts` と同じ方針)。

const viewport = { width: 1000, height: 800 };

function rect(left: number, top: number, width = 180, height = 24): MenuRect {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe("computeMenuPosition — クリック位置起点 (ルートメニュー)", () => {
  it("収まるならクリック位置から右下へ開く", () => {
    expect(
      computeMenuPosition({ kind: "point", x: 100, y: 120 }, { width: 200, height: 300 }, viewport),
    ).toEqual({ left: 100, top: 120 });
  });

  it("右下がはみ出すならアンカーを跨いで反対側へ折り返す", () => {
    expect(
      computeMenuPosition({ kind: "point", x: 950, y: 780 }, { width: 200, height: 300 }, viewport),
    ).toEqual({ left: 750, top: 480 });
  });

  it("折り返してもなお収まらない場合はビューポート内へクランプする", () => {
    const pos = computeMenuPosition(
      { kind: "point", x: 10, y: 10 },
      { width: 200, height: 900 },
      viewport,
    );
    expect(pos.left).toBe(10);
    // 高さがビューポートを超える場合は上端の余白に張り付く。
    expect(pos.top).toBe(MENU_MARGIN);
  });
});

describe("computeMenuPosition — 親項目起点 (サブメニュー)", () => {
  it("既定では親項目の右側に、先頭項目が親と揃うよう開く", () => {
    expect(
      computeMenuPosition(
        { kind: "rect", rect: rect(200, 300) },
        { width: 220, height: 200 },
        viewport,
      ),
    ).toEqual({ left: 200 + 180 + SUBMENU_GAP, top: 300 - SUBMENU_OFFSET_Y });
  });

  it("右端に収まらないときは親項目の左側へフリップする", () => {
    const anchor = rect(760, 100);
    expect(
      computeMenuPosition({ kind: "rect", rect: anchor }, { width: 220, height: 200 }, viewport),
    ).toEqual({ left: anchor.left - SUBMENU_GAP - 220, top: 100 - SUBMENU_OFFSET_Y });
  });

  it("下端に収まらないときは親項目の下端に揃えて上へ伸ばす", () => {
    const anchor = rect(100, 700);
    const pos = computeMenuPosition(
      { kind: "rect", rect: anchor },
      { width: 220, height: 300 },
      viewport,
    );
    expect(pos.top).toBe(anchor.bottom + SUBMENU_OFFSET_Y - 300);
    expect(pos.top).toBeGreaterThanOrEqual(MENU_MARGIN);
  });

  it("フリップ後もはみ出す極端なケースでは左右ともクランプする", () => {
    const pos = computeMenuPosition(
      { kind: "rect", rect: rect(0, 0, 20, 24) },
      { width: 1200, height: 100 },
      viewport,
    );
    expect(pos.left).toBe(MENU_MARGIN);
  });
});
