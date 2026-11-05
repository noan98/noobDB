import { useState } from "react";
import { describe, expect, it } from "vitest";
import { MotionConfig } from "motion/react";
import { renderInBrowser } from "./render";
import { DataRowDiffTable } from "../../components/DataRowDiffTable";
import { DiffTableSkeleton, TableDiffList } from "../../components/SchemaDiffDetail";
import type { DataDiff } from "../../api/tauri";

// スキーマ / データ比較サーフェスの標準モーション (#2013) を実ブラウザで検証する。

const DIFF: DataDiff = {
  target_driver: "mysql",
  table: "plans",
  columns: ["id", "name"],
  column_types: ["int", "varchar"],
  primary_key: ["id"],
  key_kind: "primary_key",
  rows: [
    { status: "source_only", key: [1], source: [1, "a"], target: null, changed_columns: [] },
    { status: "target_only", key: [2], source: null, target: [2, "b"], changed_columns: [] },
    { status: "different", key: [3], source: [3, "c"], target: [3, "d"], changed_columns: ["name"] },
  ],
  truncated: false,
  source_count: 3,
  target_count: 3,
};

function mount(reduced: "never" | "always") {
  return renderInBrowser(
    <MotionConfig reducedMotion={reduced}>
      <DataRowDiffTable diff={DIFF} />
    </MotionConfig>,
  );
}

describe("比較サーフェスのモーション (#2013, 実ブラウザ)", () => {
  it("差分行は初回リビールで各行にアニメーションが付く", async () => {
    await mount("never");
    const rows = Array.from(document.querySelectorAll("tbody > tr"));
    expect(rows.length).toBe(3);
    expect(rows.some((r) => (r as HTMLElement).getAnimations().length > 0)).toBe(true);
  });

  it("reduced-motion ではリビールしない", async () => {
    await mount("always");
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const rows = Array.from(document.querySelectorAll("tbody > tr"));
    expect(rows.length).toBe(3);
    expect(rows.every((r) => (r as HTMLElement).getAnimations().length === 0)).toBe(true);
  });

  it("ステータスチップの切替で <tbody> の opacity がクロスフェードし、DOM は作り直されない", async () => {
    const screen = await mount("never");
    await expect.element(screen.getByRole("group")).toBeVisible();
    const tbody = document.querySelector("tbody") as HTMLElement;
    for (const a of tbody.getAnimations()) a.cancel();
    (document.querySelector("[role='group'] button") as HTMLElement).click();
    await expect.poll(() => tbody.getAnimations().length).toBe(1);
    expect(document.querySelector("tbody")).toBe(tbody);
  });

  it("reduced-motion ではチップ切替でもクロスフェードしない", async () => {
    await mount("always");
    const tbody = document.querySelector("tbody") as HTMLElement;
    (document.querySelector("[role='group'] button") as HTMLElement).click();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(tbody.getAnimations().length).toBe(0);
  });

  it("比較中のスケルトンは aria-hidden で列見出しを保つ", async () => {
    await renderInBrowser(<DiffTableSkeleton columns={["a", "b"]} />);
    const sk = document.querySelector("[data-testid='diff-table-skeleton']") as HTMLElement;
    expect(sk.getAttribute("aria-hidden")).toBe("true");
    expect(sk.querySelectorAll("th").length).toBe(2);
    expect(sk.querySelectorAll("tbody tr").length).toBe(5);
  });
});

describe("テーブル一覧のフィルタ (#2013, 実ブラウザ)", () => {
  const tbl = (name: string) =>
    ({ name, status: "source_only", columns: [], indexes: [], fk_changes: [], check_changes: [] }) as never;
  function Harness() {
    const [names, setNames] = useState(Array.from({ length: 25 }, (_, i) => `t${i}`));
    return (
      <MotionConfig reducedMotion="never">
        <button
          type="button"
          data-testid="filter"
          onClick={() => setNames(Array.from({ length: 15 }, (_, i) => `t${i + 10}`))}
        />
        <TableDiffList
          groups={[{ status: "source_only", tables: names.map(tbl) } as never]}
          selected={null}
          onSelect={() => {}}
          t={((k: string) => k) as never}
        />
      </MotionConfig>
    );
  }
  const findB = () =>
    Array.from(document.querySelectorAll("li button")).find((b) => b.textContent === "t22") as HTMLElement;

  it("フィルタで項目が減っても、残った項目の DOM ノードとフォーカスが保たれる", async () => {
    await renderInBrowser(<Harness />);
    const btnB = findB();
    const liB = btnB.closest("li");
    btnB.focus();
    (document.querySelector("[data-testid='filter']") as HTMLElement).click();
    await expect.poll(() => document.querySelectorAll("li").length).toBe(15);
    expect(findB().closest("li")).toBe(liB);
    expect(document.activeElement).toBe(findB());
  });
});
