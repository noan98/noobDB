import { beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import { t } from "../../i18n";
import type { QueryResult } from "../../api/tauri";

// 列のピン留め / 解除の確定時の FLIP グライド (#1753) を実ブラウザで検証する。
// 動きは個別プロパティ `translate` で再生するので、sticky の left オフセットと干渉せず、
// 終了後の位置は sticky の定位置になる。

const RESULT: QueryResult = {
  columns: Array.from({ length: 6 }, (_, i) => ({ name: `col_${i}`, type_name: "VARCHAR" })),
  rows: Array.from({ length: 3 }, (_, r) => Array.from({ length: 6 }, (_, c) => `r${r}c${c}`)),
  rows_affected: 0,
  elapsed_ms: 1,
};

function headerCell(id: string): HTMLElement {
  return document.querySelector(`thead th[data-col-id="${id}"]`) as HTMLElement;
}

async function pinColumn(screen: Awaited<ReturnType<typeof renderInBrowser>>, name: string, side: string) {
  await screen.getByRole("button", { name: t("gridFilterAria", { column: name }) }).click();
  const select = screen.getByLabelText(t("gridPinLabel"));
  await userEvent.selectOptions(select, side);
}

function mount(reducedMotion: "never" | "always") {
  return renderInBrowser(
    <MotionConfig reducedMotion={reducedMotion}>
      <div style={{ width: 1000, height: 400, display: "flex", flexDirection: "column" }}>
        <ResultGrid result={RESULT} onChangeView={() => {}} />
      </div>
    </MotionConfig>,
  );
}

describe("列ピン留めのグライド (#1753, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("左ピンで固定端へ滑り、終了後は sticky の定位置に収まって transform を残さない", async () => {
    const screen = await mount("never");
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    const startLeft = headerCell("3").getBoundingClientRect().left;

    await pinColumn(screen, "col_3", "left");
    await expect.poll(() => headerCell("3").classList.contains("is-pinned-left")).toBe(true);

    // 動いた列 (3 が先頭へ、0〜2 は 1 列ぶん右へ) にだけアニメーションが付く。
    expect(headerCell("3").getAnimations().length).toBe(1);
    expect(headerCell("0").getAnimations().length).toBe(1);
    expect(headerCell("5").getAnimations().length).toBe(0);

    // 開始時点は元の位置付近 (瞬間移動しない)。sticky の left と二重に効かない。
    const anim = headerCell("3").getAnimations()[0];
    anim.pause();
    anim.currentTime = 0;
    expect(Math.round(headerCell("3").getBoundingClientRect().left)).toBe(Math.round(startLeft));

    for (const id of ["0", "1", "2", "3"]) for (const a of headerCell(id).getAnimations()) a.finish();
    expect(headerCell("3").style.transform).toBe("");
    const grid = headerCell("3").closest("table") as HTMLElement;
    expect(headerCell("3").getBoundingClientRect().left).toBeLessThan(startLeft);
    // 固定列は行番号列 (先頭の th) の直後に貼り付く。
    const gutter = grid.querySelector("thead th") as HTMLElement;
    expect(Math.round(headerCell("3").getBoundingClientRect().left)).toBe(
      Math.round(gutter.getBoundingClientRect().right),
    );
    // 通常列は固定列の右へ。
    expect(headerCell("0").getBoundingClientRect().left).toBeGreaterThan(
      headerCell("3").getBoundingClientRect().right - 1,
    );
  });

  it("reduced-motion では再生しない (ピン留め自体は行う)", async () => {
    const screen = await mount("always");
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    await pinColumn(screen, "col_3", "left");
    await expect.poll(() => headerCell("3").classList.contains("is-pinned-left")).toBe(true);
    for (const id of ["0", "1", "2", "3"]) expect(headerCell(id).getAnimations().length).toBe(0);
  });

  it("ハイコントラスト (hc-dark) では再生しない", async () => {
    document.documentElement.setAttribute("data-theme", "hc-dark");
    const screen = await mount("never");
    await expect.element(screen.getByText("r0c0")).toBeVisible();
    await pinColumn(screen, "col_3", "left");
    await expect.poll(() => headerCell("3").classList.contains("is-pinned-left")).toBe(true);
    for (const id of ["0", "1", "2", "3"]) expect(headerCell(id).getAnimations().length).toBe(0);
  });
});
