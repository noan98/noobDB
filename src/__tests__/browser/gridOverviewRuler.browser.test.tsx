import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { cleanup } from "vitest-browser-react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import { GridOverviewRuler } from "../../components/GridOverviewRulerCanvas";
import { computeRulerTicks } from "../../components/gridOverviewRuler";
import type { QueryResult, TableColumnInfo } from "../../api/tauri";

// 位置マーカーの帯 (#2381) を実ブラウザで検証する。再実行差分 (変化した行) をマーカーにして、
// 帯がスクロールバー脇に出ること・クリックでその位置へ飛べること・10 万行でも描画が軽いことを見る。

afterEach(async () => {
  await cleanup();
});

const COLS = ["id", "name", "qty"];
const meta = (name: string, key: string): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: false,
  key,
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
});
const TABLE_COLUMNS = [meta("id", "PRI"), meta("name", ""), meta("qty", "")];

function build(n: number, changedEvery: number) {
  const prev = Array.from({ length: n }, (_, i) => [i, `n${i}`, i]);
  const rows = prev.map((r, i) => (i % changedEvery === 0 ? [r[0], r[1], (r[2] as number) + 1] : r));
  const result: QueryResult = {
    columns: COLS.map((name) => ({ name, type_name: "INT" })),
    rows,
    rows_affected: 0,
    elapsed_ms: 1,
  };
  return { prev, result };
}

async function nextFrames() {
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

function renderGrid(n: number, changedEvery: number) {
  const { prev, result } = build(n, changedEvery);
  return renderInBrowser(
    <div style={{ width: 900, height: 500, display: "flex", flexDirection: "column" }}>
      <ResultGrid
        result={result}
        onChangeView={() => {}}
        tableColumns={TABLE_COLUMNS}
        diffPrevRows={prev}
        diffComparable
        diffHighlightEnabled
      />
    </div>,
  );
}

describe("位置マーカーの帯 (#2381, 実ブラウザ)", () => {
  it("変化した行があると帯が出て、クリックでその位置へスクロールする", async () => {
    await renderGrid(2000, 500);
    await expect.poll(() => document.querySelector(".grid-ruler canvas")).not.toBeNull();
    const canvas = document.querySelector(".grid-ruler canvas") as HTMLCanvasElement;
    const scroller = document.querySelector("table")?.closest("div[tabindex='-1']") as HTMLElement;
    expect(scroller.scrollTop).toBe(0);
    const rect = canvas.getBoundingClientRect();
    expect(rect.height).toBeGreaterThan(100);
    // 帯の下端付近をクリック → 末尾付近へ飛ぶ。
    await userEvent.click(canvas, { position: { x: 2, y: Math.round(rect.height * 0.9) } });
    await nextFrames();
    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(scroller.scrollHeight * 0.5);
  });

  it("10 万行のマスクでも帯の集約 + Canvas 描画が 1 フレーム (16ms) に収まる", async () => {
    // グリッド本体の 10 万行描画は帯の性能と無関係なので、帯単体を 10 万行ぶんのマスクで描く。
    const masks = new Uint8Array(100_000);
    for (let i = 0; i < masks.length; i += 997) masks[i] = 8;
    await renderInBrowser(
      <div style={{ width: 40, height: 500, display: "flex" }}>
        <GridOverviewRuler masks={masks} selection={null} currentRow={null} onJump={() => {}} />
      </div>,
    );
    await expect.poll(() => document.querySelector(".grid-ruler canvas")).not.toBeNull();
    const canvas = document.querySelector(".grid-ruler canvas") as HTMLCanvasElement;
    await expect.poll(() => canvas.clientHeight).toBeGreaterThan(100);
    const ctx = canvas.getContext("2d");
    expect(ctx).not.toBeNull();
    // CI の負荷でぶれないよう複数回の中央値で見る (1 フレーム 16ms に対し余裕を持たせた 50ms)。
    const samples: number[] = [];
    for (let k = 0; k < 7; k++) {
      const t0 = performance.now();
      const lanes = computeRulerTicks(masks, canvas.clientHeight, 2);
      for (const lane of lanes) for (const tk of lane) ctx?.fillRect(0, tk.y, 4, tk.h);
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    expect(samples[3]).toBeLessThan(50);
  });

  it("帯の幅だけが変わったとき (フォント拡大) ビットマップ幅も追従する", async () => {
    const masks = new Uint8Array(1000);
    masks[10] = 8;
    const ui = (w: string) => (
      <div style={{ width: 80, height: 300, display: "flex", ["--ruler-w" as string]: w }}>
        <GridOverviewRuler masks={masks} selection={null} currentRow={null} onJump={() => {}} />
      </div>
    );
    await renderInBrowser(ui("20px"));
    await expect.poll(() => document.querySelector(".grid-ruler canvas")).not.toBeNull();
    const canvas = document.querySelector(".grid-ruler canvas") as HTMLCanvasElement;
    const dpr = window.devicePixelRatio || 1;
    // 左罫線ぶんだけ帯の幅と canvas の clientWidth はずれるので、clientWidth を基準にする。
    await expect.poll(() => canvas.clientWidth).toBeGreaterThan(15);
    await expect.poll(() => canvas.width).toBe(Math.round(canvas.clientWidth * dpr));
    const before = canvas.clientWidth;
    (canvas.closest("[style*='--ruler-w']") as HTMLElement).style.setProperty("--ruler-w", "40px");
    await expect.poll(() => canvas.clientWidth).toBeGreaterThan(before + 10);
    await expect.poll(() => canvas.width).toBe(Math.round(canvas.clientWidth * dpr));
  });
});
