import { describe, expect, it } from "vitest";
import type { ForeignKey, SubsetPreview, SubsetTablePreview } from "../api/tauri";
import {
  assignLane,
  barPercent,
  buildSubsetGraph,
  collapseLanes,
  COLLAPSE_THRESHOLD,
  LANE_VISIBLE,
  layoutEdges,
  tracePathToRoot,
  type SubsetNode,
} from "../components/subsetPreviewModel";

const tp = (table: string, rootRows: number, childRows: number, parentRows: number): SubsetTablePreview => ({
  table,
  rows: rootRows + childRows + parentRows,
  rootRows,
  childRows,
  parentRows,
  columns: [],
});
const fk = (table: string, referenced_table: string): ForeignKey => ({
  table,
  column: "x",
  referenced_table,
  referenced_column: "id",
  constraint_name: null,
});
const preview = (tables: SubsetTablePreview[], extra: Partial<SubsetPreview> = {}): SubsetPreview => ({
  tables,
  totalRows: tables.reduce((s, t) => s + t.rows, 0),
  cycles: [],
  warnings: [],
  ...extra,
});

describe("assignLane", () => {
  it("起点の行があれば起点、子だけなら子、親だけなら親", () => {
    expect(assignLane({ rootRows: 3, childRows: 0, parentRows: 0 })).toBe("root");
    expect(assignLane({ rootRows: 1, childRows: 5, parentRows: 5 })).toBe("root");
    expect(assignLane({ rootRows: 0, childRows: 4, parentRows: 0 })).toBe("child");
    expect(assignLane({ rootRows: 0, childRows: 0, parentRows: 4 })).toBe("parent");
  });
  it("子と親の両方で出た表は行数の多いほう、同数なら親", () => {
    expect(assignLane({ rootRows: 0, childRows: 5, parentRows: 2 })).toBe("child");
    expect(assignLane({ rootRows: 0, childRows: 2, parentRows: 5 })).toBe("parent");
    expect(assignLane({ rootRows: 0, childRows: 3, parentRows: 3 })).toBe("parent");
  });
});

describe("buildSubsetGraph", () => {
  const p = preview(
    [
      tp("orders", 10, 0, 0),
      tp("customers", 0, 0, 4),
      tp("regions", 0, 0, 2),
      tp("items", 0, 30, 0),
      tp("item_notes", 0, 6, 0),
    ],
    {
      warnings: [{ kind: "childTruncated", table: "items", limit: 30 }],
      cycles: [["customers", "regions"]],
    },
  );
  const fks = [
    fk("orders", "customers"),
    fk("customers", "regions"),
    fk("items", "orders"),
    fk("item_notes", "items"),
    fk("orders", "customers"), // 重複
    fk("orders", "orders"), // 自己参照
    fk("orders", "outside"), // プレビュー外
  ];
  const g = buildSubsetGraph(p, fks);

  it("レーン・深さ・最大の深さ", () => {
    const by = Object.fromEntries(g.nodes.map((n) => [n.table, n]));
    expect(by.orders.lane).toBe("root");
    expect(by.orders.depth).toBe(0);
    expect(by.customers.depth).toBe(1);
    expect(by.regions.depth).toBe(2);
    expect(by.items.depth).toBe(1);
    expect(by.item_notes.depth).toBe(2);
    expect(g.parentDepth).toBe(2);
    expect(g.childDepth).toBe(2);
  });
  it("外部キーが分からない表の深さは 1", () => {
    const only = buildSubsetGraph(preview([tp("a", 1, 0, 0), tp("b", 0, 2, 0)]), []);
    expect(only.nodes.find((n) => n.table === "b")?.depth).toBe(1);
  });
  it("行数の割合・打ち切り・循環の印", () => {
    const by = Object.fromEntries(g.nodes.map((n) => [n.table, n]));
    expect(by.items.share).toBe(1);
    expect(by.orders.share).toBeCloseTo(10 / 30);
    expect(by.items.truncations).toEqual([{ kind: "child", limit: 30 }]);
    expect(by.customers.cycle).toBe(true);
    expect(by.orders.cycle).toBe(false);
  });
  it("エッジは重複・自己参照・プレビュー外を除く", () => {
    expect(g.edges).toEqual([
      { from: "orders", to: "customers", labels: ["orders.x → customers.id"] },
      { from: "customers", to: "regions", labels: ["customers.x → regions.id"] },
      { from: "items", to: "orders", labels: ["items.x → orders.id"] },
      { from: "item_notes", to: "items", labels: ["item_notes.x → items.id"] },
    ]);
  });
});

describe("buildSubsetGraph: 子経由の親・辿れない外部キー", () => {
  it("子の親・その親は 1 段目・2 段目になる", () => {
    const p = preview([
      tp("orders", 5, 0, 0),
      tp("order_items", 0, 8, 0),
      tp("products", 0, 0, 3),
      tp("categories", 0, 0, 2),
    ]);
    const g = buildSubsetGraph(p, [
      fk("order_items", "orders"),
      fk("order_items", "products"),
      fk("products", "categories"),
    ]);
    const by = Object.fromEntries(g.nodes.map((n) => [n.table, n]));
    expect(by.products.depth).toBe(1);
    expect(by.categories.depth).toBe(2);
    expect(g.parentDepth).toBe(2);
    expect(by.order_items.references).toEqual(["orders", "products"]);
  });
  it("親と子の両方の行を持つ中継の表 (親レーン) を通っても子の段数が切れない", () => {
    // root → A → C と root → B。B が親として A の行を余分に取り込み、A は親レーンに置かれる。
    const p = preview([tp("root", 2, 0, 0), tp("A", 0, 2, 3), tp("B", 0, 4, 0), tp("C", 0, 6, 0)]);
    const g = buildSubsetGraph(p, [fk("A", "root"), fk("B", "root"), fk("B", "A"), fk("C", "A")]);
    const by = Object.fromEntries(g.nodes.map((n) => [n.table, n]));
    expect(by.A.lane).toBe("parent");
    expect(by.C.depth).toBe(2);
    expect(g.childDepth).toBe(2);
  });
  it("辿れなかった外部キー (unresolvedForeignKey) はエッジにしない", () => {
    const p = preview([tp("a", 1, 0, 0), tp("b", 0, 0, 1)], {
      warnings: [{ kind: "unresolvedForeignKey", table: "a", constraint: "fk_a_b" }],
    });
    const g = buildSubsetGraph(p, [{ ...fk("a", "b"), constraint_name: "fk_a_b" }]);
    expect(g.edges).toEqual([]);
  });
  it("循環の表名を持つ", () => {
    const p = preview([tp("a", 1, 0, 0), tp("b", 0, 0, 1)], { cycles: [["a", "b"]] });
    expect(buildSubsetGraph(p, []).nodes[0].cycleTables).toEqual(["a", "b"]);
  });
});

describe("collapseLanes", () => {
  const mk = (i: number, extra: Partial<SubsetNode> = {}): SubsetNode => ({
    id: `c${i}`,
    table: `c${i}`,
    lane: "child",
    rows: 100 - i,
    rootRows: 0,
    childRows: 100 - i,
    parentRows: 0,
    depth: 1,
    share: 0.5,
    truncations: [],
    cycle: false,
    cycleTables: [],
    references: [],
    ...extra,
  });
  const root = mk(99, { lane: "root", table: "r", id: "r", depth: 0 });

  it("閾値未満は折りたたまない", () => {
    const nodes = [root, ...Array.from({ length: COLLAPSE_THRESHOLD - 2 }, (_, i) => mk(i))];
    expect(collapseLanes(nodes).child.every((i) => i.kind === "node")).toBe(true);
  });
  it("閾値以上は上位だけ残して +N にまとめる", () => {
    const nodes = [root, ...Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) => mk(i))];
    const items = collapseLanes(nodes).child;
    expect(items).toHaveLength(LANE_VISIBLE + 1);
    const more = items[items.length - 1];
    expect(more.kind).toBe("more");
    if (more.kind === "more") {
      expect(more.count).toBe(COLLAPSE_THRESHOLD - LANE_VISIBLE);
      expect(more.tables).not.toContain("c0");
    }
  });
  it("循環・打ち切りの表は必ず残し、起点レーンは折りたたまない", () => {
    const flagged = mk(50, { truncations: [{ kind: "child", limit: 5 }] });
    const nodes = [root, flagged, ...Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) => mk(i))];
    const lanes = collapseLanes(nodes);
    expect(lanes.child.some((i) => i.kind === "node" && i.id === "c50")).toBe(true);
    expect(lanes.root).toHaveLength(1);
  });
  it("あふれが 1 表だけなら +1 にせずそのまま出す", () => {
    const nodes = [root, ...Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) => mk(i))];
    const lanes = collapseLanes(nodes, { laneVisible: COLLAPSE_THRESHOLD - 1 });
    expect(lanes.child.every((i) => i.kind === "node")).toBe(true);
  });
  it("展開済みのレーンは折りたたまない", () => {
    const nodes = [root, ...Array.from({ length: COLLAPSE_THRESHOLD }, (_, i) => mk(i))];
    const lanes = collapseLanes(nodes, { expanded: new Set(["child"]) });
    expect(lanes.child).toHaveLength(COLLAPSE_THRESHOLD);
  });
});

describe("layoutEdges", () => {
  const p = preview([
    tp("orders", 5, 0, 0),
    tp("customers", 0, 0, 2),
    tp("items", 0, 3, 0),
    tp("regions", 0, 0, 1),
  ]);
  const g = buildSubsetGraph(p, [
    fk("orders", "customers"),
    fk("items", "orders"),
    fk("customers", "regions"),
  ]);
  const placed = layoutEdges(collapseLanes(g.nodes), g.edges);

  it("別レーンは縁から縁へ、同じレーンは溝へ張り出す", () => {
    const by = (from: string) => placed.find((e) => e.from === from)?.d ?? "";
    // orders (起点・中央レーン: x 4..7) → customers (親・左レーン: x 0..3)
    expect(by("orders")).toMatch(/^M 4 0\.5 C 3\.5 0\.5, 3\.5 0\.5, 3 0\.5$/);
    // items (子: x 8..11) → orders
    expect(by("items")).toMatch(/^M 8 0\.5 C 7\.5 0\.5, 7\.5 0\.5, 7 0\.5$/);
    // customers → regions は同じ (親) レーンで縦に結ぶ
    expect(by("customers")).toContain("M 3 0.5 C 3.8 0.5, 3.8 1.5, 3 1.5");
  });
  it("折りたたまれた表は +N へ付け替え、同じ項目どうしは捨てる", () => {
    const lanes = collapseLanes(g.nodes);
    lanes.parent = [
      {
        kind: "more",
        id: "more:parent",
        lane: "parent",
        count: 2,
        rows: 3,
        tables: ["customers", "regions"],
      },
    ];
    const out = layoutEdges(lanes, g.edges);
    expect(out.map((e) => e.from)).toEqual(["orders", "items"]);
  });
});

describe("barPercent", () => {
  it("割合に比例し、0 は 0、小さい値でも最低 4%", () => {
    expect(barPercent(0)).toBe(0);
    expect(barPercent(1)).toBe(100);
    expect(barPercent(0.5)).toBe(50);
    expect(barPercent(0.001)).toBe(4);
    expect(barPercent(Number.NaN)).toBe(0);
  });
});

describe("tracePathToRoot (#2293)", () => {
  const p = preview([
    tp("orders", 5, 0, 0),
    tp("customers", 0, 0, 2),
    tp("regions", 0, 0, 1),
    tp("items", 0, 3, 0),
    tp("item_notes", 0, 2, 0),
    tp("lonely", 0, 1, 0),
  ]);
  const g = buildSubsetGraph(p, [
    fk("orders", "customers"),
    fk("customers", "regions"),
    fk("items", "orders"),
    fk("item_notes", "items"),
  ]);
  const edgeNames = (path: ReturnType<typeof tracePathToRoot>) =>
    path.edges.map((e) => `${e.from}>${e.to}`).sort();

  it("子レーンの表は親の方向へ辿って起点まで", () => {
    const path = tracePathToRoot(g, "item_notes");
    expect([...path.tables].sort()).toEqual(["item_notes", "items", "orders"]);
    expect(edgeNames(path)).toEqual(["item_notes>items", "items>orders"]);
    expect(path.edges[0].labels.length).toBeGreaterThan(0);
  });
  it("親レーンの表は子の方向へ辿って起点まで", () => {
    const path = tracePathToRoot(g, "regions");
    expect([...path.tables].sort()).toEqual(["customers", "orders", "regions"]);
    expect(edgeNames(path)).toEqual(["customers>regions", "orders>customers"]);
  });
  it("起点自身・起点へ着かない表はその表だけ", () => {
    expect([...tracePathToRoot(g, "orders").tables]).toEqual(["orders"]);
    expect(tracePathToRoot(g, "orders").edges).toEqual([]);
    expect(tracePathToRoot(g, "lonely").edges).toEqual([]);
    expect([...tracePathToRoot(g, "unknown").tables]).toEqual(["unknown"]);
  });
  it("循環があっても停止し、起点へ着かなければ自身だけ", () => {
    const cp = preview([tp("root", 1, 0, 0), tp("a", 0, 1, 0), tp("b", 0, 1, 0)], {
      cycles: [["a", "b"]],
    });
    // a ⇄ b の循環で、root とは無関係
    const cg = buildSubsetGraph(cp, [fk("a", "b"), fk("b", "a")]);
    const path = tracePathToRoot(cg, "a");
    expect([...path.tables]).toEqual(["a"]);
    expect(path.edges).toEqual([]);
  });
  it("循環が起点へつながっていれば最短の経路が出る", () => {
    const cp = preview([tp("root", 1, 0, 0), tp("a", 0, 1, 0), tp("b", 0, 1, 0)], {
      cycles: [["a", "b"]],
    });
    const cg = buildSubsetGraph(cp, [fk("a", "root"), fk("a", "b"), fk("b", "a")]);
    const path = tracePathToRoot(cg, "b");
    expect(path.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["a>root", "b>a"]);
  });
  it("複数の外部キーの列名は辺にまとまる", () => {
    const mg = buildSubsetGraph(preview([tp("o", 1, 0, 0), tp("c", 0, 0, 1)]), [
      { ...fk("o", "c"), column: "billing_id" },
      { ...fk("o", "c"), column: "shipping_id" },
    ]);
    expect(mg.edges).toHaveLength(1);
    expect(mg.edges[0].labels).toEqual(["o.billing_id → c.id", "o.shipping_id → c.id"]);
  });
  it("子の親 (子経由で取り込まれた表) も、子を通って起点まで辿れる", () => {
    const pg = buildSubsetGraph(
      preview([tp("orders", 5, 0, 0), tp("items", 0, 3, 0), tp("products", 0, 0, 2)]),
      [fk("items", "orders"), fk("items", "products")],
    );
    const path = tracePathToRoot(pg, "products");
    expect([...path.tables].sort()).toEqual(["items", "orders", "products"]);
    expect(edgeNames(path)).toEqual(["items>orders", "items>products"]);
  });
  it("親子両方の行を持つ表も、子の方向と親の方向の両方から探す", () => {
    const pg = buildSubsetGraph(preview([tp("orders", 5, 0, 0), tp("items", 0, 3, 0), tp("both", 0, 1, 2)]), [
      fk("both", "orders"),
      fk("items", "both"),
    ]);
    expect(pg.nodes.find((n) => n.table === "both")?.lane).toBe("parent");
    const path = tracePathToRoot(pg, "both");
    expect(edgeNames(path)).toEqual(["both>orders"]);
  });
  it("子の局面では親だけの表を中継しない", () => {
    // items → products (親だけ) → orders: products 経由では起点へ着かない。
    const pg = buildSubsetGraph(
      preview([tp("orders", 5, 0, 0), tp("items", 0, 3, 0), tp("products", 0, 0, 2)]),
      [fk("items", "products"), fk("products", "orders")],
    );
    const path = tracePathToRoot(pg, "items");
    expect([...path.tables]).toEqual(["items"]);
    expect(path.edges).toEqual([]);
  });
});
