import { describe, expect, it } from "vitest";
import type { CellValue, Column, TableColumnInfo } from "../api/tauri";
import {
  buildHierarchy,
  buildSubtreeSql,
  pickFreeName,
  clampSubtreeDepth,
  defaultLabelColumn,
  detectSelfReference,
  expandableRows,
  flattenVisible,
  guessHierarchyColumns,
  sanitizeHierarchyConfig,
  supportsRecursiveCte,
  ancestorsOf,
} from "../components/hierarchyTree";

const col = (name: string, type_name = "INT"): Column => ({ name, type_name });
const meta = (name: string, over: Partial<TableColumnInfo> = {}): TableColumnInfo => ({
  name,
  data_type: "int",
  nullable: true,
  key: "",
  default: null,
  extra: "",
  referenced_table: null,
  referenced_column: null,
  ...over,
});

describe("buildHierarchy", () => {
  it("親子・深さ・子孫数を組み立てる", () => {
    const rows: CellValue[][] = [
      [1, null],
      [2, 1],
      [3, 1],
      [4, 2],
    ];
    const m = buildHierarchy(rows, 0, 1);
    expect(m.roots).toEqual([0]);
    expect(m.nodes[0].children).toEqual([1, 2]);
    expect(m.nodes[3].depth).toBe(2);
    expect(m.nodes[0].descendants).toBe(3);
    expect(m.nodes[1].descendants).toBe(1);
    expect(m.expandable).toBe(2);
    expect(m.orphans).toEqual([]);
    expect(m.cycles).toEqual([]);
  });

  it("親が結果に無い行を孤児に分け、その子も孤児の木に入れる", () => {
    const m = buildHierarchy(
      [
        [10, 99],
        [11, 10],
        [1, null],
      ],
      0,
      1,
    );
    expect(m.orphans).toEqual([0]);
    expect(m.roots).toEqual([2]);
    expect(m.nodes[1].group).toBe("orphan");
    expect(m.nodes[1].depth).toBe(1);
  });

  it("自己参照・相互参照・循環の尾を検出し、無限ループにならない", () => {
    const rows: CellValue[][] = [
      [1, 1], // 自己参照
      [2, 3],
      [3, 4],
      [4, 2], // 2→3→4→2 の循環
      [5, 3], // 循環にぶら下がる尾
      [6, null],
    ];
    const m = buildHierarchy(rows, 0, 1);
    expect(m.cycles).toEqual([0, 1]);
    expect(m.cycleRowCount).toBe(4);
    expect(m.nodes[4].inCycle).toBe(false);
    expect(m.nodes[4].group).toBe("cycle");
    // 見出しの件数は尾を含むグループ全体の行数 (循環 4 行 + 尾 1 行)。
    expect(m.groupRows).toEqual({ root: 1, orphan: 0, cycle: 5 });
    expect(m.roots).toEqual([5]);
    // 代表行は根として切り離され、全行がちょうど 1 回ずつ木に現れる。
    const all = new Set<number>();
    for (const top of [...m.roots, ...m.orphans, ...m.cycles]) {
      const flat = flattenVisible(m, [top], expandableRows(m));
      for (const r of flat.rows) {
        expect(all.has(r.row)).toBe(false);
        all.add(r.row);
      }
    }
    expect(all.size).toBe(rows.length);
  });

  it("ID が重複しても落ちず、後続の同 ID 行は子を持たない", () => {
    const m = buildHierarchy(
      [
        [1, null],
        [1, null],
        [2, 1],
      ],
      0,
      1,
    );
    expect(m.nodes[0].children).toEqual([2]);
    expect(m.nodes[1].children).toEqual([]);
  });

  it("NULL の ID・文字列と数値の混在キーを同一視する", () => {
    const m = buildHierarchy(
      [
        [null, null],
        ["7", null],
        [8, 7],
      ],
      0,
      1,
    );
    expect(m.nodes[1].children).toEqual([2]);
  });

  it("5 万行・深さ 5 万の鎖でも固まらずスタックを溢れさせない", () => {
    const n = 50_000;
    const chain: CellValue[][] = [];
    for (let i = 0; i < n; i++) chain.push([i, i === 0 ? null : i - 1]);
    const t0 = Date.now();
    const m = buildHierarchy(chain, 0, 1);
    expect(m.nodes[n - 1].depth).toBe(n - 1);
    expect(m.nodes[0].descendants).toBe(n - 1);
    const flat = flattenVisible(m, m.roots, expandableRows(m));
    expect(flat.rows).toHaveLength(n);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("5 万行の巨大な循環 (1 本の輪) も 1 つの代表で打ち切る", () => {
    const n = 50_000;
    const ring: CellValue[][] = [];
    for (let i = 0; i < n; i++) ring.push([i, (i + n - 1) % n]);
    const m = buildHierarchy(ring, 0, 1);
    expect(m.cycles).toEqual([0]);
    expect(m.cycleRowCount).toBe(n);
    const flat = flattenVisible(m, m.cycles, expandableRows(m));
    expect(flat.rows).toHaveLength(n);
  });

  it("flattenVisible は展開した行の子だけを出し、limit で打ち切る", () => {
    const m = buildHierarchy(
      [
        [1, null],
        [2, 1],
        [3, 2],
        [4, null],
      ],
      0,
      1,
    );
    expect(flattenVisible(m, m.roots, new Set()).rows.map((r) => r.row)).toEqual([0, 3]);
    expect(flattenVisible(m, m.roots, new Set([0])).rows.map((r) => r.row)).toEqual([0, 1, 3]);
    const cut = flattenVisible(m, m.roots, expandableRows(m), 2);
    expect(cut.truncated).toBe(true);
    expect(cut.rows).toHaveLength(2);
    expect(Array.from(expandableRows(m, 1))).toEqual([1]);
  });

  it("ancestorsOf は祖先を子に近い順で返す", () => {
    const m = buildHierarchy(
      [
        [1, null],
        [2, 1],
        [3, 2],
      ],
      0,
      1,
    );
    expect(ancestorsOf(m, 2)).toEqual([1, 0]);
  });
});

describe("列の決定", () => {
  const cols = [col("id"), col("parent_id"), col("name", "VARCHAR")];

  it("宣言 FK / 論理リレーションの自己参照から列を決める", () => {
    const metas = [
      meta("id", { key: "PRI" }),
      meta("parent_id", { referenced_table: "categories", referenced_column: "id", logical: true }),
    ];
    expect(detectSelfReference(cols, metas, "categories")).toEqual({ idCol: "id", parentCol: "parent_id" });
    expect(detectSelfReference(cols, metas, "other")).toBeNull();
    expect(detectSelfReference(cols, metas, "`db`.`Categories`")).toEqual({
      idCol: "id",
      parentCol: "parent_id",
    });
  });

  it("referenced_table にスキーマが付くときはスキーマも比べる", () => {
    const m = (ref: string) => [
      meta("id", { key: "PRI" }),
      meta("p", { referenced_table: ref, referenced_column: "id" }),
    ];
    const cs = [col("id"), col("p")];
    expect(detectSelfReference(cs, m("other.cats"), "cats", "shop")).toBeNull();
    expect(detectSelfReference(cs, m("shop.cats"), "cats", "shop")).toEqual({ idCol: "id", parentCol: "p" });
    expect(detectSelfReference(cs, m("shop.cats"), "shop.cats")).toEqual({ idCol: "id", parentCol: "p" });
    expect(detectSelfReference(cs, m("other.cats"), "shop.cats")).toBeNull();
    // スキーマが片側に無く比べられないときは従来どおりテーブル名だけで判定する。
    expect(detectSelfReference(cs, m("cats"), "cats", "shop")).toEqual({ idCol: "id", parentCol: "p" });
  });

  it("referenced_column が無ければ PK を ID にし、結果に無い列は使わない", () => {
    const metas = [meta("id", { key: "PRI" }), meta("up", { referenced_table: "t" })];
    expect(detectSelfReference([col("id"), col("up")], metas, "t")).toEqual({ idCol: "id", parentCol: "up" });
    expect(detectSelfReference([col("id")], metas, "t")).toBeNull();
  });

  it("列名から推測し、当てが無ければ null", () => {
    expect(guessHierarchyColumns(cols)).toEqual({ idCol: "id", parentCol: "parent_id" });
    expect(guessHierarchyColumns([col("a"), col("b")])).toBeNull();
    expect(guessHierarchyColumns([col("parent_id"), col("x")])).toBeNull();
    // id が無いときは無関係な *_id を ID とみなさず、<テーブル名>_id (単数形も) だけを使う。
    expect(guessHierarchyColumns([col("parent_id"), col("user_id")])).toBeNull();
    expect(guessHierarchyColumns([col("parent_id"), col("user_id")], "users")).toEqual({
      idCol: "user_id",
      parentCol: "parent_id",
    });
    expect(guessHierarchyColumns([col("parent_id"), col("category_id")], "category")).toEqual({
      idCol: "category_id",
      parentCol: "parent_id",
    });
  });

  it("ラベル列は名前らしい列を優先し、無ければ ID 列", () => {
    expect(defaultLabelColumn(cols, "id")).toBe("name");
    expect(defaultLabelColumn([col("id"), col("parent_id")], "id")).toBe("id");
  });

  it("保存値は結果の列に照らして検証する", () => {
    expect(sanitizeHierarchyConfig({ idCol: "id", parentCol: "parent_id", labelCol: "name" }, cols)).toEqual({
      idCol: "id",
      parentCol: "parent_id",
      labelCol: "name",
    });
    expect(sanitizeHierarchyConfig({ idCol: "id", parentCol: "gone" }, cols)).toBeNull();
    expect(sanitizeHierarchyConfig({ idCol: "id", parentCol: "id" }, cols)).toBeNull();
    expect(
      sanitizeHierarchyConfig({ idCol: "id", parentCol: "parent_id", labelCol: "zz" }, cols)?.labelCol,
    ).toBe("id");
    expect(sanitizeHierarchyConfig("x", cols)).toBeNull();
  });
});

describe("部分木の取得 SQL", () => {
  const base = { table: "categories", idCol: "id", parentCol: "parent_id", rootValue: 5 as CellValue };

  it("3 方言でクオートし、深さ上限と LIMIT を持つ", () => {
    const my = buildSubtreeSql({ ...base, driver: "mysql", database: "shop", maxDepth: 4, limit: 200 });
    expect(my).toContain("WITH RECURSIVE `subtree` AS (");
    expect(my).toContain("FROM `shop`.`categories` t WHERE t.`id` = 5");
    expect(my).toContain("ON c.`parent_id` = `subtree`.`id`");
    expect(my).toContain("WHERE `subtree`.`__depth` < 4");
    expect(my.trimEnd().endsWith("ORDER BY `__depth` LIMIT 200")).toBe(true);
    const pg = buildSubtreeSql({ ...base, driver: "postgres", database: "public" });
    expect(pg).toContain('FROM "public"."categories" t WHERE t."id" = 5');
    expect(pg).toContain("LIMIT 1000");
    const sl = buildSubtreeSql({ ...base, driver: "sqlite", database: "main" });
    expect(sl).toContain('FROM "categories" t');
    expect(pg).toBe(
      [
        'WITH RECURSIVE "subtree" AS (',
        '  SELECT t.*, 0 AS "__depth" FROM "public"."categories" t WHERE t."id" = 5',
        "  UNION ALL",
        '  SELECT c.*, "subtree"."__depth" + 1 FROM "public"."categories" c JOIN "subtree" ON c."parent_id" = "subtree"."id"',
        '  WHERE "subtree"."__depth" < 10',
        ")",
        'SELECT * FROM "subtree" ORDER BY "__depth" LIMIT 1000',
      ].join("\n"),
    );
    expect(sl).toBe(
      [
        'WITH RECURSIVE "subtree" AS (',
        '  SELECT t.*, 0 AS "__depth" FROM "categories" t WHERE t."id" = 5',
        "  UNION ALL",
        '  SELECT c.*, "subtree"."__depth" + 1 FROM "categories" c JOIN "subtree" ON c."parent_id" = "subtree"."id"',
        '  WHERE "subtree"."__depth" < 10',
        ")",
        'SELECT * FROM "subtree" ORDER BY "__depth" LIMIT 1000',
      ].join("\n"),
    );
  });

  it("名前の衝突を避ける (大文字小文字を区別せず、連番で空きを探す)", () => {
    expect(pickFreeName("subtree", ["a"])).toBe("subtree");
    expect(pickFreeName("subtree", ["Subtree"])).toBe("subtree_1");
    expect(pickFreeName("__depth", ["__depth", "__DEPTH_1"])).toBe("__depth_2");
  });

  it("元テーブルに __depth 列があれば、深さの列名を別名にして一貫して参照する", () => {
    const sql = buildSubtreeSql({ ...base, driver: "sqlite", tableColumns: ["id", "parent_id", "__depth"] });
    expect(sql).toContain('0 AS "__depth_1"');
    expect(sql).toContain('"subtree"."__depth_1" + 1');
    expect(sql).toContain('WHERE "subtree"."__depth_1" < 10');
    expect(sql).toContain('ORDER BY "__depth_1"');
    expect(sql).not.toMatch(/"subtree"\."__depth"/);
  });

  it("元テーブルが subtree という名前でも、CTE 名を別名にして実テーブルと混同しない", () => {
    const sql = buildSubtreeSql({ ...base, table: "subtree", driver: "sqlite", database: "main" });
    expect(sql).toContain('WITH RECURSIVE "subtree_1" AS (');
    expect(sql).toContain('FROM "subtree" t WHERE');
    expect(sql).toContain('FROM "subtree" c JOIN "subtree_1" ON c."parent_id" = "subtree_1"."id"');
    expect(sql).toContain('FROM "subtree_1" ORDER BY');
    // MySQL でも同様 (テーブル名は大文字小文字違いでも衝突扱い)。
    const my = buildSubtreeSql({ ...base, table: "Subtree", driver: "mysql" });
    expect(my).toContain("WITH RECURSIVE `subtree_1` AS (");
  });

  it("文字列の根はリテラル化し、引用符・識別子をエスケープする", () => {
    const sql = buildSubtreeSql({
      driver: "postgres",
      table: 'we"ird',
      idCol: "id",
      parentCol: "p",
      rootValue: "o'neil",
      idType: "VARCHAR",
    });
    expect(sql).toContain('"we""ird"');
    expect(sql).toContain("'o''neil'");
  });

  it("64bit 整数の文字列は丸めずに数値リテラルへ", () => {
    const sql = buildSubtreeSql({
      ...base,
      driver: "mysql",
      rootValue: "9223372036854775807",
      idType: "BIGINT",
    });
    expect(sql).toContain("= 9223372036854775807");
  });

  it("深さと LIMIT は許容範囲へ丸める", () => {
    expect(clampSubtreeDepth(0)).toBe(1);
    expect(clampSubtreeDepth(1000)).toBe(100);
    expect(clampSubtreeDepth(Number.NaN)).toBe(10);
    expect(buildSubtreeSql({ ...base, driver: "sqlite", maxDepth: 9999, limit: 0 })).toMatch(
      /< 100\b[\s\S]*LIMIT 1$/,
    );
  });

  it("MySQL 5.7 では無効、8.0 / MariaDB 10.2 / 版不明 / 他ドライバは有効", () => {
    expect(supportsRecursiveCte("mysql", { major: 5, minor: 7, mariadb: false })).toBe(false);
    expect(supportsRecursiveCte("mysql", { major: 8, minor: 0, mariadb: false })).toBe(true);
    expect(supportsRecursiveCte("mysql", { major: 10, minor: 1, mariadb: true })).toBe(false);
    expect(supportsRecursiveCte("mysql", { major: 10, minor: 2, mariadb: true })).toBe(true);
    expect(supportsRecursiveCte("mysql", null)).toBe(true);
    expect(supportsRecursiveCte("postgres", null)).toBe(true);
    expect(supportsRecursiveCte("sqlite", null)).toBe(true);
  });
});
