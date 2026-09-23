import { describe, expect, it } from "vitest";
import type { DataDiff, TableWatch, TimelapseGenerationMeta } from "../api/tauri";
import { MASK_PLACEHOLDER } from "../components/columnMask";
import {
  buildTimelapseRows,
  countTimelapseDiff,
  defaultGenerationPair,
  formatTimelapseValue,
  resolveGenerationPair,
  summarizeCapture,
  totalTimelapseBytes,
} from "../tableTimelapse";

// テーブル・タイムラプス (#739) の表示用純ロジック。差分そのものは Rust の
// `compute_data_diff` (source = 新しい世代 / target = 古い世代) が計算する。

function diff(): DataDiff {
  return {
    target_driver: "mysql",
    table: "fees",
    columns: ["id", "email", "price"],
    column_types: ["int", "varchar", "int"],
    primary_key: ["id"],
    rows: [
      { status: "different", key: [2], source: [2, "b@x", 250], target: [2, "b@x", 200], changed_columns: ["price"] },
      { status: "source_only", key: [4], source: [4, "d@x", 400], target: null, changed_columns: [] },
      { status: "target_only", key: [3], source: null, target: [3, "c@x", null], changed_columns: [] },
    ],
    truncated: false,
    source_count: 3,
    target_count: 3,
  };
}

function gen(id: number, bytes = 10): TimelapseGenerationMeta {
  return { id, captured_at: `2026-01-0${id}T00:00:00Z`, row_count: 1, truncated: false, bytes };
}

describe("countTimelapseDiff", () => {
  it("source_only = 追加 / target_only = 削除 / different = 変更 として数える", () => {
    expect(countTimelapseDiff(diff())).toEqual({ added: 1, removed: 1, changed: 1 });
  });
});

describe("buildTimelapseRows", () => {
  it("変更行は新しい値を表示し、変わったセルだけに変更前の値を持つ", () => {
    const rows = buildTimelapseRows(diff(), null);
    const changed = rows[0];
    expect(changed.kind).toBe("changed");
    expect(changed.cells.map((c) => c.text)).toEqual(["2", "b@x", "250"]);
    expect(changed.cells.map((c) => c.changed)).toEqual([false, false, true]);
    expect(changed.cells[2].before).toBe("200");
    expect(changed.cells[1].before).toBeNull();
    expect(changed.cells[0].primaryKey).toBe(true);
  });

  it("追加行は新しい値、削除行は古い値を表示する (NULL は NULL と表示)", () => {
    const rows = buildTimelapseRows(diff(), null);
    expect(rows[1].kind).toBe("added");
    expect(rows[1].cells.map((c) => c.text)).toEqual(["4", "d@x", "400"]);
    expect(rows[2].kind).toBe("removed");
    expect(rows[2].cells.map((c) => c.text)).toEqual(["3", "c@x", "NULL"]);
    expect(rows.every((r) => r.cells.every((c) => c.before === null || r.kind === "changed"))).toBe(true);
  });

  it("マスク列は表示だけ伏せ字にし、変更の有無 (ハイライト) は残す", () => {
    const d = diff();
    d.rows[0] = { ...d.rows[0], source: [2, "new@x", 250], changed_columns: ["email", "price"] };
    const rows = buildTimelapseRows(d, [false, true, false]);
    const email = rows[0].cells[1];
    expect(email.masked).toBe(true);
    expect(email.changed).toBe(true);
    expect(email.text).toBe(MASK_PLACEHOLDER);
    expect(email.before).toBe(MASK_PLACEHOLDER);
    // 実値はどこにも出ない。
    expect(JSON.stringify(rows)).not.toContain("new@x");
  });

  it("同じキーが重複しても React の key は一意になる", () => {
    const d = diff();
    d.rows.push({ ...d.rows[1] });
    const keys = buildTimelapseRows(d, null).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("世代ペア", () => {
  it("既定は「1 つ前 → 最新」、2 世代未満なら null", () => {
    expect(defaultGenerationPair([gen(3), gen(2), gen(1)])).toEqual({ fromId: 2, toId: 3 });
    expect(defaultGenerationPair([gen(1)])).toBeNull();
    expect(defaultGenerationPair([])).toBeNull();
  });

  it("選択中のペアが消えた (ローテーション) / 同一世代なら既定へ戻す", () => {
    const gens = [gen(3), gen(2), gen(1)];
    expect(resolveGenerationPair(gens, { fromId: 1, toId: 3 })).toEqual({ fromId: 1, toId: 3 });
    expect(resolveGenerationPair(gens, { fromId: 0, toId: 3 })).toEqual({ fromId: 2, toId: 3 });
    expect(resolveGenerationPair(gens, { fromId: 2, toId: 2 })).toEqual({ fromId: 2, toId: 3 });
    expect(resolveGenerationPair(gens, null)).toEqual({ fromId: 2, toId: 3 });
  });
});

describe("summarizeCapture / totalTimelapseBytes / formatTimelapseValue", () => {
  it("世代が増えたテーブルと失敗したテーブルを分ける", () => {
    const summary = summarizeCapture([
      { watch_id: 1, database: "app", table: "fees", added: true, truncated: false, error: null },
      { watch_id: 2, database: "app", table: "flags", added: false, truncated: false, error: null },
      { watch_id: 3, database: "app", table: "gone", added: false, truncated: false, error: "no such table" },
    ]);
    expect(summary.changed).toEqual(["app.fees"]);
    expect(summary.failed).toEqual([{ table: "app.gone", error: "no such table" }]);
  });

  it("全ウォッチの世代の保存量を合計する", () => {
    const w = (gens: TimelapseGenerationMeta[]): TableWatch => ({
      id: 1,
      profile_id: "p",
      driver: "sqlite",
      database: "main",
      table: "t",
      active: true,
      partial: false,
      created_at: "",
      generations: gens,
    });
    expect(totalTimelapseBytes([w([gen(1, 5), gen(2, 7)]), w([gen(3, 1)])])).toBe(13);
    expect(totalTimelapseBytes([])).toBe(0);
  });

  it("値の表示", () => {
    expect(formatTimelapseValue(null)).toBe("NULL");
    expect(formatTimelapseValue(undefined)).toBe("NULL");
    expect(formatTimelapseValue(false)).toBe("false");
    expect(formatTimelapseValue("9007199254740993")).toBe("9007199254740993");
  });
});
