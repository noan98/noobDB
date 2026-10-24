import { describe, expect, it } from "vitest";
import type { DataDiff, TableWatch, TimelapseGenerationMeta } from "../api/tauri";
import { MASK_PLACEHOLDER } from "../components/columnMask";
import { tableToCsv } from "../components/tabularText";
import {
  buildTimelapseDml,
  isTimelapseDmlBlocked,
  buildTimelapseExportRows,
  buildTimelapseRows,
  countTimelapseDiff,
  defaultGenerationPair,
  formatTimelapseValue,
  resolveGenerationPair,
  summarizeCapture,
  timelapseRowsToJson,
  timelapseRowsToTable,
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
    key_kind: "primary_key",
    rows: [
      {
        status: "different",
        key: [2],
        source: [2, "b@x", 250],
        target: [2, "b@x", 200],
        changed_columns: ["price"],
      },
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

describe("差分の書き出し (#1539)", () => {
  const diff = {
    target_driver: "sqlite",
    table: "users",
    columns: ["id", "name", "email"],
    column_types: ["int", "text", "text"],
    primary_key: ["id"],
    key_kind: "primary_key",
    rows: [
      { status: "source_only", key: [1], source: [1, "a,b", "a@x"], target: null, changed_columns: [] },
      { status: "target_only", key: [2], source: null, target: [2, "bob", null], changed_columns: [] },
      {
        status: "different",
        key: [3],
        source: [3, 'say "hi"\nnow', "c@x"],
        target: [3, "old", "c@x"],
        changed_columns: ["name"],
      },
    ],
    truncated: false,
    source_count: 3,
    target_count: 3,
  } as unknown as import("../api/tauri").DataDiff;

  it("追加・削除・変更を種別と before / after 付きの行モデルにする", () => {
    const rows = buildTimelapseExportRows(diff, null);
    expect(rows.map((r) => r.kind)).toEqual(["added", "removed", "changed"]);
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toEqual({ id: 1, name: "a,b", email: "a@x" });
    expect(rows[1].after).toBeNull();
    expect(rows[1].before).toEqual({ id: 2, name: "bob", email: null });
    expect(rows[2].before?.name).toBe("old");
    expect(rows[2].after?.name).toBe('say "hi"\nnow');
    expect(rows[2].key).toEqual({ id: 3 });
    expect(rows[2].changedColumns).toEqual(["name"]);
  });

  it("マスク列は before / after とも伏せ字 (主キー列も)", () => {
    const rows = buildTimelapseExportRows(diff, [true, false, true]);
    expect(rows[2].before).toEqual({ id: "••••", name: "old", email: "••••" });
    expect(rows[2].after?.email).toBe("••••");
    expect(rows[2].key).toEqual({ id: "••••" });
    expect(JSON.stringify(rows)).not.toContain("c@x");
    expect(JSON.stringify(rows)).not.toContain("a@x");
  });

  it("CSV 用の縦持ち表は追加・削除は全列、変更は変わった列だけ", () => {
    const table = timelapseRowsToTable(buildTimelapseExportRows(diff, [false, false, true]), [
      "kind",
      "key",
      "column",
      "before",
      "after",
    ]);
    expect(table.rows).toHaveLength(3 + 3 + 1);
    expect(table.rows[0]).toEqual(["added", "id=1", "id", null, 1]);
    expect(table.rows[2]).toEqual(["added", "id=1", "email", null, "••••"]);
    expect(table.rows[6]).toEqual(["changed", "id=3", "name", "old", 'say "hi"\nnow']);
    const csv = tableToCsv(table.header, table.rows);
    expect(csv).toContain('changed,id=3,name,old,"say ""hi""\nnow"');
    expect(csv).toContain('added,id=1,name,,"a,b"');
  });

  it("種別列は渡した翻訳済み文言になる", () => {
    const table = timelapseRowsToTable(
      buildTimelapseExportRows(diff, [false, false, true]),
      ["kind", "key", "column", "before", "after"],
      { added: "追加", removed: "削除", changed: "変更" },
    );
    expect(table.rows[0][0]).toBe("追加");
    expect(table.rows[6][0]).toBe("変更");
  });

  it("JSON はメタ付きで null を保つ", () => {
    const json = JSON.parse(
      timelapseRowsToJson(buildTimelapseExportRows(diff, null), {
        table: "users",
        fromCapturedAt: "2026-10-12T00:00:00Z",
        toCapturedAt: "2026-10-12T01:00:00Z",
      }),
    );
    expect(json.table).toBe("users");
    expect(json.rows[1].after).toBeNull();
    expect(json.rows[1].before.email).toBeNull();
    expect(json.rows[2].changed_columns).toEqual(["name"]);
  });
});

describe("buildTimelapseDml (#1624)", () => {
  const rows = () => buildTimelapseExportRows(diff(), null);
  const base = { driver: "mysql", database: "shop", table: "fees" };

  it("forward: 追加は INSERT / 削除は DELETE / 変更は変わった列だけの UPDATE", () => {
    const r = buildTimelapseDml(rows(), { ...base, direction: "forward" });
    expect(r.sql.split("\n").filter(Boolean)).toEqual([
      "UPDATE `shop`.`fees` SET `price` = 250 WHERE `id` = 2;",
      "INSERT INTO `shop`.`fees` (`id`, `email`, `price`) VALUES (4, 'd@x', 400);",
      "DELETE FROM `shop`.`fees` WHERE `id` = 3;",
    ]);
    expect(r.statements).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it("revert: 追加は DELETE / 削除は INSERT (NULL を含む) / 変更は変更前の値へ UPDATE", () => {
    const r = buildTimelapseDml(rows(), { ...base, direction: "revert" });
    expect(r.sql.split("\n").filter(Boolean)).toEqual([
      "UPDATE `shop`.`fees` SET `price` = 200 WHERE `id` = 2;",
      "DELETE FROM `shop`.`fees` WHERE `id` = 4;",
      "INSERT INTO `shop`.`fees` (`id`, `email`, `price`) VALUES (3, 'c@x', NULL);",
    ]);
  });

  it("rowid で追跡した差分からは DML を作らない (rowid は振り直されて別の行を指しうる) (#1838)", () => {
    const r = buildTimelapseDml(rows(), { ...base, direction: "forward", keyKind: "rowid" });
    expect(r.sql).toBe("");
    expect(r.statements).toBe(0);
    expect(isTimelapseDmlBlocked("rowid")).toBe(true);
    expect(isTimelapseDmlBlocked("unique_key")).toBe(false);
    expect(isTimelapseDmlBlocked(undefined)).toBe(false);
  });

  it("PostgreSQL / SQLite は二重引用符で識別子を囲み、SQLite は DB 修飾を付けない", () => {
    const pg = buildTimelapseDml(rows(), { ...base, driver: "postgres", direction: "forward" });
    expect(pg.sql).toContain('DELETE FROM "shop"."fees" WHERE "id" = 3;');
    const lite = buildTimelapseDml(rows(), { ...base, driver: "sqlite", direction: "forward" });
    expect(lite.sql).toContain('DELETE FROM "fees" WHERE "id" = 3;');
  });

  it("マスク列を含む文はコメントにし、伏せ字を SQL に書かない", () => {
    const r = buildTimelapseDml(rows(), {
      ...base,
      direction: "forward",
      maskedColumns: new Set(["email"]),
      header: "preview only",
    });
    expect(r.sql.startsWith("-- preview only\n")).toBe(true);
    expect(r.sql).not.toContain("d@x");
    expect(r.sql).toContain("-- skipped (masked / no key): id=4");
    expect(r.skipped).toBe(1);
    // 主キーが伏せ字なら UPDATE / DELETE も出さない。
    const k = buildTimelapseDml(rows(), { ...base, direction: "forward", maskedColumns: new Set(["id"]) });
    expect(k.statements).toBe(0);
    expect(k.skipped).toBe(3);
    // スキップ注記にも主キーの実値(2 / 3 / 4)は出さず、伏せ字にする。
    expect(k.sql).not.toMatch(/id=[234]\b/);
    expect(k.sql).toContain(`id=${MASK_PLACEHOLDER}`);
  });

  it("文字列のクォートと NULL 主キーを安全に扱う", () => {
    const d = diff();
    d.rows = [
      { status: "target_only", key: [null], source: null, target: [null, "o'x", 1], changed_columns: [] },
    ];
    const r = buildTimelapseDml(buildTimelapseExportRows(d, null), { ...base, direction: "revert" });
    expect(r.sql).toContain("VALUES (NULL, 'o''x', 1);");
  });
});
