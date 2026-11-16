import type { CellValue } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";

/**
 * 結果グリッドの列ヘッダに出す「ミニ分布」(#2383) の型別集計 (純関数)。
 *
 * 取得済みの行だけから計算し、DB へは問い合わせない。表示は
 * - 数値 / 日付: 12〜16 ビンのヒストグラム (整数で値の種類が少なければ 1 値 1 ビン)
 * - 文字列 / 列挙 / 真偽値 / 時刻: 上位 3 値の積み上げバー
 * - JSON / BLOB: 分布なし (NULL 率だけ。ヘッダの NULL 率バーが担う)
 * と、全行が一意のとき小さな「unique」バッジ。描画 (`ColumnDistributionStrip.tsx`) は
 * ここの結果を描くだけで、ビンのクリックで作る範囲フィルタの境界もここで決める。
 */

export const DIST_BIN_COUNT = 16;
export const DIST_TOP_COUNT = 3;
/** 候補キー判定 (unique バッジ) に必要な最小行数。 */
export const DIST_UNIQUE_MIN_ROWS = 2;
/** 上位値のラベルを切り詰める文字数。 */
const TOP_LABEL_MAX = 40;

export type DistributionMode = "number" | "date" | "top" | "none";

/** 列の型タグから、どの分布を作るかを決める。 */
export function distributionModeFor(kind: CellKind): DistributionMode {
  switch (kind) {
    case "number":
    case "decimal":
      return "number";
    case "date":
      return "date";
    case "bool":
    case "enum":
    case "string":
    case "time":
      return "top";
    default:
      return "none";
  }
}

export interface DistributionBin {
  /** ビンの下端 (数値 / 日付なら epoch ms)。整数ビンでは含む両端。 */
  lo: number;
  /** ビンの上端。最後のビンだけ最大値 (両端を含む)。 */
  hi: number;
  count: number;
}

export interface TopValue {
  /** 表示用 (長ければ切り詰め済み)。 */
  label: string;
  count: number;
}

export interface ColumnDistribution {
  mode: DistributionMode;
  /** 集計した行数 (NULL を含む)。 */
  total: number;
  nulls: number;
  /** 非 NULL 値の異なり数 (JSON / BLOB は数えない = null)。 */
  distinct: number | null;
  /** 全行が非 NULL で一意。 */
  unique: boolean;
  /** number / date のヒストグラム (値が解釈できなければ空)。 */
  bins: DistributionBin[];
  /** ビンが整数の閉区間か (範囲フィルタの境界の作り方が変わる)。 */
  integerBins: boolean;
  /** ビンのクリックで範囲フィルタを作ってよいか (数値で、安全整数の範囲に収まる)。 */
  filterable: boolean;
  /** top モードの上位値。 */
  top: TopValue[];
  /** top に入らなかった非 NULL 値の件数。 */
  otherCount: number;
}

function emptyDistribution(mode: DistributionMode, total: number): ColumnDistribution {
  return {
    mode,
    total,
    nulls: 0,
    distinct: null,
    unique: false,
    bins: [],
    integerBins: false,
    filterable: false,
    top: [],
    otherCount: 0,
  };
}

/** 日付 / 日時のセル値を epoch ms へ (解釈できなければ NaN)。タイムゾーン無しは UTC として読む。 */
export function parseDateMs(v: CellValue): number {
  if (v === null || v === undefined) return Number.NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s === "") return Number.NaN;
  const iso = s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s;
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso) && /T/.test(iso);
  const ms = Date.parse(hasZone || !/T/.test(iso) ? iso : `${iso}Z`);
  return ms;
}

function numberOf(v: CellValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return Number.NaN;
  const s = String(v).trim();
  return s === "" ? Number.NaN : Number(s);
}

/** 値の最小・最大から、ヒストグラムのビンを作る。 */
function buildBins(
  values: Float64Array,
  n: number,
  min: number,
  max: number,
  intLike: boolean,
): { bins: DistributionBin[]; integerBins: boolean } {
  if (n === 0) return { bins: [], integerBins: false };
  const span = max - min;
  if (span === 0) {
    return { bins: [{ lo: min, hi: max, count: n }], integerBins: intLike };
  }
  const oneEach = intLike && span + 1 <= DIST_BIN_COUNT;
  const count = oneEach ? span + 1 : DIST_BIN_COUNT;
  const width = span / count;
  const bins: DistributionBin[] = [];
  for (let i = 0; i < count; i++) {
    let lo: number;
    let hi: number;
    if (oneEach) {
      lo = min + i;
      hi = lo;
    } else if (intLike) {
      lo = Math.ceil(min + i * width);
      hi = i === count - 1 ? max : Math.ceil(min + (i + 1) * width) - 1;
    } else {
      lo = min + i * width;
      hi = i === count - 1 ? max : min + (i + 1) * width;
    }
    bins.push({ lo, hi, count: 0 });
  }
  for (let k = 0; k < n; k++) {
    const x = values[k];
    let idx = oneEach ? x - min : Math.floor((x - min) / width);
    if (idx >= count) idx = count - 1;
    if (idx < 0) idx = 0;
    bins[idx].count++;
  }
  // 整数ビンで幅が 1 未満になり空の区間 (lo > hi) ができる場合は取り除く。
  return { bins: intLike ? bins.filter((b) => b.lo <= b.hi) : bins, integerBins: intLike };
}

/**
 * 列 `colIdx` の分布を `rows` から計算する。`rows` は取得済みの全行 (NULL を含む)。
 * 1 列ぶんで 1 回の走査 + (数値 / 日付は) ビン詰めの 2 周。
 */
export function computeColumnDistribution(
  rows: readonly (readonly CellValue[])[],
  colIdx: number,
  kind: CellKind,
): ColumnDistribution {
  const mode = distributionModeFor(kind);
  const total = rows.length;
  const dist = emptyDistribution(mode, total);
  if (mode === "none") {
    let nulls = 0;
    for (let i = 0; i < total; i++) {
      const v = rows[i][colIdx];
      if (v === null || v === undefined) nulls++;
    }
    dist.nulls = nulls;
    return dist;
  }

  let nulls = 0;
  const seen = new Set<CellValue>();
  const numeric = mode === "number" || mode === "date";
  const values = numeric ? new Float64Array(total) : null;
  let used = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let intLike = true;
  const freq = mode === "top" ? new Map<string, number>() : null;
  let nonNull = 0;

  for (let i = 0; i < total; i++) {
    const v = rows[i][colIdx];
    if (v === null || v === undefined) {
      nulls++;
      continue;
    }
    nonNull++;
    seen.add(v);
    if (values) {
      const x = mode === "number" ? numberOf(v) : parseDateMs(v);
      if (Number.isFinite(x)) {
        values[used++] = x;
        if (x < min) min = x;
        if (x > max) max = x;
        if (intLike && !Number.isInteger(x)) intLike = false;
      }
    } else if (freq) {
      const key = String(v);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
  }

  dist.nulls = nulls;
  dist.distinct = seen.size;
  dist.unique = total >= DIST_UNIQUE_MIN_ROWS && nulls === 0 && seen.size === total;

  if (values) {
    // 日付は常に連続量として扱う (整数ミリ秒でも 1 値 1 ビンにはしない)。
    const { bins, integerBins } = buildBins(values, used, min, max, mode === "number" && intLike);
    dist.bins = bins;
    dist.integerBins = integerBins;
    dist.filterable =
      mode === "number" &&
      bins.length > 0 &&
      Math.abs(min) <= Number.MAX_SAFE_INTEGER &&
      Math.abs(max) <= Number.MAX_SAFE_INTEGER;
  } else if (freq) {
    const sorted = [...freq.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const top = sorted.slice(0, DIST_TOP_COUNT);
    dist.top = top.map(([value, count]) => ({
      label: value.length > TOP_LABEL_MAX ? `${value.slice(0, TOP_LABEL_MAX)}…` : value,
      count,
    }));
    dist.otherCount = nonNull - top.reduce((s, [, c]) => s + c, 0);
  }
  return dist;
}

/** 非 NULL のうち、分布に載った (解釈できた) 件数。 */
export function binnedTotal(d: ColumnDistribution): number {
  return d.bins.reduce((s, b) => s + b.count, 0);
}

/** ビンの高さ比 (0..1)。最大のビンを 1 とする。 */
export function binHeightRatios(bins: readonly DistributionBin[]): number[] {
  let peak = 0;
  for (const b of bins) if (b.count > peak) peak = b.count;
  return bins.map((b) => (peak === 0 ? 0 : b.count / peak));
}

/** 上位値の積み上げバーの幅比 (0..1、合計は非 NULL 件数に対する割合。残りは `other`)。 */
export function topWidthRatios(d: ColumnDistribution): { parts: number[]; other: number } {
  const nonNull = d.total - d.nulls;
  if (nonNull <= 0) return { parts: d.top.map(() => 0), other: 0 };
  return { parts: d.top.map((t) => t.count / nonNull), other: d.otherCount / nonNull };
}

/** ビンのクリックで作る `between` フィルタの境界 (文字列)。整数ビンは両端含む、それ以外は上端も含む。 */
export function binFilterBounds(d: ColumnDistribution, binIdx: number): { lo: string; hi: string } | null {
  const b = d.bins[binIdx];
  if (!d.filterable || !b) return null;
  return { lo: String(b.lo), hi: String(b.hi) };
}

function isoDate(ms: number, withTime: boolean): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const s = d.toISOString();
  return withTime ? `${s.slice(0, 10)} ${s.slice(11, 16)}` : s.slice(0, 10);
}

const TWO_DAYS_MS = 2 * 24 * 3600 * 1000;

/** ビンの範囲のラベル (数値は区間、日付は日付 / 日時)。 */
export function binRangeLabel(d: ColumnDistribution, binIdx: number): string {
  const b = d.bins[binIdx];
  if (!b) return "";
  const fmt = (x: number) =>
    Number.isInteger(x) ? x.toLocaleString("en-US") : Number(x.toPrecision(6)).toString();
  if (d.mode === "date") {
    const first = d.bins[0];
    const last = d.bins[d.bins.length - 1];
    const withTime = last.hi - first.lo < TWO_DAYS_MS;
    return b.lo === b.hi
      ? isoDate(b.lo, withTime)
      : `${isoDate(b.lo, withTime)} – ${isoDate(b.hi, withTime)}`;
  }
  return b.lo === b.hi ? fmt(b.lo) : `${fmt(b.lo)} – ${fmt(b.hi)}`;
}
