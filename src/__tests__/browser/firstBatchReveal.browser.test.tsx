import { beforeEach, describe, expect, it } from "vitest";
import { useEffect, useState } from "react";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { ResultGrid } from "../../components/ResultGrid";
import type { QueryResult } from "../../api/tauri";

// 初回バッチ着弾の stagger リビール (#1579) を実ブラウザで検証する。
// スケルトン → 最初の行で <tr> にだけ opacity/transform の Animation が付き、
// 件数は上限以内、追加バッチ・reduced-motion では付かないことを確かめる。

const mk = (n: number): QueryResult => ({
  columns: [{ name: "n", type_name: "INT" }],
  rows: Array.from({ length: n }, (_, r) => [r]),
  rows_affected: 0,
  elapsed_ms: 1,
});

// 外から行数を差し替えられる小さなホスト (renderInBrowser の rerender は Provider を外すため)。
let setRows: (n: number) => void = () => {};
function Host({ reduced }: { reduced: "never" | "always" }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setRows = setN;
  }, []);
  return (
    <MotionConfig reducedMotion={reduced}>
      <div style={{ width: 600, height: 400, display: "flex", flexDirection: "column" }}>
        <ResultGrid result={mk(n)} streaming onChangeView={() => {}} />
      </div>
    </MotionConfig>
  );
}

const animatedRows = () =>
  Array.from(document.querySelectorAll("tbody > tr[role='row']")).filter(
    (tr) => tr.getAnimations().length > 0,
  );

describe("初回バッチのリビール (#1579, 実ブラウザ)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("最初の行で可視行 (上限以内) の <tr> にだけ再生し、追加バッチでは再生しない", async () => {
    await renderInBrowser(<Host reduced="never" />);
    expect(animatedRows().length).toBe(0);
    setRows(200);
    await expect.poll(() => animatedRows().length).toBeGreaterThan(0);
    expect(animatedRows().length).toBeLessThanOrEqual(24);
    const tbody = document.querySelector("tbody") as HTMLElement;
    expect(tbody.getAnimations().length).toBe(0);
    for (const tr of animatedRows()) for (const a of tr.getAnimations()) a.finish();
    setRows(400);
    await new Promise((r) => setTimeout(r, 100));
    expect(animatedRows().length).toBe(0);
  });

  it("reduced-motion では再生しない", async () => {
    await renderInBrowser(<Host reduced="always" />);
    setRows(200);
    await expect.poll(() => document.querySelectorAll("tbody > tr[role='row']").length).toBeGreaterThan(0);
    expect(animatedRows().length).toBe(0);
  });
});
