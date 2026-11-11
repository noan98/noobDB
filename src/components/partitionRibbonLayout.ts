// パーティション構成の「範囲の帯」の純ロジック (#2238)。
//
// 構造パネルの一覧の上に置く帯と、パーティション追加ダイアログのゴースト (新しいパーティションが入る位置) の
// セグメントを計算する。描画は PartitionRibbon.tsx。境界の解析は tablePartitions.ts / partitionAdd.ts の既存関数を使う。
//
// - RANGE: 等幅のセグメントを並べる。MAXVALUE / DEFAULT は端 (有限の範囲の後ろ) に置き、PostgreSQL の `FROM..TO` が
//   前の `TO` と食い違う所は「隙間」として印を付ける (MySQL は LESS THAN だけなので隙間は無い)。
// - LIST: 値ごとのタイル。PostgreSQL の HASH は剰余ごとのタイル (MODULUS が揃っていれば未使用の剰余も空きスロット)。
// - サブパーティション (depth > 0) は親のセグメントの 2 段目に細く並べる。

import type { TablePartition, TablePartitions } from "../api/tauri";
import {
  type AddPartitionForm,
  type AddPartitionKind,
  type AddPartitionPlan,
  compareBoundTuple,
  type KeyKind,
} from "./partitionAdd";
import { parseHashBound, parseListBound, parseListValues, parseRangeBound } from "./tablePartitions";

export type RibbonKind = "range" | "list" | "hash" | "other";

export type SegmentKind = "range" | "maxvalue" | "default" | "list" | "hash" | "hashEmpty" | "plain";

/** 平均の何倍を超えたら「偏り」とみなすか。 */
export const HOT_FACTOR = 2;
/** 偏りを判定する最小の件数 (2 件では必ずどちらかが平均の 1 倍以上になり意味がない)。 */
export const HOT_MIN_COUNT = 3;
/** 剰余ごとのスロットを出す MODULUS の上限 (これを超えると既存の子だけを並べる)。 */
export const MAX_HASH_SLOTS = 64;
/** MySQL の HASH / KEY の追加で並べるゴーストの上限。 */
export const MAX_GHOST_ITEMS = 8;

export interface RibbonSub {
  id: string;
  name: string;
  label: string;
  sizeBytes: number | null;
  rows: number | null;
  /** サイズの濃さ (0〜1。同じ親の子のうち最大が 1)。測れなければ null。 */
  heat: number | null;
}

export interface RibbonSegment {
  id: string;
  name: string;
  kind: SegmentKind;
  /** 境界の短い表示 (`2026-01-01 → 2026-02-01` / `< 100` / `a, b` / `modulus 4 / remainder 1`)。 */
  label: string;
  sizeBytes: number | null;
  rows: number | null;
  /** サイズの濃さ (0〜1)。最大のパーティションが 1。測れなければ null。 */
  heat: number | null;
  sizeShare: number | null;
  rowShare: number | null;
  /** 平均を大きく超えるサイズ / 行数 (どちらか)。 */
  hot: boolean;
  /** 直前のセグメントとの間に範囲の隙間がある (PostgreSQL RANGE)。 */
  gapBefore: boolean;
  /** RANGE の下限 / 上限 (キー列ごと)。ゴーストの位置決めに使う。 */
  from: string[] | null;
  to: string[] | null;
  subs: RibbonSub[];
}

export interface PartitionRibbon {
  kind: RibbonKind;
  segments: RibbonSegment[];
}

const parentKey = (schema: string | null, name: string) => `${schema ?? ""}.${name}`;

/** 一覧の行と帯のセグメントを結ぶ ID。 */
export function partitionId(p: Pick<TablePartition, "schema" | "parent" | "name">): string {
  return `${p.schema ?? ""}.${p.parent ?? ""}.${p.name}`;
}

export function ribbonKindOf(method: string): RibbonKind {
  const m = method.trim().toUpperCase();
  if (/^(LINEAR )?RANGE/.test(m)) return "range";
  if (/^LIST/.test(m)) return "list";
  if (/^(LINEAR )?(HASH|KEY)/.test(m)) return "hash";
  return "other";
}

const isMaxTuple = (to: readonly string[]) =>
  to.length > 0 && to.every((v) => v.trim().toUpperCase() === "MAXVALUE");

// ---- 偏り (サイズ / 行数の合計に対する割合) ----

export interface PartitionShare {
  sizeShare: number | null;
  rowShare: number | null;
  /** 平均 (1 / 件数) に対する倍率。 */
  sizeRatio: number | null;
  rowRatio: number | null;
  sizeHot: boolean;
  rowHot: boolean;
}

function shareOf(values: readonly (number | null)[], v: number | null) {
  // 平均と件数は 0 より大きい値だけで数える (空のパーティションを先に作る構成で、他すべてが偏りにならないように)。
  const known = values.filter((x): x is number => x !== null && x > 0);
  const total = known.reduce((a, b) => a + b, 0);
  if (v === null || total <= 0 || known.length === 0) return { share: null, ratio: null, hot: false };
  if (v <= 0) return { share: 0, ratio: 0, hot: false };
  const share = v / total;
  const ratio = share * known.length;
  return { share, ratio, hot: known.length >= HOT_MIN_COUNT && ratio >= HOT_FACTOR };
}

/**
 * 兄弟 (同じ親の直下) ごとに、サイズ / 行数の合計に対する割合と偏りを計算する。キーは `partitionId`。
 * 平均の `HOT_FACTOR` 倍以上 (件数が `HOT_MIN_COUNT` 以上のとき) を偏りとする。
 */
export function partitionShares(partitions: readonly TablePartition[]): Map<string, PartitionShare> {
  const groups = new Map<string, TablePartition[]>();
  for (const p of partitions) {
    const key = `${p.depth}|${p.parent_schema ?? ""}|${p.parent ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  const out = new Map<string, PartitionShare>();
  for (const g of groups.values()) {
    const sizes = g.map((p) => p.size_bytes);
    const rows = g.map((p) => p.row_estimate);
    for (const p of g) {
      const s = shareOf(sizes, p.size_bytes);
      const r = shareOf(rows, p.row_estimate);
      out.set(partitionId(p), {
        sizeShare: s.share,
        rowShare: r.share,
        sizeRatio: s.ratio,
        rowRatio: r.ratio,
        sizeHot: s.hot,
        rowHot: r.hot,
      });
    }
  }
  return out;
}

function heatOf(values: readonly (number | null)[], v: number | null): number | null {
  const max = Math.max(0, ...values.filter((x): x is number => x !== null));
  if (v === null || max <= 0) return null;
  return Math.min(1, Math.max(0, v / max));
}

// ---- 帯の組み立て ----

function rangeLabel(from: string[] | null, to: string[]): string {
  const t = to.join(", ");
  return from === null ? `< ${t}` : `${from.join(", ")} → ${t}`;
}

interface Draft {
  p: TablePartition;
  kind: SegmentKind;
  label: string;
  from: string[] | null;
  to: string[] | null;
}

function classify(driver: string, kind: RibbonKind, p: TablePartition, prevTo: string[] | null): Draft {
  const base = { p, from: null, to: null };
  if (p.is_default || /^default$/i.test(p.bound.trim())) {
    return { ...base, kind: "default", label: "DEFAULT" };
  }
  if (kind === "range") {
    const b = parseRangeBound(p.bound);
    if (b) {
      const from = driver === "mysql" ? prevTo : b.from;
      return {
        p,
        kind: isMaxTuple(b.to) ? "maxvalue" : "range",
        label: rangeLabel(driver === "mysql" ? null : b.from, b.to),
        from,
        to: b.to,
      };
    }
  }
  if (kind === "list") {
    const vals = parseListBound(p.bound);
    if (vals) return { ...base, kind: "list", label: vals.join(", ") };
  }
  const h = parseHashBound(p.bound);
  if (h) return { ...base, kind: "hash", label: `${h.remainder} / ${h.modulus}` };
  return { ...base, kind: "plain", label: p.bound.trim() };
}

/**
 * パーティション一覧から帯のセグメントを作る。`keyKinds` は RANGE のキー列の型 (隙間の判定に使う。unknown は判定しない)。
 * 直下 (depth 0) を並べ、サブパーティションは親 (`parent` 名) のセグメントの `subs` に入れる。
 */
export function buildRibbon(
  driver: string,
  info: Pick<TablePartitions, "method" | "partitions">,
  keyKinds?: readonly KeyKind[],
): PartitionRibbon {
  const kind = ribbonKindOf(info.method);
  const shares = partitionShares(info.partitions);
  const top = info.partitions.filter((p) => p.depth === 0);
  const subsOf = new Map<string, TablePartition[]>();
  for (const p of info.partitions) {
    if (p.depth === 0 || p.parent === null) continue;
    // 別スキーマに同名の親があっても混ざらないよう、(スキーマ, 名前) を鍵にする。
    const key = parentKey(p.parent_schema, p.parent);
    const g = subsOf.get(key);
    if (g) g.push(p);
    else subsOf.set(key, [p]);
  }

  // 並び: 有限の範囲 → MAXVALUE → DEFAULT (入力順は保つ)。
  let prevTo: string[] | null = null;
  const drafts = top.map((p) => {
    const d = classify(driver, kind, p, prevTo);
    if (d.kind === "range" || d.kind === "maxvalue") prevTo = d.to;
    return d;
  });
  const rank = (k: SegmentKind) => (k === "default" ? 2 : k === "maxvalue" ? 1 : 0);
  const ordered = kind === "range" ? orderRange(drafts, rank, keyKinds) : drafts;

  const sizes = top.map((p) => p.size_bytes);
  const segments: RibbonSegment[] = [];
  let prevRangeTo: string[] | null = null;
  for (const d of ordered) {
    const sh = shares.get(partitionId(d.p));
    const subList = subsOf.get(parentKey(d.p.schema, d.p.name)) ?? [];
    const subSizes = subList.map((s) => s.size_bytes);
    let gapBefore = false;
    if (driver === "postgres" && (d.kind === "range" || d.kind === "maxvalue")) {
      if (prevRangeTo !== null && d.from !== null) {
        const c = compareBoundTuple(prevRangeTo, d.from, keyKinds);
        gapBefore = c !== null && c < 0;
      }
    }
    if (d.kind === "range" || d.kind === "maxvalue") prevRangeTo = d.to;
    segments.push({
      id: partitionId(d.p),
      name: d.p.name,
      kind: d.kind,
      label: d.label,
      sizeBytes: d.p.size_bytes,
      rows: d.p.row_estimate,
      heat: heatOf(sizes, d.p.size_bytes),
      sizeShare: sh?.sizeShare ?? null,
      rowShare: sh?.rowShare ?? null,
      hot: !!sh && (sh.sizeHot || sh.rowHot),
      gapBefore,
      from: d.from,
      to: d.to,
      subs: subList.map((s) => ({
        id: partitionId(s),
        name: s.name,
        label: s.is_default ? "DEFAULT" : s.bound.trim(),
        sizeBytes: s.size_bytes,
        rows: s.row_estimate,
        heat: heatOf(subSizes, s.size_bytes),
      })),
    });
  }

  if (kind === "hash") return { kind, segments: withHashSlots(segments, top) };
  return { kind, segments };
}

/**
 * RANGE の並び: 有限の範囲 → MAXVALUE → DEFAULT。有限の範囲は上限の境界順に安定ソートする
 * (PostgreSQL の一覧は名前順なので `p2026_10` が `p2026_2` の前に来る)。1 組でも比べられなければ入力順のまま。
 */
function orderRange(
  drafts: Draft[],
  rank: (k: SegmentKind) => number,
  keyKinds?: readonly KeyKind[],
): Draft[] {
  const byRank = [...drafts].sort((a, b) => rank(a.kind) - rank(b.kind));
  const finite = byRank.filter((d) => d.kind === "range" && d.to !== null);
  if (finite.length !== byRank.filter((d) => d.kind === "range").length) return byRank;
  for (let i = 0; i < finite.length; i++) {
    for (let j = i + 1; j < finite.length; j++) {
      if (compareBoundTuple(finite[i]?.to ?? [], finite[j]?.to ?? [], keyKinds) === null) return byRank;
    }
  }
  const sorted = [...finite].sort((a, b) => compareBoundTuple(a.to ?? [], b.to ?? [], keyKinds) ?? 0);
  let k = 0;
  return byRank.map((d) => (d.kind === "range" ? (sorted[k++] as Draft) : d));
}

/** PostgreSQL の HASH で MODULUS が揃っていれば、剰余 0..MODULUS-1 のスロットに並べ直し、未使用の剰余を空きスロットにする。 */
function withHashSlots(segments: RibbonSegment[], top: readonly TablePartition[]): RibbonSegment[] {
  const bounds = top.map((p) => parseHashBound(p.bound));
  if (bounds.length === 0 || bounds.some((b) => b === null)) return segments;
  const modulus = bounds[0]?.modulus ?? 0;
  if (modulus < 1 || modulus > MAX_HASH_SLOTS || bounds.some((b) => b?.modulus !== modulus)) return segments;
  const byRemainder = new Map<number, RibbonSegment>();
  top.forEach((p, i) => {
    const seg = segments.find((s) => s.id === partitionId(p));
    const b = bounds[i];
    if (seg && b) byRemainder.set(b.remainder, seg);
  });
  const out: RibbonSegment[] = [];
  for (let r = 0; r < modulus; r++) {
    out.push(byRemainder.get(r) ?? emptySlot(r, modulus));
  }
  return out;
}

function emptySlot(remainder: number, modulus: number): RibbonSegment {
  return {
    id: hashSlotId(remainder),
    name: "",
    kind: "hashEmpty",
    label: `${remainder} / ${modulus}`,
    sizeBytes: null,
    rows: null,
    heat: null,
    sizeShare: null,
    rowShare: null,
    hot: false,
    gapBefore: false,
    from: null,
    to: null,
    subs: [],
  };
}

const hashSlotId = (remainder: number) => `hash-slot:${remainder}`;

// ---- 追加ダイアログのゴースト ----

export interface GhostItem {
  key: string;
  /** 入力に追従するラベル。空なら UI が「新しいパーティション」の仮文言を出す。 */
  label: string;
}

export interface RibbonGhost {
  /** 差し込む位置 (`segments` の添字。この手前に入る)。 */
  index: number;
  items: GhostItem[];
  /** ゴーストが置き換える空きスロット (HASH の未使用の剰余) の `id`。 */
  replaces: string | null;
  /** MySQL の REORGANIZE で割られる MAXVALUE のセグメントの `id`。 */
  splitId: string | null;
  /** PostgreSQL で追加時にスキャンされる DEFAULT のセグメントの `id`。 */
  scanId: string | null;
}

const filled = (a: readonly string[]) => a.length > 0 && a.every((v) => v.trim() !== "");

function ghostRangeLabel(driver: string, from: readonly string[], to: readonly string[]): string {
  if (!filled(to)) return "";
  const t = to.map((v) => v.trim()).join(", ");
  if (driver === "mysql") return `< ${t}`;
  return filled(from) ? `${from.map((v) => v.trim()).join(", ")} → ${t}` : `→ ${t}`;
}

/**
 * 追加ダイアログの入力から、帯に差し込むゴーストを決める。
 *
 * - RANGE: 件数ぶんの範囲。位置は、上限が比べられる範囲のうち新しい上限より大きい最初の手前、無ければ末尾
 *   (MAXVALUE / DEFAULT があればその手前)。MySQL で MAXVALUE を REORGANIZE するときは `splitId` に割る対象を、
 *   PostgreSQL で DEFAULT があるときは `scanId` にスキャンされる対象を入れる。
 * - LIST: 入力した値のタイル 1 つを末尾 (DEFAULT の手前) に。
 * - HASH (PostgreSQL): 未使用の剰余のスロットを置き換える。使用済み / 範囲外なら末尾に足す。
 * - HASH / KEY (MySQL): 件数ぶん (最大 `MAX_GHOST_ITEMS`) を末尾に。
 */
export function ghostForAdd(
  driver: string,
  kind: AddPartitionKind,
  ribbon: PartitionRibbon,
  form: AddPartitionForm,
  plan: Pick<AddPartitionPlan, "mode" | "items">,
  keyKinds?: readonly KeyKind[],
): RibbonGhost | null {
  const segs = ribbon.segments;
  const firstSpecial = segs.findIndex((s) => s.kind === "default" || s.kind === "maxvalue");
  const endIndex = firstSpecial === -1 ? segs.length : firstSpecial;
  const none = { replaces: null, splitId: null, scanId: null };

  if (kind === "range") {
    const items: GhostItem[] =
      plan.items.length > 0
        ? plan.items.map((it, i) => ({ key: `g${i}`, label: ghostRangeLabel(driver, it.from, it.to) }))
        : [{ key: "g0", label: ghostRangeLabel(driver, form.from, form.to) }];
    let index = endIndex;
    if (filled(form.to)) {
      // 新しい範囲 (先頭の 1 件) より上限の大きい最初の有限の範囲の手前に入れる。
      const at = segs.findIndex(
        (s) => s.kind === "range" && s.to !== null && (compareBoundTuple(form.to, s.to, keyKinds) ?? 1) < 0,
      );
      if (at !== -1) index = at;
    }
    const split = plan.mode === "reorganize" ? (segs.find((s) => s.kind === "maxvalue")?.id ?? null) : null;
    const scan = driver === "postgres" ? (segs.find((s) => s.kind === "default")?.id ?? null) : null;
    return { index, items, replaces: null, splitId: split, scanId: scan };
  }

  if (kind === "list") {
    const values = parseListValues(form.values).filter((v) => v.trim() !== "");
    const scan = driver === "postgres" ? (segs.find((s) => s.kind === "default")?.id ?? null) : null;
    return {
      index: endIndex,
      items: [{ key: "g0", label: values.map((v) => v.trim()).join(", ") }],
      ...none,
      scanId: scan,
    };
  }

  if (kind === "hash") {
    const rem = form.remainder.trim();
    const mod = form.modulus.trim();
    const label = /^\d+$/.test(rem) && /^\d+$/.test(mod) ? `${Number(rem)} / ${Number(mod)}` : "";
    const slot = /^\d+$/.test(rem) ? segs.findIndex((s) => s.id === hashSlotId(Number(rem))) : -1;
    if (slot !== -1) {
      return {
        index: slot,
        items: [{ key: "g0", label }],
        replaces: segs[slot]?.id ?? null,
        splitId: null,
        scanId: null,
      };
    }
    return { index: segs.length, items: [{ key: "g0", label }], ...none };
  }

  // hashCount (MySQL の HASH / KEY)
  const n = /^\d+$/.test(form.count.trim()) ? Math.min(MAX_GHOST_ITEMS, Math.max(1, Number(form.count))) : 1;
  return {
    index: segs.length,
    items: Array.from({ length: n }, (_, i) => ({ key: `g${i}`, label: "" })),
    ...none,
  };
}
