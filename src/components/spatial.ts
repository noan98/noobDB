/**
 * 空間データ (PostGIS の geometry / geography、MySQL の GEOMETRY 系) の純ロジック (#2379)。
 *
 * バックエンド (`db/spatial.rs`) は空間型の値を **EWKT 文字列** (`SRID=4326;POINT(139.76 35.68)`、
 * SRID が 0 のときは接頭辞なしの WKT) にして返す。ここではその文字列の
 *   - 構文チェック付きのパース (インライン編集の書き戻し前検証と形状プレビュー)
 *   - グリッドのセル用の表示 (種別グリフ・SRID 接頭辞を除いた WKT)
 *   - 形状プレビュー (オフラインの SVG) の座標計算 (Y 軸は上が正)
 * を担う。SQLite は SpatiaLite を前提にしないので対象外 (空間型の列が存在しない)。
 */
import type { CellValue } from "../api/tauri";

export type Position = number[];

/** GeoJSON に近い形のジオメトリ。EMPTY は空配列 (Point は `null`) で表す。 */
export type Geometry =
  | { type: "Point"; coordinates: Position | null }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPoint"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] }
  | { type: "GeometryCollection"; geometries: Geometry[] };

export interface ParsedSpatial {
  /** `SRID=n;` 接頭辞の値。無ければ null。 */
  srid: number | null;
  /** 接頭辞を除いた WKT 本体 (前後の空白は除く)。 */
  wkt: string;
  geometry: Geometry;
}

/**
 * 列の型名が空間型か。PostGIS は `geometry` / `geography`、MySQL は sqlx が全空間型を `GEOMETRY`
 * と報告する。PostgreSQL 標準の `point` / `polygon` などは別物 (テキスト表現が違う) なので含めない。
 */
export function isSpatialColumnType(typeName: string): boolean {
  const base = typeName.split("(")[0].trim();
  const last = (base.split(".").pop() ?? base).replace(/"/g, "").trim().toLowerCase();
  return last === "geometry" || last === "geography";
}

const SRID_PREFIX_RE = /^\s*SRID\s*=\s*(\d+)\s*;/i;

/** `SRID=4326;POINT(1 2)` を (SRID, WKT 本体) に分ける。 */
export function splitEwkt(text: string): { srid: number | null; wkt: string } {
  const m = SRID_PREFIX_RE.exec(text);
  if (!m) return { srid: null, wkt: text.trim() };
  return { srid: Number(m[1]), wkt: text.slice(m[0].length).trim() };
}

type Token = { t: "(" | ")" | "," } | { t: "num"; v: number } | { t: "word"; v: string };

const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/;

function tokenize(s: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c });
      i++;
    } else if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z]/.test(s[j])) j++;
      out.push({ t: "word", v: s.slice(i, j).toUpperCase() });
      i = j;
    } else {
      const m = NUM_RE.exec(s.slice(i));
      if (!m) return null;
      const v = Number(m[0]);
      if (!Number.isFinite(v)) return null;
      out.push({ t: "num", v });
      i += m[0].length;
    }
  }
  return out;
}

const MAX_DEPTH = 8;
const TAG_RE =
  /^(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)(ZM|Z|M)?$/;

class Parser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  done(): boolean {
    return this.i >= this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private eat(t: "(" | ")" | ","): boolean {
    const tok = this.peek();
    if (tok && tok.t === t) {
      this.i++;
      return true;
    }
    return false;
  }

  private expect(t: "(" | ")" | ","): void {
    if (!this.eat(t)) throw new Error(`expected ${t}`);
  }

  private eatEmpty(): boolean {
    const tok = this.peek();
    if (tok && tok.t === "word" && tok.v === "EMPTY") {
      this.i++;
      return true;
    }
    return false;
  }

  private position(): Position {
    const p: Position = [];
    for (let tok = this.peek(); tok && tok.t === "num"; tok = this.peek()) {
      p.push(tok.v);
      this.i++;
    }
    if (p.length < 2 || p.length > 4) throw new Error("bad position");
    return p;
  }

  private list<T>(item: () => T): T[] {
    this.expect("(");
    const out = [item()];
    while (this.eat(",")) out.push(item());
    this.expect(")");
    return out;
  }

  private ring(): Position[] {
    if (this.eatEmpty()) return [];
    return this.list(() => this.position());
  }

  private polygon(): Position[][] {
    if (this.eatEmpty()) return [];
    return this.list(() => this.ring());
  }

  geometry(depth: number): Geometry {
    if (depth > MAX_DEPTH) throw new Error("too deep");
    const tok = this.peek();
    if (!tok || tok.t !== "word") throw new Error("expected tag");
    this.i++;
    const m = TAG_RE.exec(tok.v);
    if (!m) throw new Error("unknown tag");
    const next = this.peek();
    if (next && next.t === "word" && (next.v === "Z" || next.v === "M" || next.v === "ZM")) this.i++;
    const empty = this.eatEmpty();
    switch (m[1]) {
      case "POINT": {
        if (empty) return { type: "Point", coordinates: null };
        this.expect("(");
        const p = this.position();
        this.expect(")");
        return { type: "Point", coordinates: p };
      }
      case "LINESTRING":
        return { type: "LineString", coordinates: empty ? [] : this.list(() => this.position()) };
      case "POLYGON":
        return { type: "Polygon", coordinates: empty ? [] : this.list(() => this.ring()) };
      case "MULTIPOINT": {
        if (empty) return { type: "MultiPoint", coordinates: [] };
        // `((1 2),(3 4))` と `(1 2,3 4)` の両方、要素ごとの EMPTY も許す。
        const pts: Position[] = [];
        this.list(() => {
          if (this.eatEmpty()) return;
          if (this.eat("(")) {
            pts.push(this.position());
            this.expect(")");
          } else {
            pts.push(this.position());
          }
        });
        return { type: "MultiPoint", coordinates: pts };
      }
      case "MULTILINESTRING":
        return {
          type: "MultiLineString",
          coordinates: empty ? [] : this.list(() => this.ring()),
        };
      case "MULTIPOLYGON":
        return {
          type: "MultiPolygon",
          coordinates: empty ? [] : this.list(() => this.polygon()),
        };
      default:
        return {
          type: "GeometryCollection",
          geometries: empty ? [] : this.list(() => this.geometry(depth + 1)),
        };
    }
  }
}

/**
 * EWKT / WKT 文字列を構文チェックしてパースする。構文エラーは null。座標の幾何的な妥当性
 * (環が閉じているか等) は見ない (最終判断は DB に任せる、`validateCellInput` の方針と同じ)。
 */
export function parseEwkt(text: string): ParsedSpatial | null {
  const { srid, wkt } = splitEwkt(text);
  if (wkt === "") return null;
  const tokens = tokenize(wkt);
  if (!tokens) return null;
  try {
    const p = new Parser(tokens);
    const geometry = p.geometry(0);
    if (!p.done()) return null;
    return { srid, wkt, geometry };
  } catch {
    return null;
  }
}

/** グリッドのセルに前置する種別グリフ (点・線・面・複合)。 */
export function spatialGlyph(g: Geometry): string {
  switch (g.type) {
    case "Point":
      return "●";
    case "LineString":
      return "∿";
    case "Polygon":
      return "▱";
    case "MultiPoint":
      return "⁘";
    case "MultiLineString":
      return "≋";
    case "MultiPolygon":
      return "▤";
    default:
      return "❖";
  }
}

/** セル値 (EWKT 文字列) を解釈する。文字列以外・パース不能は null。 */
export function parseSpatialCell(v: CellValue): ParsedSpatial | null {
  return typeof v === "string" ? parseEwkt(v) : null;
}

/**
 * 編集欄の入力から、書き戻す EWKT を決める。入力に `SRID=n;` があればそれを、無ければ編集前のセル値の
 * SRID を引き継ぐ (SRID は元の値を保つ)。WKT として読めない入力は null。
 */
export function resolveSpatialInput(raw: string, current?: CellValue): string | null {
  const parsed = parseEwkt(raw);
  if (!parsed) return null;
  const srid = parsed.srid ?? parseSpatialCell(current ?? null)?.srid ?? null;
  return srid === null ? parsed.wkt : `SRID=${srid};${parsed.wkt}`;
}

// ── 形状プレビュー (オフライン SVG) ──

export type ShapePart =
  | { kind: "point"; x: number; y: number }
  | { kind: "line"; d: string }
  | { kind: "polygon"; d: string };

export interface AxisTick {
  /** SVG 座標 (viewBox)。 */
  pos: number;
  label: string;
}

export interface ShapeModel {
  width: number;
  height: number;
  /** 描画領域 (軸と目盛りの内側)。 */
  plot: { x0: number; y0: number; x1: number; y1: number };
  parts: ShapePart[];
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  /** データの範囲 (軸入れ替え後)。 */
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  /** 点の数・形状の数などの有無。座標が 1 つも無い (EMPTY) ときは true。 */
  empty: boolean;
}

const VIEW_W = 360;
const VIEW_H = 240;
const MARGIN = { l: 52, r: 14, t: 10, b: 24 };
const INNER_PAD = 14;

/** 区間 `[min, max]` に収まる「キリの良い」目盛りを最大 `count` 個ほど返す。 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

function tickLabel(v: number, step: number): string {
  if (step <= 0 || !Number.isFinite(step)) return String(v);
  const decimals = Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  return v.toFixed(decimals);
}

function collect(g: Geometry, pts: Position[]): void {
  switch (g.type) {
    case "Point":
      if (g.coordinates) pts.push(g.coordinates);
      break;
    case "LineString":
    case "MultiPoint":
      pts.push(...g.coordinates);
      break;
    case "Polygon":
    case "MultiLineString":
      for (const r of g.coordinates) pts.push(...r);
      break;
    case "MultiPolygon":
      for (const p of g.coordinates) for (const r of p) pts.push(...r);
      break;
    default:
      for (const c of g.geometries) collect(c, pts);
  }
}

/**
 * ジオメトリを SVG の座標へ写す。X は右、**Y は上が正** (SVG の Y を反転する)。縦横は同じ縮尺
 * (座標の 1 単位が縦横で同じ長さ) で、データを描画領域の中央へ収める。`swapXY` は
 * 「緯度, 経度」の軸順で保存される座標系 (MySQL の SRID 4326 など) を、横軸 = 経度で描くための入れ替え。
 */
export function buildShapeModel(geometry: Geometry, swapXY = false): ShapeModel {
  const at = (p: Position): [number, number] => (swapXY ? [p[1], p[0]] : [p[0], p[1]]);
  const all: Position[] = [];
  collect(geometry, all);
  const plot = {
    x0: MARGIN.l,
    y0: MARGIN.t,
    x1: VIEW_W - MARGIN.r,
    y1: VIEW_H - MARGIN.b,
  };
  const base = {
    width: VIEW_W,
    height: VIEW_H,
    plot,
  };
  if (all.length === 0) {
    return {
      ...base,
      parts: [],
      xTicks: [],
      yTicks: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      empty: true,
    };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of all) {
    const [x, y] = at(p);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const bounds = { minX, maxX, minY, maxY };
  let dx = maxX - minX;
  let dy = maxY - minY;
  // 点 1 つなど範囲が 0 のときは、適当な幅 (1 単位) を持たせて中央に置く。
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 1;
  }
  const pw = plot.x1 - plot.x0 - INNER_PAD * 2;
  const ph = plot.y1 - plot.y0 - INNER_PAD * 2;
  const scale = Math.min(dx > 0 ? pw / dx : Infinity, dy > 0 ? ph / dy : Infinity);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const cx = (plot.x0 + plot.x1) / 2;
  const cy = (plot.y0 + plot.y1) / 2;
  const sx = (x: number) => cx + (x - midX) * scale;
  // Y は反転 (緯度・北が上)。
  const sy = (y: number) => cy - (y - midY) * scale;
  const pt = (p: Position): [number, number] => {
    const [x, y] = at(p);
    return [sx(x), sy(y)];
  };
  const fmt = (n: number) => n.toFixed(2);
  const pathOf = (pts: Position[], close: boolean): string => {
    const d = pts.map((p, i) => {
      const [x, y] = pt(p);
      return `${i === 0 ? "M" : "L"}${fmt(x)} ${fmt(y)}`;
    });
    return d.join(" ") + (close ? " Z" : "");
  };
  const parts: ShapePart[] = [];
  const walk = (g: Geometry): void => {
    switch (g.type) {
      case "Point":
        if (g.coordinates) {
          const [x, y] = pt(g.coordinates);
          parts.push({ kind: "point", x, y });
        }
        break;
      case "MultiPoint":
        for (const p of g.coordinates) {
          const [x, y] = pt(p);
          parts.push({ kind: "point", x, y });
        }
        break;
      case "LineString":
        if (g.coordinates.length > 0) parts.push({ kind: "line", d: pathOf(g.coordinates, false) });
        break;
      case "MultiLineString":
        for (const l of g.coordinates) if (l.length > 0) parts.push({ kind: "line", d: pathOf(l, false) });
        break;
      case "Polygon": {
        const d = g.coordinates.filter((r) => r.length > 0).map((r) => pathOf(r, true));
        if (d.length > 0) parts.push({ kind: "polygon", d: d.join(" ") });
        break;
      }
      case "MultiPolygon":
        for (const poly of g.coordinates) {
          const d = poly.filter((r) => r.length > 0).map((r) => pathOf(r, true));
          if (d.length > 0) parts.push({ kind: "polygon", d: d.join(" ") });
        }
        break;
      default:
        for (const c of g.geometries) walk(c);
    }
  };
  walk(geometry);

  // 目盛りは描画領域に見えている範囲 (縦横比を揃えた分、データ範囲より広い) に対して付ける。
  const visMinX = midX - (plot.x1 - plot.x0) / 2 / scale;
  const visMaxX = midX + (plot.x1 - plot.x0) / 2 / scale;
  const visMinY = midY - (plot.y1 - plot.y0) / 2 / scale;
  const visMaxY = midY + (plot.y1 - plot.y0) / 2 / scale;
  const xs = niceTicks(visMinX, visMaxX, 4);
  const ys = niceTicks(visMinY, visMaxY, 3);
  const xStep = xs.length > 1 ? xs[1] - xs[0] : 0;
  const yStep = ys.length > 1 ? ys[1] - ys[0] : 0;
  return {
    ...base,
    parts,
    xTicks: xs.map((v) => ({ pos: sx(v), label: tickLabel(v, xStep) })),
    yTicks: ys.map((v) => ({ pos: sy(v), label: tickLabel(v, yStep) })),
    bounds,
    empty: false,
  };
}

/**
 * 座標が「緯度, 経度」の軸順で保存されているか。MySQL の地理座標系 (SRID 4326) は
 * ST_AsText / ST_GeomFromText / 内部形式のいずれも先頭が緯度。PostGIS は常に経度, 緯度の順。
 */
export function isLatLonAxisOrder(driver: string | undefined, srid: number | null): boolean {
  return driver === "mysql" && srid === 4326;
}
