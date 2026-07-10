/**
 * データ可視化のカラースケール体系 (#525)。
 *
 * 「データを色で符号化する」表面 — チャート系列・ヒートマップ・データバー・
 * (将来) EXPLAIN コストや NULL 率ミニバー — が**各所で独立にパレットを持つと**、
 * (1) 知覚的に不均一、(2) カラーブラインドに不利、(3) ライト/ダークで不統一、
 * という問題が出る。本モジュールはそれらが共有する**単一のスケール体系**を、
 * 副作用のない純ロジックとして定義する。描画側 (`ChartView` / `cellConditionalFormat`)
 * はここを参照し、色定義を二重に持たない。
 *
 * ## スケールの種類
 *
 * - **sequential (連続)**: ヒートマップ / データバー / コスト表現用。単一色相の
 *   明→濃ランプで、値の大小を明度差で表す。赤緑色弱でも明度で読めるため CB セーフ。
 * - **categorical (カテゴリ)**: チャート系列用。隣接系列が識別しやすい順序の離散色。
 * - **diverging (発散)**: 中央値を境に正負を示す用途。中央が淡く両端が濃い 3 点。
 *
 * ## カラーブラインド配慮 (赤緑色弱・第一/第二色覚)
 *
 * - `CATEGORICAL` は Paul Tol / Okabe-Ito 系の知見に基づく**中明度の離散色**で構成し、
 *   先頭ほど明度差を確保して並べる (系列が少ないほど弁別しやすい)。色だけに頼らず、
 *   チャートでは凡例ラベル・ツールチップの系列名を併用して識別できるようにしている。
 * - sequential ランプ (`blue` / `teal`) は単一色相なので、色相の弁別に頼らず明度のみで
 *   大小を読める。既定はこれら CB セーフなランプにする。
 * - diverging ランプ `coolWarm` (青→淡→赤) は直感的だが赤と緑/赤の弁別が苦手な利用者には
 *   不利なため `colorBlindSafe: false`。CB セーフな発散が必要な場合は青→橙の `blueOrange`
 *   を用いる (橙は赤緑色弱でも青と弁別しやすい)。
 * - 検証はカラーブラインドシミュレータ (例: Coblis / Sim Daltonism) で第一・第二・
 *   第三色覚を確認することを推奨する。`theme.ts` のセマンティックカラー CB ガイドと整合。
 *
 * すべて DOM 非依存の純関数なので Vitest で値 → 色のマッピングを直接検証する
 * (`__tests__/colorScale.test.ts`)。
 */

/** ランプの種別。 */
export type RampKind = "sequential" | "diverging";

/** 連続/発散カラーランプ (明→濃 or 端→中→端の hex ストップ列)。 */
export interface ColorRamp {
  /** i18n ラベル解決などに使う安定キー。 */
  key: string;
  kind: RampKind;
  /** カラーブラインド (赤緑色弱) に配慮した安全なランプか。 */
  colorBlindSafe: boolean;
  /** 2 点以上の hex ストップ (`#rrggbb`)。先頭が t=0、末尾が t=1。 */
  stops: string[];
}

/**
 * 連続スケール (sequential)。単一色相の明→濃で、ヒートマップ/データバー/コスト表現に
 * 使う。いずれも色相が 1 つなので赤緑色弱でも明度差で読め、CB セーフ。
 */
export const SEQUENTIAL_RAMPS: Record<string, ColorRamp> = {
  blue: {
    key: "blue",
    kind: "sequential",
    colorBlindSafe: true,
    stops: ["#eff6ff", "#93c5fd", "#1d4ed8"],
  },
  teal: {
    key: "teal",
    kind: "sequential",
    colorBlindSafe: true,
    stops: ["#effcf6", "#7edcc0", "#0f766e"],
  },
};

/**
 * 発散スケール (diverging)。中央が淡く両端が濃い 3 点。中央値を境に正負/高低を
 * 表す用途に使う。`coolWarm` は直感的だが赤緑色弱に不利 (非 CB セーフ)、`blueOrange` は
 * 青↔橙で CB セーフ。
 */
export const DIVERGING_RAMPS: Record<string, ColorRamp> = {
  coolWarm: {
    key: "coolWarm",
    kind: "diverging",
    colorBlindSafe: false,
    stops: ["#2563eb", "#f8fafc", "#dc2626"],
  },
  blueOrange: {
    key: "blueOrange",
    kind: "diverging",
    colorBlindSafe: true,
    stops: ["#2563eb", "#f8fafc", "#d97706"],
  },
};

/**
 * カテゴリスケール (categorical)。チャート系列など離散カテゴリの着色に使う、
 * カラーブラインド配慮の順序付き中明度パレット。先頭ほど明度差を確保しており、
 * 系列が少ないほど弁別しやすい。色だけに頼らずラベル併用を前提とする。
 */
export const CATEGORICAL: string[] = [
  "#4477aa", // blue
  "#ee6677", // rose
  "#228833", // green
  "#ccbb44", // yellow
  "#66ccee", // cyan
  "#aa3377", // purple
  "#ee7733", // orange
  "#bbbbbb", // grey
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

/** [0,1] へクランプ。NaN / 非有限は 0 に倒す (NULL/非数値の安全側)。 */
function clamp01(t: number): number {
  if (!Number.isFinite(t)) return 0;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * 正規化値 `t` (0–1) を hex ストップ列の上の色へ写像し `rgb(...)` 文字列で返す。
 * 隣接ストップを線形補間する。`t` はクランプし、NaN/非有限は 0 (先頭ストップ) に倒す。
 * ストップが 1 つならその色をそのまま返す。
 */
export function sampleRamp(t: number, stops: string[]): string {
  const clamped = clamp01(t);
  if (stops.length === 1) {
    const [r, g, b] = hexToRgb(stops[0]);
    return `rgb(${r}, ${g}, ${b})`;
  }
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const frac = scaled - i;
  const [r1, g1, b1] = hexToRgb(stops[i]);
  const [r2, g2, b2] = hexToRgb(stops[i + 1]);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * frac);
  return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}

/**
 * カテゴリインデックス → 色。`CATEGORICAL` を循環参照する。負値・小数・NaN は
 * 安全に丸めて 0 番目以降へ写す (常に有効な色を返す)。
 */
export function categoricalColor(index: number): string {
  const n = CATEGORICAL.length;
  if (!Number.isFinite(index)) return CATEGORICAL[0];
  const i = ((Math.floor(index) % n) + n) % n;
  return CATEGORICAL[i];
}

/**
 * アクセント色 (`--accent`) 基点の塗り。データバー / NULL 率ミニバー (#718) は
 * ヒートマップ (`heatmapColor`) と異なり、接続ごとに変わる `--accent` CSS 変数に
 * 追従させたいため hex ランプでは表現できない。そこで `color-mix(in srgb,
 * var(--accent) N%, transparent)` という**塗りの生成レシピ**そのものをここへ
 * 集約し、不透明度の段階 (`ACCENT_FILL_STOPS`) を単一ソース化する。これにより
 * `ResultGrid.tsx` (`.cell-databar`) と `ColumnStatsMenu` (NULL 率バー) が
 * 同じ文字列を直書きして二重定義することを防ぐ (#525 コメントの集約先)。
 * DOM 非依存の純関数 (文字列生成のみ) なので Vitest で検証できる。
 */
export const ACCENT_FILL_STOPS = {
  /** データバー (`.cell-databar`) の塗り不透明度。 */
  dataBar: 28,
  /** NULL 率ミニバーの塗り不透明度 (バー本体)。 */
  nullRate: 55,
} as const;

/**
 * アクセント色を `percent`% の不透明度で乗せる `color-mix()` 文字列を返す。
 * `percent` は [0,100] にクランプし、NaN/非有限は 0 (無着色) に倒す。
 */
export function accentFill(percent: number): string {
  const p = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return `color-mix(in srgb, var(--accent) ${p}%, transparent)`;
}

/** 暗い前景インク (黒寄りグレー)。純黒より角が立たない。 */
export const INK_DARK = "#1a1a1a";
/** 明るい前景インク。 */
export const INK_LIGHT = "#ffffff";

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const cs = c / 255;
    return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 2 色 (RGB) の WCAG コントラスト比 (1–21)。 */
function contrastOf(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * `#rrggbb` / `rgb(r, g, b)` のいずれかを RGB 成分へ変換する。`sampleRamp` /
 * `heatmapColor` は `rgb(...)` 文字列を返すため (#525)、`readableInk` はどちらの
 * 表記も受け付ける。パース不能なら `null`。
 */
function parseRgb(color: string): [number, number, number] | null {
  if (/^#[0-9a-fA-F]{6}$/.test(color)) return hexToRgb(color);
  const m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/**
 * 塗り色 `color` (`#rrggbb` または `rgb(r, g, b)`) の上に重ねる文字色を、
 * 濃色 (`INK_DARK`) / 白 (`INK_LIGHT`) のうちコントラスト比が高い方から選ぶ。
 * スライス上のパーセントラベルやヒートマップセルの数値など「色面の上に直接
 * 乗る文字」の可読性を確保する。不正な色文字列には濃インクを返す。
 *
 * 単純な明度しきい値 (0.5 など) で固定的に切り替える方式は、中間輝度の塗り
 * (連続スケールのランプ中間色など) で誤った側を選びやすい (#646 で判明: 連続
 * ランプを塗りに使うヒートマップで、しきい値方式だと一部の中間色でコントラスト
 * 比が 2:1 台まで落ちる組み合わせがあった)。**2 色それぞれとの実コントラスト比を
 * 計算し、高い方を採用する**ことで、任意の塗り色に対し常に「濃色/白のうち
 * 良い方」を選ぶことが数学的に保証される (`INK_DARK` が純黒でないぶんだけ
 * 理論上限よりわずかに低いが、どんな塗り色でも概ね 4:1 台以上のコントラストを
 * 確保できる。`__tests__/colorScale.test.ts` が連続ランプ全域でこの下限を固定)。
 */
export function readableInk(color: string): string {
  const rgb = parseRgb(color);
  if (!rgb) return INK_DARK;
  const dark = contrastOf(hexToRgb(INK_DARK), rgb);
  const light = contrastOf(hexToRgb(INK_LIGHT), rgb);
  return dark >= light ? INK_DARK : INK_LIGHT;
}
