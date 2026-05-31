import { describe, it, expect } from "vitest";

import type { ForeignKey } from "../api/tauri";
import {
  buildErGraph,
  layoutErGraph,
  nodeHeight,
  MAX_TABLES,
  MAX_VISIBLE_COLUMNS,
  ER_HEADER_HEIGHT,
  ER_ROW_HEIGHT,
} from "../components/erDiagram";

function fk(
  table: string,
  column: string,
  referenced_table: string,
  referenced_column: string | null,
  constraint_name: string | null = null,
): ForeignKey {
  return { table, column, referenced_table, referenced_column, constraint_name };
}

describe("buildErGraph", () => {
  it("creates one node per table with columns in declaration order", () => {
    const graph = buildErGraph({
      tables: [
        { name: "authors", columns: ["id", "name"] },
        { name: "books", columns: ["id", "author_id", "title"] },
      ],
      foreignKeys: [],
    });
    expect(graph.nodes.map((n) => n.id)).toEqual(["authors", "books"]);
    expect(graph.nodes[1].data.columns.map((c) => c.name)).toEqual([
      "id",
      "author_id",
      "title",
    ]);
    expect(graph.totalTables).toBe(2);
    expect(graph.edges).toEqual([]);
  });

  it("marks foreign-key columns and emits one edge per relationship", () => {
    const graph = buildErGraph({
      tables: [
        { name: "authors", columns: ["id", "name"] },
        { name: "books", columns: ["id", "author_id", "title"] },
      ],
      foreignKeys: [fk("books", "author_id", "authors", "id")],
    });
    const books = graph.nodes.find((n) => n.id === "books")!;
    const authorId = books.data.columns.find((c) => c.name === "author_id")!;
    expect(authorId.isFk).toBe(true);
    expect(books.data.columns.find((c) => c.name === "title")!.isFk).toBe(false);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({
      source: "books",
      target: "authors",
      sourceColumn: "author_id",
      targetColumn: "id",
    });
  });

  it("marks primary-key columns from pkByTable", () => {
    const graph = buildErGraph({
      tables: [{ name: "authors", columns: ["id", "name"] }],
      foreignKeys: [],
      pkByTable: { authors: ["id"] },
    });
    const cols = graph.nodes[0].data.columns;
    expect(cols.find((c) => c.name === "id")!.isPk).toBe(true);
    expect(cols.find((c) => c.name === "name")!.isPk).toBe(false);
  });

  it("dedupes identical FK rows but keeps distinct columns of a composite key", () => {
    const graph = buildErGraph({
      tables: [
        { name: "books", columns: ["id", "author_id"] },
        { name: "chapters", columns: ["book_id", "author_id", "seq"] },
      ],
      foreignKeys: [
        fk("chapters", "book_id", "books", "id", "c1"),
        fk("chapters", "author_id", "books", "author_id", "c1"),
        // exact duplicate row should collapse
        fk("chapters", "book_id", "books", "id", "c1"),
      ],
    });
    expect(graph.edges).toHaveLength(2);
  });

  it("keeps self-referencing foreign keys", () => {
    const graph = buildErGraph({
      tables: [{ name: "employees", columns: ["id", "manager_id"] }],
      foreignKeys: [fk("employees", "manager_id", "employees", "id")],
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: "employees", target: "employees" });
  });

  it("caps the per-card column count and reports the hidden remainder", () => {
    const columns = Array.from({ length: MAX_VISIBLE_COLUMNS + 5 }, (_, i) => `c${i}`);
    const graph = buildErGraph({
      tables: [{ name: "wide", columns }],
      foreignKeys: [],
    });
    expect(graph.nodes[0].data.columns).toHaveLength(MAX_VISIBLE_COLUMNS);
    expect(graph.nodes[0].data.hiddenColumns).toBe(5);
  });

  it("caps the number of tables, keeping the most-connected ones", () => {
    const tables = Array.from({ length: MAX_TABLES + 10 }, (_, i) => ({
      name: `t${i}`,
      columns: ["id"],
    }));
    // Give t0 a high degree so it is guaranteed to survive the cap.
    const foreignKeys: ForeignKey[] = Array.from({ length: 5 }, (_, i) =>
      fk(`t${i + 1}`, "id", "t0", "id"),
    );
    const graph = buildErGraph({ tables, foreignKeys });
    expect(graph.nodes).toHaveLength(MAX_TABLES);
    expect(graph.totalTables).toBe(MAX_TABLES + 10);
    expect(graph.nodes.some((n) => n.id === "t0")).toBe(true);
  });

  it("drops edges whose endpoints were removed by the table cap", () => {
    const tables = Array.from({ length: MAX_TABLES + 2 }, (_, i) => ({
      name: `t${i}`,
      columns: ["id"],
    }));
    // An isolated FK between two low-degree tables likely to be culled.
    const foreignKeys: ForeignKey[] = [
      fk(`t${MAX_TABLES + 1}`, "id", `t${MAX_TABLES}`, "id"),
    ];
    const graph = buildErGraph({ tables, foreignKeys });
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });
});

describe("nodeHeight", () => {
  it("grows with visible rows and adds a row for the hidden footer", () => {
    expect(nodeHeight(3, 0)).toBe(ER_HEADER_HEIGHT + 3 * ER_ROW_HEIGHT + 8);
    expect(nodeHeight(3, 2)).toBe(ER_HEADER_HEIGHT + 4 * ER_ROW_HEIGHT + 8);
  });
});

describe("layoutErGraph", () => {
  it("assigns a finite position and size to every node", () => {
    const graph = buildErGraph({
      tables: [
        { name: "authors", columns: ["id", "name"] },
        { name: "books", columns: ["id", "author_id"] },
      ],
      foreignKeys: [fk("books", "author_id", "authors", "id")],
    });
    const positioned = layoutErGraph(graph);
    expect(positioned.nodes).toHaveLength(2);
    for (const n of positioned.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBeGreaterThan(0);
    }
    // rankdir LR ranks the edge source (the referencing table) upstream of its
    // target (the referenced table), so books sits left of authors.
    const authors = positioned.nodes.find((n) => n.id === "authors")!;
    const books = positioned.nodes.find((n) => n.id === "books")!;
    expect(books.x).toBeLessThan(authors.x);
    expect(positioned.edges).toHaveLength(1);
  });
});
