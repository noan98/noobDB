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
  /** 元の値 (React の key などの同一性用)。 */
  value: string;
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

const dig = (s: string, i: number) => s.charCodeAt(i) - 48;
const isDig = (s: string, i: number) => {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
};

/** `YYYY-MM-DD` / `YYYY-MM-DD[ T]HH:MM:SS[.fff]` (タイムゾーン無し) の速い経路。合わなければ NaN。 */
function parseDateFast(s: string): number {
  const n = s.length;
  if (n < 10 || s.charCodeAt(4) !== 45 || s.charCodeAt(7) !== 45) return Number.NaN;
  for (const i of [0, 1, 2, 3, 5, 6, 8, 9]) if (!isDig(s, i)) return Number.NaN;
  const y = dig(s, 0) * 1000 + dig(s, 1) * 100 + dig(s, 2) * 10 + dig(s, 3);
  const mo = dig(s, 5) * 10 + dig(s, 6);
  const d = dig(s, 8) * 10 + dig(s, 9);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return Number.NaN;
  // Date.UTC は 0〜99 年を 1900 年代として読むので、遅い経路 (Date.parse) に任せる
  if (y < 100) return Number.NaN;
  if (n === 10) return Date.UTC(y, mo - 1, d);
  const sep = s.charCodeAt(10);
  if (n < 19 || (sep !== 32 && sep !== 84) || s.charCodeAt(13) !== 58 || s.charCodeAt(16) !== 58) {
    return Number.NaN;
  }
  for (const i of [11, 12, 14, 15, 17, 18]) if (!isDig(s, i)) return Number.NaN;
  let ms = 0;
  if (n > 19) {
    if (s.charCodeAt(19) !== 46 || n < 21) return Number.NaN;
    let scale = 100;
    for (let i = 20; i < n; i++) {
      if (!isDig(s, i)) return Number.NaN;
      ms += dig(s, i) * scale;
      scale /= 10;
    }
    ms = Math.floor(ms);
  }
  return Date.UTC(
    y,
    mo - 1,
    d,
    dig(s, 11) * 10 + dig(s, 12),
    dig(s, 14) * 10 + dig(s, 15),
    dig(s, 17) * 10 + dig(s, 18),
    ms,
  );
}

/** 日付 / 日時のセル値を epoch ms へ (解釈できなければ NaN)。タイムゾーン無しは UTC として読む。 */
export function parseDateMs(v: CellValue): number {
  if (v === null || v === undefined) return Number.NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  if (s === "") return Number.NaN;
  const fast = parseDateFast(s);
  if (!Number.isNaN(fast)) return fast;
  const iso = s.includes(" ") && !s.includes("T") ? s.replace(" ", "T") : s;
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso) && /T/.test(iso);
  return Date.parse(hasZone || !/T/.test(iso) ? iso : `${iso}Z`);
}

function numberOf(v: CellValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return Number.NaN;
  const s = String(v).trim();
  return s === "" ? Number.NaN : Number(s);
}

interface BinPlan {
  oneEach: boolean;
  count: number;
  width: number;
}

/**
 * 再開できる列ごとの集計状態。10 万行の 1 列は 30〜80ms かかるので、`advanceDistribution` で
 * 行方向に少しずつ進め、呼び出し側がスライスの合間に制御を返せるようにする。
 */
export interface DistributionAccumulator {
  mode: DistributionMode;
  colIdx: number;
  kind: CellKind;
  total: number;
  /** 0 = 走査、1 = ビン詰め、2 = 完了。 */
  phase: 0 | 1 | 2;
  pos: number;
  nulls: number;
  nonNull: number;
  seen: Set<CellValue> | null;
  values: Float64Array | null;
  used: number;
  min: number;
  max: number;
  intLike: boolean;
  freq: Map<string, number> | null;
  plan: BinPlan | null;
  bins: DistributionBin[];
  integerBins: boolean;
}

export function createDistributionAccumulator(
  total: number,
  colIdx: number,
  kind: CellKind,
): DistributionAccumulator {
  const mode = distributionModeFor(kind);
  const numeric = mode === "number" || mode === "date";
  return {
    mode,
    colIdx,
    kind,
    total,
    phase: 0,
    pos: 0,
    nulls: 0,
    nonNull: 0,
    seen: numeric ? new Set() : null,
    values: numeric ? new Float64Array(total) : null,
    used: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    intLike: true,
    freq: mode === "top" ? new Map() : null,
    plan: null,
    bins: [],
    integerBins: false,
  };
}

function makeBins(acc: DistributionAccumulator): void {
  const { min, max } = acc;
  const intLike = acc.mode === "number" && acc.intLike;
  if (acc.used === 0) return;
  const span = max - min;
  // 幅が 0 に潰れる (例: [0, MIN_VALUE] を 16 等分すると 0) ときも 1 ビンにまとめる。
  // span が Infinity (例: [-1e308, 1e308]) のときは、引き算の前に割って桁あふれを避ける。
  const widthOf = (count: number) => (Number.isFinite(span) ? span / count : max / count - min / count);
  if (span === 0 || !(widthOf(DIST_BIN_COUNT) > 0)) {
    acc.bins = [{ lo: min, hi: max, count: 0 }];
    acc.integerBins = intLike;
    acc.plan = { oneEach: false, count: 1, width: 0 };
    return;
  }
  const oneEach = intLike && span + 1 <= DIST_BIN_COUNT;
  const count = oneEach ? span + 1 : DIST_BIN_COUNT;
  const width = widthOf(count);
  const bins: DistributionBin[] = [];
  for (let i = 0; i < count; i++) {
    let lo: number;
    let hi: number;
    if (oneEach) {
      lo = min + i;
      hi = lo;
    } else if (intLike) {
      // min を足す前に切り上げる (2^52 以上でも件数と境界がずれない)。
      lo = min + Math.ceil(i * width);
      hi = i === count - 1 ? max : min + Math.ceil((i + 1) * width) - 1;
    } else {
      lo = min + i * width;
      hi = i === count - 1 ? max : min + (i + 1) * width;
    }
    bins.push({ lo, hi, count: 0 });
  }
  acc.bins = bins;
  acc.integerBins = intLike;
  acc.plan = { oneEach, count, width };
}

/** 最大 `maxRows` 行ぶん進める。完了したら true。 */
export function advanceDistribution(
  acc: DistributionAccumulator,
  rows: readonly (readonly CellValue[])[],
  maxRows: number,
): boolean {
  if (acc.phase === 2) return true;
  const { colIdx, mode } = acc;
  const end = Math.min(acc.pos + maxRows, acc.phase === 0 ? acc.total : acc.used);
  if (acc.phase === 0) {
    const { seen, values, freq } = acc;
    for (let i = acc.pos; i < end; i++) {
      const v = rows[i][colIdx];
      if (v === null || v === undefined) {
        acc.nulls++;
        continue;
      }
      acc.nonNull++;
      if (mode === "none") continue;
      if (values && seen) {
        seen.add(v);
        const x = mode === "number" ? numberOf(v) : parseDateMs(v);
        if (Number.isFinite(x)) {
          values[acc.used++] = x;
          if (x < acc.min) acc.min = x;
          if (x > acc.max) acc.max = x;
          if (acc.intLike && !Number.isInteger(x)) acc.intLike = false;
        }
      } else if (freq) {
        const key = String(v);
        freq.set(key, (freq.get(key) ?? 0) + 1);
      }
    }
    acc.pos = end;
    if (acc.pos < acc.total) return false;
    if (acc.values) {
      makeBins(acc);
      acc.phase = acc.plan ? 1 : 2;
      acc.pos = 0;
    } else {
      acc.phase = 2;
    }
    return acc.phase === 2;
  }
  // phase 1: ビン詰め
  const { values, plan, bins, min } = acc;
  if (!values || !plan) {
    acc.phase = 2;
    return true;
  }
  for (let k = acc.pos; k < end; k++) {
    const x = values[k];
    let idx = plan.count === 1 ? 0 : plan.oneEach ? x - min : Math.floor((x - min) / plan.width);
    // 退化した幅・桁あふれで NaN / ±Infinity になっても、端のビンへ寄せて例外にしない。
    if (Number.isNaN(idx) || idx < 0) idx = 0;
    else if (idx >= plan.count) idx = plan.count - 1;
    bins[idx].count++;
  }
  acc.pos = end;
  if (acc.pos >= acc.used) acc.phase = 2;
  return acc.phase === 2;
}

/** 上位 `DIST_TOP_COUNT` 値を全件ソートせず 1 回の走査で選ぶ (件数の降順、同数は値の昇順)。 */
function topEntries(freq: Map<string, number>): [string, number][] {
  const top: [string, number][] = [];
  const better = (a: [string, number], b: [string, number]) => a[1] > b[1] || (a[1] === b[1] && a[0] < b[0]);
  for (const e of freq) {
    if (top.length === DIST_TOP_COUNT && !better(e, top[top.length - 1])) continue;
    let i = top.length;
    while (i > 0 && better(e, top[i - 1])) i--;
    top.splice(i, 0, e);
    if (top.length > DIST_TOP_COUNT) top.pop();
  }
  return top;
}

/** 完了した集計状態から結果を作る。 */
export function finishDistribution(acc: DistributionAccumulator): ColumnDistribution {
  const dist = emptyDistribution(acc.mode, acc.total);
  dist.nulls = acc.nulls;
  if (acc.mode === "none") return dist;
  if (acc.seen) dist.distinct = acc.seen.size;
  else if (acc.freq) dist.distinct = acc.freq.size;
  dist.unique = acc.total >= DIST_UNIQUE_MIN_ROWS && acc.nulls === 0 && dist.distinct === acc.total;
  if (acc.values) {
    dist.bins = acc.bins;
    dist.integerBins = acc.integerBins;
    dist.filterable =
      acc.mode === "number" &&
      acc.bins.length > 0 &&
      Math.abs(acc.min) <= Number.MAX_SAFE_INTEGER &&
      Math.abs(acc.max) <= Number.MAX_SAFE_INTEGER;
  } else if (acc.freq) {
    const top = topEntries(acc.freq);
    dist.top = top.map(([value, count]) => ({
      label: value.length > TOP_LABEL_MAX ? `${value.slice(0, TOP_LABEL_MAX)}…` : value,
      value,
      count,
    }));
    dist.otherCount = acc.nonNull - top.reduce((sum, [, c]) => sum + c, 0);
  }
  return dist;
}

/**
 * 列 `colIdx` の分布を `rows` から一括で計算する (テスト・小さい結果用)。
 * 大きい結果は `advanceDistribution` で分割して進める。
 * @public 本番の createDistributionAccumulator / advanceDistribution / finishDistribution を一括で回す薄いラッパー (テスト用)
 */
export function computeColumnDistribution(
  rows: readonly (readonly CellValue[])[],
  colIdx: number,
  kind: CellKind,
): ColumnDistribution {
  const acc = createDistributionAccumulator(rows.length, colIdx, kind);
  while (!advanceDistribution(acc, rows, Math.max(rows.length, 1))) {
    // 1 回で終わらない (走査 → ビン詰め) ぶんを繰り返す。
  }
  return finishDistribution(acc);
}

/** 非 NULL のうち、分布に載った (解釈できた) 件数。 @public 純ロジックを単体テストするために公開。本番の呼び出し元は無い (#2445 のトリアージで削除せず許可。不要と確認できれば削除する) */
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

/** `x` より小さい最大の倍精度数 (有限の `x` のみ)。 */
function nextDown(x: number): number {
  if (x === 0) return -Number.MIN_VALUE;
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  buf.setBigUint64(0, x > 0 ? bits - 1n : bits + 1n);
  return buf.getFloat64(0);
}

/**
 * ビンのクリックで作る `between` フィルタの境界 (文字列)。整数ビンと最後のビンは両端を含む。
 * 小数列の最後以外のビンは集計が半開区間 `[lo, hi)` なので、包含的な `between` で同じ行集合になるよう
 * 上端を 1 つ下の倍精度数にする (新しい演算子を足さず、ハンドル経由のバックエンド絞り込みにもそのまま通る)。
 */
export function binFilterBounds(d: ColumnDistribution, binIdx: number): { lo: string; hi: string } | null {
  const b = d.bins[binIdx];
  if (!d.filterable || !b) return null;
  const halfOpen = !d.integerBins && binIdx < d.bins.length - 1 && b.hi > b.lo;
  return { lo: String(b.lo), hi: String(halfOpen ? nextDown(b.hi) : b.hi) };
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
