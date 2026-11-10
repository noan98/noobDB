import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { renderInBrowser } from "./render";
import { Tooltip } from "../../components/Tooltip";

// #1319 — Tooltip は開くまで吹き出し (Portal) を作らず、閉じたあとは退場
// アニメーションが終わった時点で DOM から消える。再度開けることも固定する。
// jsdom は退場アニメーションが完了しないため、実ブラウザでだけ確かめられる。
const tooltipExists = () => document.querySelector('[role="tooltip"]') !== null;

describe("Tooltip の遅延 Portal (実ブラウザ)", () => {
  it("開くまで吹き出しが無く、閉じて退場が終わると消え、再度開ける", async () => {
    // Playwright のマウス位置は同じページで走る直前のテストファイルから持ち越される。
    // 直前のテストがトリガーの描画位置 (左上) をホバーしたままだと、描画直後に Chromium が
    // 合成する mousemove でツールチップが勝手に開き、下の「開くまで無い」が落ちる (#2202)。
    // 合成 mousemove は少し遅れて来るので、負荷の高い CI (更新モード) でだけ顕在化していた。
    // 先にポインタをビューポートの右下隅へ退避してから描画する。
    await userEvent.hover(document.documentElement, { position: { x: 1270, y: 790 } });
    const screen = await renderInBrowser(
      <Tooltip label="ヒント" openDelay={0}>
        <button type="button">trigger</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "trigger" });
    await expect.element(trigger).toBeVisible();
    expect(tooltipExists()).toBe(false);

    await trigger.hover();
    await expect.poll(tooltipExists, { timeout: 3_000 }).toBe(true);
    const el = trigger.element();
    expect(el.getAttribute("aria-describedby")).toBe(document.querySelector('[role="tooltip"]')?.id);

    // マウスを外すと aria-describedby は即外れ、退場後に吹き出しが DOM から消える。
    await screen.getByRole("button", { name: "trigger" }).unhover();
    expect(el.getAttribute("aria-describedby")).toBeNull();
    await expect.poll(tooltipExists, { timeout: 3_000 }).toBe(false);

    // Portal を畳んだあとでも、もう一度開ける。
    await trigger.hover();
    await expect.poll(tooltipExists, { timeout: 3_000 }).toBe(true);
  });
});
