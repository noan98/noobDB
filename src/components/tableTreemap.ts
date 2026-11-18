import { tableMaintenanceHints, type TableStatRow } from "./tableSize";

/**
 * テーブルサイズのツリーマップ (#2408) の純粋ロジック層。
 *
 * 面積 = `total_bytes` のスクワリファイド配置、小さすぎるテーブルの「その他」への集約、
 * サイズ不明 / 0 の表の別枠化、data / index の比率・肥大・インデックス過大・前回比の増加率の算出、
 * キーボード巡回の隣接タイル探索だけを担当し、React / SVG には依存しない
 * (`TableTreemapView.tsx` が描画する)。`src/__tests__/tableTreemap.test.ts` でユニットテストする。
 *
 * 取得できない値は推測で埋めない: サイズ不明 (SQLite の dbstat 非搭載など) は `unknown`、
 * data / index の内訳が片方でも不明なら `dataShare = null` (塗り分けず単色)、
 * 肥大は PostgreSQL の統計が取れた表だけ (`tableMaintenanceHints`)。
 */

export interface TreemapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 集約タイルの id。テーブル名と衝突しない値にする (制御文字を含む)。 */
export const TREEMAP_OTHER_ID = "\u0000other";

/** 全体に対する面積の割合がこれ未満のテーブルは「その他」へ集約する。 */
export const TREEMAP_MIN_SHARE = 0.004;
/** 描画するタイル数の上限 (超えた小さい順の表は「その他」へ)。 */
export const TREEMAP_MAX_TILES = 150;
/** インデックスが data を超え、かつこのバイト数以上なら「インデックス過大」とみなす (1 MiB)。 */
export const INDEX_HEAVY_MIN_BYTES = 1024 * 1024;

/**
 * 面積が `value` に比例する矩形を `rect` へ敷き詰める (Bruls らのスクワリファイド配置)。
 * 値が 0 以下・非有限の項目は除外する。入力は不変で、結果は値の降順 (同値は入力順)。
 */
export function squarify<T extends { value: number }>(
  items: readonly T[],
  rect: TreemapRect,
): Array<T & TreemapRect> {
  const valid = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => Number.isFinite(item.value) && item.value > 0)
    .sort((a, b) => b.item.value - a.item.value || a.i - b.i)
    .map(({ item }) => item);
  const total = valid.reduce((s, it) => s + it.value, 0);
  if (valid.length === 0 || total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const scale = (rect.w * rect.h) / total;
  const out: Array<T & TreemapRect> = [];
  let { x, y, w, h } = rect;
  let rest = valid.map((item) => ({ item, area: item.value * scale }));

  // 辺 `side` に沿って並べた行の最悪アスペクト比。
  const worst = (areas: number[], side: number): number => {
    const sum = areas.reduce((s, a) => s + a, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (rest.length > 0) {
    const side = Math.min(w, h);
    const row: typeof rest = [];
    let n = 0;
    while (n < rest.length) {
      const next = rest[n];
      const areas = row.map((r) => r.area);
      if (row.length === 0 || worst(areas, side) >= worst([...areas, next.area], side)) {
        row.push(next);
        n += 1;
      } else {
        break;
      }
    }
    rest = rest.slice(n);
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (w >= h) {
      // 左端に縦の列を置く。
      const colW = rest.length === 0 ? w : Math.min(w, rowArea / h);
      let cy = y;
      for (const r of row) {
        const ch = colW > 0 ? r.area / colW : 0;
        out.push({ ...r.item, x, y: cy, w: colW, h: ch });
        cy += ch;
      }
      x += colW;
      w -= colW;
    } else {
      // 上端に横の行を置く。
      const rowH = rest.length === 0 ? h : Math.min(h, rowArea / w);
      let cx = x;
      for (const r of row) {
        const cw = rowH > 0 ? r.area / rowH : 0;
        out.push({ ...r.item, x: cx, y, w: cw, h: rowH });
        cx += cw;
      }
      y += rowH;
      h -= rowH;
    }
  }
  return out;
}

export interface TreemapTile extends TreemapRect {
  /** テーブル名。集約タイルは `TREEMAP_OTHER_ID`。 */
  id: string;
  /** 面積の値 (`total_bytes`、集約タイルは合計)。 */
  value: number;
  /** 全体 (描画対象の合計) に対する割合 (0〜1)。 */
  share: number;
  /** data / (data + index)。どちらかが不明、または合計 0 なら null (塗り分けない)。 */
  dataShare: number | null;
  /** 元の行。集約タイルは null。 */
  row: TableStatRow | null;
  /** 集約タイルに含まれるテーブル数 (通常タイルは 1)。 */
  count: number;
  /** 集約タイルに含まれるテーブル名 (通常タイルは自身のみ)。 */
  members: string[];
  bloated: boolean;
  staleStats: boolean;
  indexHeavy: boolean;
  /** 前回取得からの合計サイズの増加率 (0.1 = +10%)。増加していない・前回が 0・不明は null。 */
  growth: number | null;
}

export interface TableTreemapLayout {
  tiles: TreemapTile[];
  /** 合計サイズが不明 (null) のテーブル名。別枠で並べる。 */
  unknown: string[];
  /** 合計サイズが 0 のテーブル名。 */
  empty: string[];
  /** 面積に使った合計バイト数。 */
  totalBytes: number;
}

/** 前回比の増加率。増えていなければ null (減少は矢印を出さない)。 */
export function growthRate(row: Pick<TableStatRow, "total_bytes" | "change">): number | null {
  const delta = row.change?.totalBytes;
  const now = row.total_bytes;
  if (delta == null || now == null || delta <= 0) return null;
  const before = now - delta;
  return before > 0 ? delta / before : null;
}

/** インデックスが data より大きい (かつ一定サイズ以上) 表。どちらか不明なら false。 */
export function isIndexHeavy(row: Pick<TableStatRow, "data_bytes" | "index_bytes">): boolean {
  const d = row.data_bytes;
  const i = row.index_bytes;
  return d != null && i != null && i > d && i >= INDEX_HEAVY_MIN_BYTES;
}

/**
 * 行からツリーマップの配置を作る。面積は `total_bytes`。
 * - 不明 (null) は `unknown`、0 は `empty` へ分け、面積に使わない。
 * - 全体に対する割合が `minShare` 未満の表、および上限 `maxTiles` を超えた分は、
 *   2 件以上あるときだけ 1 つの「その他」タイルへ集約する。
 */
export function layoutTableTreemap(
  rows: readonly TableStatRow[],
  size: { width: number; height: number },
  nowMs: number,
  opts: { minShare?: number; maxTiles?: number } = {},
): TableTreemapLayout {
  const minShare = opts.minShare ?? TREEMAP_MIN_SHARE;
  const maxTiles = Math.max(2, opts.maxTiles ?? TREEMAP_MAX_TILES);
  const unknown: string[] = [];
  const empty: string[] = [];
  const sized: Array<{ row: TableStatRow; value: number }> = [];
  for (const row of rows) {
    const v = row.total_bytes;
    if (v == null || !Number.isFinite(v) || v < 0) unknown.push(row.name);
    else if (v === 0) empty.push(row.name);
    else sized.push({ row, value: v });
  }
  sized.sort((a, b) => b.value - a.value || a.row.name.localeCompare(b.row.name));
  const totalBytes = sized.reduce((s, r) => s + r.value, 0);

  const kept: typeof sized = [];
  const small: typeof sized = [];
  sized.forEach((r, i) => {
    if (r.value / totalBytes < minShare || i >= maxTiles - 1) small.push(r);
    else kept.push(r);
  });
  // 1 件だけの集約は意味がないので通常タイルへ戻す。
  if (small.length === 1) kept.push(small.pop() as (typeof sized)[number]);

  const items: Array<{
    id: string;
    value: number;
    row: TableStatRow | null;
    count: number;
    members: string[];
  }> = kept.map((r) => ({ id: r.row.name, value: r.value, row: r.row, count: 1, members: [r.row.name] }));
  if (small.length > 1) {
    items.push({
      id: TREEMAP_OTHER_ID,
      value: small.reduce((s, r) => s + r.value, 0),
      row: null,
      count: small.length,
      members: small.map((r) => r.row.name),
    });
  }

  const placed = squarify(items, { x: 0, y: 0, w: size.width, h: size.height });
  const tiles: TreemapTile[] = placed.map((p) => {
    const row = p.row;
    const hints = row ? tableMaintenanceHints(row, nowMs) : null;
    const d = row?.data_bytes;
    const i = row?.index_bytes;
    const dataShare = d != null && i != null && d + i > 0 ? d / (d + i) : null;
    return {
      ...p,
      share: totalBytes > 0 ? p.value / totalBytes : 0,
      dataShare,
      bloated: hints?.bloated ?? false,
      staleStats: hints?.staleStats ?? false,
      indexHeavy: row ? isIndexHeavy(row) : false,
      growth: row ? growthRate(row) : null,
    };
  });
  return { tiles, unknown, empty, totalBytes };
}

export type TreemapDirection = "left" | "right" | "up" | "down";

/**
 * キーボード巡回用に、`fromId` のタイルから見て指定方向で最も近いタイルの id を返す。
 * 方向の半平面にある中心のうち、(主軸の距離 + 副軸のずれの 2 倍) が最小のもの。無ければ null。
 */
export function neighborTile(
  tiles: ReadonlyArray<TreemapRect & { id: string }>,
  fromId: string,
  dir: TreemapDirection,
): string | null {
  const from = tiles.find((t) => t.id === fromId);
  if (!from) return null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: { id: string; score: number } | null = null;
  for (const t of tiles) {
    if (t.id === fromId) continue;
    const dx = t.x + t.w / 2 - cx;
    const dy = t.y + t.h / 2 - cy;
    const main = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    if (main <= 0) continue;
    const cross = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = main + cross * 2;
    if (!best || score < best.score) best = { id: t.id, score };
  }
  return best ? best.id : null;
}

/** ラベル幅の概算に使う 1 文字あたりの幅 / タイル内側の余白 (viewBox 単位)。 */
export const TREEMAP_CHAR_W = 7;
export const TREEMAP_PAD = 6;
/** 増加率 (▲ + NN%) を出すのに必要なタイル幅の下限。 */
const GROWTH_MIN_WIDTH = 90;
/** 増加率を並べても、名前をこの文字数 (名前が短ければその全長) は残す。 */
const NAME_MIN_CHARS = 4;

export interface TreemapLabelLayout {
  /** 切り詰め済みのテーブル名 (入らなければ空)。 */
  name: string;
  /** 右上に出す増加率の文字 (例 "12%")。省いたら空。 */
  growth: string;
  /** 増加率の三角の左端 (タイル左端からの距離)。growth が空なら 0。 */
  growthTriangleX: number;
}

/**
 * タイル 1 枚のラベルの配置を決める純関数。増加率は名前と同じ行の右端に出るため、
 * 名前の切り詰め幅から増加率の幅 (三角 + 数字) を引き、名前を `NAME_MIN_CHARS` 文字も
 * 残せない狭いタイルでは増加率のほうを省く。これで名前と増加率が重ならない。
 */
export function layoutTileLabel(name: string, rw: number, growthText: string): TreemapLabelLayout {
  const fit = (width: number): string => {
    const max = Math.floor((width - TREEMAP_PAD * 2) / TREEMAP_CHAR_W);
    if (max < 2) return "";
    return name.length <= max ? name : `${name.slice(0, max - 1)}…`;
  };
  if (growthText && rw >= GROWTH_MIN_WIDTH) {
    // 三角 (約 1 文字) + 数字 + 名前との隙間 1 文字。
    const growthW = (growthText.length + 2) * TREEMAP_CHAR_W;
    const clipped = fit(rw - growthW);
    const need = Math.min(name.length, NAME_MIN_CHARS);
    if (clipped.length >= need && clipped !== "") {
      return {
        name: clipped,
        growth: growthText,
        growthTriangleX: rw - TREEMAP_PAD - growthText.length * TREEMAP_CHAR_W - 10,
      };
    }
  }
  return { name: fit(rw), growth: "", growthTriangleX: 0 };
}
