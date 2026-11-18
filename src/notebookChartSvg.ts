/**
 * ノートブックの HTML 書き出し (#2421) に埋め込むチャートの SVG 生成。純関数だけで、DOM も外部リソースも使わない。
 *
 * - データは画面の `ChartView` と同じ `chartData.ts` (`buildChartModel` ほか) から作る。
 * - 色は `chartSeriesColors` / `chartValueColors` (単一ソースは `colorScale.ts`) をライト・ダークの両方で解決し、
 *   図ごとの `<style>` に `prefers-color-scheme` 付きで書く。軸・文字は CanvasText 系のシステムカラーなので、
 *   どちらの配色でも文字が消えない。
 * - ユーザ由来の文字列 (ラベル・系列名) はすべて `escapeHtml` を通す。数値は有限値だけを座標に使う。
 */
import {
  buildChartModel,
  type ChartConfig,
  type ChartModel,
  chartSeriesColors,
  chartValueColors,
  comboLineIndex,
  DONUT_INNER_RATIO,
  donutSlicePath,
  isDonut,
  niceTicks,
  paddedExtent,
  splitComboSeries,
  stackLayout,
  valueExtent,
} from "./components/chartData";
import type { CellValue, Column } from "./api/tauri";
import { escapeHtml } from "./markdownLite";

const W = 640;
const H = 320;
const PAD = { l: 56, r: 48, t: 16, b: 52 };
/** 軸ラベルに載せる文字数の上限 (超えたら末尾を … にする)。 */
const LABEL_CHARS = 14;
/** 横軸ラベルを間引く目安の個数。 */
const MAX_X_LABELS = 12;

const f = (n: number): string => String(Number(n.toFixed(2)));

/** 軸目盛り用の短い数値表記。 */
export function formatTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${Number((v / 1e9).toPrecision(3))}G`;
  if (a >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
  if (a >= 1e4) return `${Number((v / 1e3).toPrecision(3))}k`;
  return String(Number(v.toPrecision(6)));
}

/**
 * 目盛りの並び全体をまとめて整形する。短い表記で隣り合う目盛りが同じ文字列になるとき
 * (値が大きく幅が狭い軸。例: 1000000〜1000001 の 10 区間がすべて「1M」) は、
 * 目盛りの最小の間隔から必要な小数桁を決めて省略しない表記に切り替える。
 */
export function formatTicks(values: number[]): string[] {
  const short = values.map(formatTick);
  const collide = values.some(
    (v, i) => i > 0 && v !== values[i - 1] && short[i] === short[i - 1] && short[i] !== "",
  );
  if (!collide) return short;
  let minGap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1];
    const b = values[i];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = Math.abs(b - a);
    if (d > 0 && d < minGap) minGap = d;
  }
  const decimals = Number.isFinite(minGap)
    ? Math.min(12, Math.max(0, Math.ceil(-Math.log10(minGap)) + 1))
    : 0;
  return values.map((v) => (Number.isFinite(v) ? String(Number(v.toFixed(decimals))) : ""));
}

function clip(s: string): string {
  return s.length > LABEL_CHARS ? `${s.slice(0, LABEL_CHARS - 1)}…` : s;
}

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function makeScale(min: number, max: number): Scale {
  const ticks = niceTicks(min, max, 5);
  const lo = Math.min(min, ticks[0] ?? min);
  const hi = Math.max(max, ticks[ticks.length - 1] ?? max);
  return { min: lo, max: hi === lo ? lo + 1 : hi, ticks };
}

function scaleOf(e: { min: number; max: number }): Scale {
  return makeScale(e.min, e.max);
}

function yOf(v: number, s: Scale): number {
  const t = (v - s.min) / (s.max - s.min);
  return PAD.t + (H - PAD.t - PAD.b) * (1 - (Number.isFinite(t) ? t : 0));
}

function yAxis(s: Scale, x: number, side: "l" | "r" = "l"): string {
  const anchor = side === "l" ? "end" : "start";
  const tx = side === "l" ? x - 6 : x + 6;
  const labels = formatTicks(s.ticks);
  return s.ticks
    .map((t, i) => {
      const y = yOf(t, s);
      const grid =
        side === "l" ? `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(y)}" y2="${f(y)}"/>` : "";
      return `${grid}<text class="tick" x="${tx}" y="${f(y + 4)}" text-anchor="${anchor}">${escapeHtml(labels[i] ?? "")}</text>`;
    })
    .join("");
}

function xLabels(labels: string[], xs: number[]): string {
  const step = Math.max(1, Math.ceil(labels.length / MAX_X_LABELS));
  return labels
    .map((l, i) =>
      i % step === 0
        ? `<text class="tick" x="${f(xs[i] ?? 0)}" y="${H - PAD.b + 16}" text-anchor="middle">${escapeHtml(clip(l))}</text>`
        : "",
    )
    .join("");
}

function bandCenters(n: number): { xs: number[]; band: number } {
  const band = (W - PAD.l - PAD.r) / Math.max(1, n);
  return { xs: Array.from({ length: n }, (_, i) => PAD.l + band * (i + 0.5)), band };
}

function linePoints(values: number[], xs: number[], s: Scale): string[] {
  return values.map((v, i) => `${f(xs[i] ?? 0)},${f(yOf(Number.isFinite(v) ? v : 0, s))}`);
}

function barsSvg(model: ChartModel, type: "bar" | "stackedBar", valueColored: boolean): string {
  const n = model.labels.length;
  const { xs, band } = bandCenters(n);
  const stacked = type === "stackedBar";
  const sc = scaleOf(valueExtent(model, type));
  const base = yOf(0, sc);
  const groups = stacked ? 1 : Math.max(1, model.series.length);
  const bw = Math.max(1, (band * 0.7) / groups);
  const layout = stacked ? stackLayout(model) : null;
  const out: string[] = [];
  model.series.forEach((s, si) => {
    for (let i = 0; i < n; i++) {
      const cls = valueColored ? `f${i}` : `f${si}`;
      let y1: number;
      let y2: number;
      if (layout) {
        const seg = layout[si]?.[i];
        if (!seg) continue;
        y1 = yOf(seg.to, sc);
        y2 = yOf(seg.from, sc);
      } else {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        y1 = yOf(v, sc);
        y2 = base;
      }
      const x = stacked ? (xs[i] ?? 0) - bw / 2 : (xs[i] ?? 0) - (bw * groups) / 2 + bw * si;
      out.push(
        `<rect class="${cls}" x="${f(x)}" y="${f(Math.min(y1, y2))}" width="${f(bw)}" height="${f(Math.abs(y2 - y1))}"/>`,
      );
    }
  });
  return `${yAxis(sc, PAD.l)}${out.join("")}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(base)}" y2="${f(base)}"/>${xLabels(model.labels, xs)}`;
}

function linesSvg(model: ChartModel, area: boolean): string {
  const { xs } = bandCenters(model.labels.length);
  const sc = scaleOf(valueExtent(model, area ? "area" : "line"));
  const base = yOf(Math.max(sc.min, Math.min(0, sc.max)), sc);
  const out = model.series.map((s, si) => {
    const pts = linePoints(s.values, xs, sc);
    const areaPath = area
      ? `<polygon class="f${si} fade" points="${f(xs[0] ?? 0)},${f(base)} ${pts.join(" ")} ${f(xs[xs.length - 1] ?? 0)},${f(base)}"/>`
      : "";
    const dots =
      xs.length <= 60
        ? pts
            .map((p) => `<circle class="f${si}" cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="2.5"/>`)
            .join("")
        : "";
    return `${areaPath}<polyline class="k${si} line" points="${pts.join(" ")}"/>${dots}`;
  });
  return `${yAxis(sc, PAD.l)}${out.join("")}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(H - PAD.b)}" y2="${f(H - PAD.b)}"/>${xLabels(model.labels, xs)}`;
}

function comboSvg(model: ChartModel, config: ChartConfig): string {
  const lineName = model.series[comboLineIndex(config)]?.name;
  const { bars, line } = splitComboSeries(model, lineName);
  const barModel: ChartModel = { ...model, series: bars };
  // 色は元の系列順 (凡例と同じ並び) の番号で引く。棒→線の並べ替え後の番号を使うと、
  // 線に選んだ列が最後でないとき凡例の色と図の色が食い違う。
  const colorIndex = (s: (typeof model.series)[number]) => Math.max(0, model.series.indexOf(s));
  const left = scaleOf(valueExtent(barModel, "bar"));
  const { xs, band } = bandCenters(model.labels.length);
  const base = yOf(0, left);
  const bw = Math.max(1, (band * 0.7) / Math.max(1, bars.length));
  const rects = bars
    .map((s, si) =>
      s.values
        .map((v, i) => {
          if (!Number.isFinite(v)) return "";
          const y = yOf(v, left);
          const x = (xs[i] ?? 0) - (bw * bars.length) / 2 + bw * si;
          return `<rect class="f${colorIndex(s)}" x="${f(x)}" y="${f(Math.min(y, base))}" width="${f(bw)}" height="${f(Math.abs(base - y))}"/>`;
        })
        .join(""),
    )
    .join("");
  let lineSvg = "";
  let rightAxis = "";
  if (line) {
    const ci = colorIndex(line);
    const right = scaleOf(valueExtent({ ...model, series: [line] }, "line"));
    const pts = linePoints(line.values, xs, right);
    const dots =
      pts.length <= 60
        ? pts
            .map((p) => `<circle class="f${ci}" cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="2.5"/>`)
            .join("")
        : "";
    lineSvg = `<polyline class="k${ci} line" points="${pts.join(" ")}"/>${dots}`;
    // 右軸は目盛りの文字だけ (格子線は左軸が引く)。右余白 PAD.r に収まる位置に置く。
    rightAxis = yAxis(right, W - PAD.r, "r");
  }
  return `${yAxis(left, PAD.l)}${rects}${lineSvg}${rightAxis}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(base)}" y2="${f(base)}"/>${xLabels(model.labels, xs)}`;
}

function scatterSvg(model: ChartModel): string {
  const xsRaw = model.scatterX ?? [];
  const ex = paddedExtent(xsRaw);
  const ey = paddedExtent(model.series.flatMap((s) => s.values));
  const sx = makeScale(ex.min, ex.max);
  const sy = makeScale(ey.min, ey.max);
  const xOf = (v: number) => PAD.l + ((W - PAD.l - PAD.r) * (v - sx.min)) / (sx.max - sx.min);
  const dots = model.series
    .map((s, si) =>
      s.values
        .map((v, i) => {
          const x = xsRaw[i];
          if (!Number.isFinite(v) || x === undefined || !Number.isFinite(x)) return "";
          return `<circle class="f${si} fade" cx="${f(xOf(x))}" cy="${f(yOf(v, sy))}" r="3.5"/>`;
        })
        .join(""),
    )
    .join("");
  const xLabelsText = formatTicks(sx.ticks);
  const xt = sx.ticks
    .map(
      (t, i) =>
        `<text class="tick" x="${f(xOf(t))}" y="${H - PAD.b + 16}" text-anchor="middle">${escapeHtml(xLabelsText[i] ?? "")}</text>`,
    )
    .join("");
  return `${yAxis(sy, PAD.l)}${dots}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}"/>${xt}`;
}

function histogramSvg(model: ChartModel): string {
  const edges = model.histEdges ?? [];
  const counts = model.series[0]?.values ?? [];
  const sc = makeScale(0, Math.max(0, ...counts.filter((c) => Number.isFinite(c))));
  const lo = edges[0] ?? 0;
  const hi = edges[edges.length - 1] ?? lo;
  const span = hi - lo || 1;
  const xOf = (v: number) => PAD.l + ((W - PAD.l - PAD.r) * (v - lo)) / span;
  const base = yOf(0, sc);
  const rects = counts
    .map((c, i) => {
      if (!Number.isFinite(c)) return "";
      const x0 = hi === lo ? PAD.l + (W - PAD.l - PAD.r) / 4 : xOf(edges[i] ?? lo);
      const x1 = hi === lo ? W - PAD.r - (W - PAD.l - PAD.r) / 4 : xOf(edges[i + 1] ?? hi);
      const y = yOf(c, sc);
      return `<rect class="f0" x="${f(x0)}" y="${f(y)}" width="${f(Math.max(1, x1 - x0 - 1))}" height="${f(base - y)}"/>`;
    })
    .join("");
  const step = Math.max(1, Math.ceil(edges.length / MAX_X_LABELS));
  const edgeLabels = formatTicks(edges);
  const xt = edges
    .map((e, i) =>
      i % step === 0
        ? `<text class="tick" x="${f(hi === lo ? (PAD.l + W - PAD.r) / 2 : xOf(e))}" y="${H - PAD.b + 16}" text-anchor="middle">${escapeHtml(edgeLabels[i] ?? "")}</text>`
        : "",
    )
    .join("");
  return `${yAxis(sc, PAD.l)}${rects}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${f(base)}" y2="${f(base)}"/>${xt}`;
}

function pieSvg(model: ChartModel, config: ChartConfig): string {
  const values = (model.series[0]?.values ?? []).map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return "";
  const cx = W / 2;
  const cy = H / 2;
  const r = Math.min(W, H) / 2 - 16;
  const inner = isDonut(config) ? r * DONUT_INNER_RATIO : 0;
  let a = -Math.PI / 2;
  return values
    .map((v, i) => {
      if (v <= 0) return "";
      const end = a + (v / total) * Math.PI * 2;
      const d = donutSlicePath(cx, cy, r, inner, a, end);
      a = end;
      return `<path class="f${i} slice" fill-rule="evenodd" d="${d}"/>`;
    })
    .join("");
}

/** 図ごとの色 CSS (ライト既定 + ダーク)。クラス名は `f<i>` (塗り) / `k<i>` (線)。 */
function colorCss(scope: string, light: string[], dark: string[]): string {
  const rules = (cols: string[]) =>
    cols
      .map(
        (c, i) =>
          `.${scope} .f${i}{fill:${c}}.${scope} .k${i}{stroke:${c}}.${scope} .sw.f${i}{background:${c}}`,
      )
      .join("");
  return `${rules(light)}@media (prefers-color-scheme: dark){${rules(dark)}}`;
}

export interface ChartSvgResult {
  /** `<figure>` 全体 (図ごとの `<style>` / SVG / 凡例)。描けないときは null。 */
  html: string;
}

/**
 * スナップショットの列・行と `ChartConfig` から、埋め込み用のチャート (`<figure>`) を作る。
 * 描けない (系列が空など) ときは null。`scope` は図ごとの CSS のスコープ名 (英数字とハイフンのみ)。
 * 配色が値の大小を表す (`categorical` 以外の単一系列の棒・円) ときは、点ごとに色を付ける。
 */
export function buildChartFigure(
  columns: Column[],
  rows: CellValue[][],
  config: ChartConfig,
  scope: string,
  ariaLabel: string,
  legendMore?: (n: number) => string,
): ChartSvgResult | null {
  const model = buildChartModel(columns, rows, config);
  if (model.labels.length === 0 || model.series.length === 0) return null;
  const type = config.type;
  const pie = type === "pie";
  // 円は負の値を 0 として描くので、色も画面 (ChartView) と同じくクランプ後の値で決める。
  const first = (model.series[0]?.values ?? []).map((v) => (pie && Number.isFinite(v) ? Math.max(0, v) : v));
  const valueLight =
    (type === "bar" || pie) && (pie || model.series.length === 1)
      ? chartValueColors(first, config.palette, false)
      : null;
  const valueDark = valueLight ? chartValueColors(first, config.palette, true) : null;
  const n = valueLight || pie ? model.labels.length : model.series.length;
  const light = valueLight ?? chartSeriesColors(config.palette, n, false);
  const dark = valueDark ?? chartSeriesColors(config.palette, n, true);
  const colorByLabel = pie || valueLight !== null;

  let inner: string;
  switch (type) {
    case "bar":
    case "stackedBar":
      inner = barsSvg(model, type, valueLight !== null);
      break;
    case "line":
    case "area":
      inner = linesSvg(model, type === "area");
      break;
    case "combo":
      inner = comboSvg(model, config);
      break;
    case "scatter":
      inner = scatterSvg(model);
      break;
    case "histogram":
      inner = histogramSvg(model);
      break;
    case "pie":
      inner = pieSvg(model, config);
      break;
  }
  if (inner === "") return null;

  // 凡例: 系列色の図は系列名、ラベルごとに着色する円・値着色の棒はラベル (上位だけ)。
  const names = colorByLabel && pie ? model.labels : colorByLabel ? [] : model.series.map((s) => s.name);
  const LEGEND_MAX = 20;
  const legendItems = names
    .slice(0, LEGEND_MAX)
    .map((name, i) => `<li><span class="sw f${i}"></span>${escapeHtml(name)}</li>`);
  if (names.length > LEGEND_MAX && legendMore) {
    legendItems.push(`<li>${escapeHtml(legendMore(names.length - LEGEND_MAX))}</li>`);
  }
  const legend = legendItems.length > 1 ? `<ul class="legend">${legendItems.join("")}</ul>` : "";
  const css = colorCss(scope, light, dark);
  return {
    html: `<figure class="chart ${scope}"><style>${css}</style><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ariaLabel)}">${inner}</svg>${legend}</figure>`,
  };
}
