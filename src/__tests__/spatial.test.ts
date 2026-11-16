import { describe, expect, it } from "vitest";
import {
  type Geometry,
  buildShapeModel,
  isSpatialColumnType,
  niceTicks,
  parseEwkt,
  resolveSpatialInput,
  spatialGlyph,
  splitEwkt,
} from "../components/spatial";
import {
  buildUpdateGroups,
  buildUpdateStatements,
  cellValueFromInput,
  rowEditKey,
  literalFromInput,
  rowValueLiteral,
  setValueFromInput,
  validateCellInput,
  whereEqualsClause,
} from "../components/cellEdit";

const geom = { name: "g", type_name: "geometry" };
const mygeom = { name: "g", type_name: "GEOMETRY" };

describe("isSpatialColumnType", () => {
  it("PostGIS / MySQL の空間型だけを拾い、PostgreSQL 標準の point は含めない", () => {
    for (const t of ["geometry", "GEOGRAPHY", "GEOMETRY", "geometry(Point,4326)", "public.geometry"]) {
      expect(isSpatialColumnType(t), t).toBe(true);
    }
    for (const t of ["point", "polygon", "text", "BLOB", "geometry_columns"]) {
      expect(isSpatialColumnType(t), t).toBe(false);
    }
  });
});

describe("parseEwkt", () => {
  it("SRID 接頭辞と WKT 本体を分ける", () => {
    expect(splitEwkt("SRID=4326;POINT(1 2)")).toEqual({ srid: 4326, wkt: "POINT(1 2)" });
    expect(splitEwkt("POINT(1 2)")).toEqual({ srid: null, wkt: "POINT(1 2)" });
  });

  it("Point / LineString / Polygon / Multi* / GeometryCollection を読める", () => {
    expect(parseEwkt("SRID=4326;POINT(139.76 35.68)")?.geometry).toEqual({
      type: "Point",
      coordinates: [139.76, 35.68],
    });
    expect(parseEwkt("LINESTRING(0 0,1 1)")?.geometry.type).toBe("LineString");
    expect(parseEwkt("POLYGON((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))")?.geometry).toMatchObject({
      type: "Polygon",
    });
    expect(parseEwkt("MULTIPOINT((1 2),(3 4))")?.geometry).toEqual({
      type: "MultiPoint",
      coordinates: [
        [1, 2],
        [3, 4],
      ],
    });
    expect(parseEwkt("MULTIPOINT(1 2, 3 4)")?.geometry.type).toBe("MultiPoint");
    expect(parseEwkt("MULTILINESTRING((0 0,1 1),(2 2,3 3))")?.geometry.type).toBe("MultiLineString");
    expect(parseEwkt("MULTIPOLYGON(((0 0,1 0,1 1,0 0)))")?.geometry.type).toBe("MultiPolygon");
    expect(parseEwkt("GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,5 5))")?.geometry).toMatchObject({
      type: "GeometryCollection",
    });
  });

  it("Z / M / ZM と EMPTY、指数表記、大小文字を許す", () => {
    expect(parseEwkt("POINT Z (1 2 3)")?.geometry).toEqual({ type: "Point", coordinates: [1, 2, 3] });
    expect(parseEwkt("POINTM(1 2 3)")?.geometry.type).toBe("Point");
    expect(parseEwkt("point zm (1 2 3 4)")?.geometry.type).toBe("Point");
    expect(parseEwkt("POINT EMPTY")?.geometry).toEqual({ type: "Point", coordinates: null });
    expect(parseEwkt("SRID=4326;GEOMETRYCOLLECTION EMPTY")?.geometry).toEqual({
      type: "GeometryCollection",
      geometries: [],
    });
    expect(parseEwkt("POINT(1e2 -2.5E-1)")?.geometry).toEqual({ type: "Point", coordinates: [100, -0.25] });
    expect(parseEwkt("SRID=0;POINT(1 2)")?.srid).toBe(0);
  });

  it("構文エラーは null", () => {
    for (const bad of [
      "",
      "POINT",
      "POINT(1)",
      "POINT(1 2 3 4 5)",
      "POINT(1 2",
      "POINT(1 2) x",
      "POINT(a b)",
      "CIRCLE(1 2)",
      "LINESTRING((0 0,1 1))",
      "POLYGON(0 0,1 1)",
      "'); DROP TABLE t; --",
    ]) {
      expect(parseEwkt(bad), bad).toBeNull();
    }
  });
});

describe("resolveSpatialInput", () => {
  it("SRID は入力 > 編集前の値の順に引き継ぐ", () => {
    expect(resolveSpatialInput("POINT(1 2)", "SRID=4326;POINT(0 0)")).toBe("SRID=4326;POINT(1 2)");
    expect(resolveSpatialInput("SRID=3857;POINT(1 2)", "SRID=4326;POINT(0 0)")).toBe("SRID=3857;POINT(1 2)");
    expect(resolveSpatialInput("POINT(1 2)", "POINT(0 0)")).toBe("POINT(1 2)");
    expect(resolveSpatialInput("POINT(1 2)", null)).toBe("POINT(1 2)");
    expect(resolveSpatialInput("nope", null)).toBeNull();
  });
});

describe("書き戻し (編集)", () => {
  it("validateCellInput は WKT の構文エラーを返し、NULL は nullable に従う", () => {
    expect(validateCellInput("POINT(1 2)", "geometry", true)).toBeNull();
    expect(validateCellInput("SRID=4326;POINT(1 2)", "GEOMETRY", false)).toBeNull();
    expect(validateCellInput("POINT(1", "geometry", true)).toBe("editInvalidSpatial");
    expect(validateCellInput("", "geometry", true)).toBe("editInvalidSpatial");
    expect(validateCellInput("NULL", "geometry", true)).toBeNull();
    expect(validateCellInput("NULL", "geometry", false)).toBe("editInvalidNotNull");
  });

  it("literalFromInput は ST_GeomFromText に SRID を引き継ぐ (PG / MySQL)", () => {
    expect(literalFromInput("postgres", "POINT(1 2)", geom, "SRID=4326;POINT(0 0)")).toBe(
      "ST_GeomFromText('POINT(1 2)', 4326)",
    );
    // MySQL は経度, 緯度の順で読ませる (SRID 0 以外)。
    expect(literalFromInput("mysql", "POINT(139.76 35.68)", mygeom, "SRID=4326;POINT(0 0)")).toBe(
      "ST_GeomFromText('POINT(139.76 35.68)', 4326, 'axis-order=long-lat')",
    );
    expect(literalFromInput("mysql", "SRID=0;POINT(1 2)", mygeom, "SRID=4326;POINT(0 0)")).toBe(
      "ST_GeomFromText('POINT(1 2)', 0)",
    );
    expect(literalFromInput("postgres", "POINT(1 2)", geom, null)).toBe("ST_GeomFromText('POINT(1 2)')");
    expect(literalFromInput("postgres", "NULL", geom)).toBe("NULL");
  });

  it("buildUpdateStatements が元の行の SRID を使う", () => {
    const columns = [{ name: "id", type_name: "INT" }, geom];
    const rows = [[1, "SRID=4326;POINT(0 0)"]];
    const out = buildUpdateStatements({
      driver: "postgres",
      database: "public",
      table: "t",
      columns,
      rows,
      pkIndices: [0],
      edits: { [rowEditKey(rows[0], [0], 0)]: { 1: "POINT(139.76 35.68)" } },
    });
    expect(out).toEqual([
      `UPDATE "public"."t" SET "g" = ST_GeomFromText('POINT(139.76 35.68)', 4326) WHERE "id" = 1;`,
    ]);
  });

  it("buildUpdateGroups は spatial 種別で SRID 込みの EWKT を渡す", () => {
    const columns = [{ name: "id", type_name: "INT" }, mygeom];
    const rows = [[1, "SRID=4326;POINT(1 1)"]];
    const { groups } = buildUpdateGroups({
      driver: "mysql",
      database: "d",
      table: "t",
      columns,
      rows,
      pkIndices: [0],
      edits: { [rowEditKey(rows[0], [0], 0)]: { 1: "POINT(35.68 139.76)" } },
    });
    expect(groups[0].set[0].value).toEqual({ kind: "spatial", text: "SRID=4326;POINT(35.68 139.76)" });
    expect(setValueFromInput("POINT(1 2)", mygeom)).toEqual({ kind: "spatial", text: "POINT(1 2)" });
    expect(setValueFromInput("NULL", mygeom)).toEqual({ kind: "null" });
  });

  it("cellValueFromInput は SRID を引き継いだ EWKT を返す", () => {
    expect(cellValueFromInput("POINT(1 2)", geom, "SRID=4326;POINT(0 0)")).toBe("SRID=4326;POINT(1 2)");
  });

  it("行 → SQL と WHERE も空間型を式にする (Undo / コピー用)", () => {
    expect(rowValueLiteral("mysql", "SRID=4326;POINT(1 2)", mygeom)).toBe(
      "ST_GeomFromText('POINT(1 2)', 4326, 'axis-order=long-lat')",
    );
    expect(whereEqualsClause("mysql", mygeom, "SRID=4326;POINT(1 2)")).toBe(
      "ST_Equals(`g`, ST_GeomFromText('POINT(1 2)', 4326, 'axis-order=long-lat'))",
    );
    expect(whereEqualsClause("postgres", geom, "SRID=4326;POINT(1 2)")).toBe(
      `"g" = ST_GeomFromText('POINT(1 2)', 4326)`,
    );
    // SQLite は空間型を持たないので従来どおりの文字列。
    expect(rowValueLiteral("sqlite", "POINT(1 2)", geom)).toBe("'POINT(1 2)'");
  });
});

describe("ドライバ別の空間型判定", () => {
  it("MySQL は point などの具体名も空間型、PostgreSQL 標準の point は対象外", () => {
    for (const t of [
      "point",
      "POLYGON",
      "linestring",
      "multipolygon",
      "geometrycollection",
      "geomcollection",
    ]) {
      expect(isSpatialColumnType(t, "mysql"), t).toBe(true);
      expect(isSpatialColumnType(t, "postgres"), t).toBe(false);
    }
    expect(
      literalFromInput("mysql", "POINT(1 2)", { name: "p", type_name: "point" }, "SRID=4326;POINT(0 0)"),
    ).toBe("ST_GeomFromText('POINT(1 2)', 4326, 'axis-order=long-lat')");
  });

  it("SQLite は GEOMETRY と宣言された列でも空間扱いせず、従来どおり編集できる", () => {
    expect(isSpatialColumnType("GEOMETRY", "sqlite")).toBe(false);
    expect(validateCellInput("anything", "GEOMETRY", true, "sqlite")).toBeNull();
    expect(literalFromInput("sqlite", "POINT(1 2)", mygeom, "SRID=4326;POINT(0 0)")).toBe("'POINT(1 2)'");
    expect(setValueFromInput("POINT(1 2)", mygeom, null, "sqlite")).toEqual({
      kind: "text",
      text: "POINT(1 2)",
    });
    expect(cellValueFromInput("SRID=1;x", mygeom, null, "sqlite")).toBe("SRID=1;x");
    expect(whereEqualsClause("sqlite", mygeom, "POINT(1 2)")).toBe(`"g" = 'POINT(1 2)'`);
  });
});

describe("buildShapeModel", () => {
  it("Y 軸は上が正 (北の点ほど SVG の y が小さい)", () => {
    const m = buildShapeModel({
      type: "MultiPoint",
      coordinates: [
        [0, 0],
        [0, 10],
      ],
    });
    const [south, north] = m.parts;
    expect(south.kind === "point" && north.kind === "point").toBe(true);
    if (south.kind === "point" && north.kind === "point") {
      expect(north.y).toBeLessThan(south.y);
      expect(north.x).toBeCloseTo(south.x);
    }
  });

  it("縦横は同じ縮尺で、東の点ほど右に来る", () => {
    const m = buildShapeModel({
      type: "LineString",
      coordinates: [
        [0, 0],
        [10, 10],
      ],
    });
    expect(m.parts[0].kind).toBe("line");
    expect(m.empty).toBe(false);
    expect(m.bounds).toEqual({ minX: 0, maxX: 10, minY: 0, maxY: 10 });
    const d = (m.parts[0] as { d: string }).d;
    const nums = d.match(/-?\d+\.\d+/g)?.map(Number) ?? [];
    // M x0 y0 L x1 y1: 横の増分と縦の減少量が等しい。
    expect(nums[2] - nums[0]).toBeCloseTo(nums[1] - nums[3]);
    expect(nums[2]).toBeGreaterThan(nums[0]);
  });

  it("swapXY で横軸が 2 番目の座標 (経度) になる", () => {
    const g: Geometry = { type: "Point", coordinates: [35, 139] };
    expect(buildShapeModel(g, true).bounds).toEqual({ minX: 139, maxX: 139, minY: 35, maxY: 35 });
  });

  it("点 1 つ・EMPTY・Polygon の穴を扱う", () => {
    const one = buildShapeModel({ type: "Point", coordinates: [5, 5] });
    expect(one.parts).toHaveLength(1);
    expect(one.xTicks.length).toBeGreaterThan(0);
    expect(buildShapeModel({ type: "Point", coordinates: null }).empty).toBe(true);
    expect(buildShapeModel({ type: "GeometryCollection", geometries: [] }).empty).toBe(true);
    const poly = parseEwkt("POLYGON((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))");
    const m = buildShapeModel(poly?.geometry ?? { type: "Point", coordinates: null });
    expect(m.parts).toHaveLength(1);
    expect((m.parts[0] as { d: string }).d.match(/Z/g)).toHaveLength(2);
  });
});

describe("その他", () => {
  it("niceTicks は範囲内のキリの良い値を返す", () => {
    expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(139.7, 139.8, 4).every((v) => v >= 139.7 && v <= 139.8)).toBe(true);
    expect(niceTicks(1, 1)).toEqual([]);
  });

  it("グリフ", () => {
    expect(spatialGlyph({ type: "Point", coordinates: [0, 0] })).toBe("●");
  });
});

describe("buildShapeModel の頑健性", () => {
  it("座標の幅が極小でも有限時間で返る (目盛りの増分が進まない場合)", () => {
    const m = buildShapeModel({
      type: "LineString",
      coordinates: [
        [139, 35],
        [139.00000000000003, 35],
      ],
    });
    expect(m.parts).toHaveLength(1);
    expect(m.xTicks.length).toBeLessThanOrEqual(64);
  });

  it("niceTicks は表現可能な増分より小さい step でも止まる", () => {
    expect(niceTicks(139, 139.00000000000003)).toEqual([]);
    expect(niceTicks(1e15, 1e15 + 2).length).toBeLessThanOrEqual(64);
  });

  it("15 万点の LineString でも例外にならない", () => {
    const coordinates: [number, number][] = [];
    for (let i = 0; i < 150_000; i++) coordinates.push([i / 1000, (i % 100) / 10]);
    const m = buildShapeModel({ type: "LineString", coordinates });
    expect(m.parts).toHaveLength(1);
    expect(m.empty).toBe(false);
  });

  it("15 万点の Polygon / MultiPolygon / MultiPoint でも例外にならない", () => {
    const ring: [number, number][] = [];
    for (let i = 0; i < 150_000; i++) ring.push([i, i % 7]);
    expect(buildShapeModel({ type: "Polygon", coordinates: [ring] }).parts).toHaveLength(1);
    expect(buildShapeModel({ type: "MultiPolygon", coordinates: [[ring]] }).parts).toHaveLength(1);
    expect(buildShapeModel({ type: "MultiPoint", coordinates: ring }).parts).toHaveLength(150_000);
  });
});
