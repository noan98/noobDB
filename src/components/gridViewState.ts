import type { ColumnFiltersState, SortingState } from "@tanstack/react-table";
import {
  type CondFormatMode,
  DEFAULT_HEAT_PALETTE,
  HEAT_PALETTES,
  THRESHOLD_OPS,
  THRESHOLD_TONES,
  type ThresholdRule,
} from "./cellConditionalFormat";
import { setItemWithEviction, touchLayoutLruForKey } from "./columnLayoutStorage";
import type { ColumnFilter, FilterNullMode, FilterOp } from "./ResultGrid";

/**
 * 結果グリッドのソート状態・列フィルタのテーブル単位永続化 (#677) の純ロジック。
 *
 * #616 で列幅・列順・表示/非表示・ピン留めは結果シェイプ単位で永続化されたが、
 * 同じグリッドのソート状態と列フィルタは素の `useState` のままで、タブを開き直す/
 * 再起動するたびにリセットされていた。「列幅は覚えているのにソートは忘れる」という
 * 非対称を解消するため、列レイアウト (`colStateKeyFrom`) / フッター (`footerStateKeyFrom`)
 * と同じ結果シェイプキー体系へ相乗りさせて保存/復元する。
 *
 * 破損耐性 (#566) の作法に従い、壊れた JSON・型不一致・未知の演算子は破棄して既定
 * (空) へフォールバックする。すべて副作用なし (localStorage 補助を除く) で、
 * `ResultGrid` が消費する。
 */

/** 永続化するソート 1 列分。TanStack の `SortingState` 要素と同型。 */
interface PersistedSort {
  id: string;
  desc: boolean;
}

/** 永続化する列フィルタ 1 件。`id` は列 ID、`value` は構造化フィルタ。 */
interface PersistedFilter {
  id: string;
  value: ColumnFilter;
}

/** テーブル単位で保存するグリッドのビュー状態。全フィールド任意 (無ければ既定)。 */
export interface PersistedGridView {
  /** 複数列ソート (優先順)。 */
  sorting?: PersistedSort[];
  /** 列フィルタ (列 ID → 構造化条件)。 */
  filters?: PersistedFilter[];
  /**
   * 機微カラム表示マスク (#1069) の列単位の上書き (列名 → マスクする/しない)。
   * 列名パターンによる自動判定と異なる指定だけを持つ (`toggleMaskOverride`)。
   * 列 ID (位置) ではなく列名で持つのは、キー自体が列構成の署名を含むうえ、
   * マスクの意図は「その名前の列」に紐づくため。
   */
  masks?: Record<string, boolean>;
}

/**
 * 結果シェイプ (database + table + 列名の並び) から列サイジングキーを作る。
 * `ResultGrid` の列幅・ビュー状態の永続化キーの根で、JSON ビュー (#1113) が同じ
 * 結果のマスク上書き (#1069) を引くのにも使う。列が無ければ undefined。
 */
export function resultShapeSizingKey(
  columns: readonly { name: string }[] | null | undefined,
  database: string | null | undefined,
  table: string | null | undefined,
): string | undefined {
  if (!columns || columns.length === 0) return undefined;
  const signature = JSON.stringify(columns.map((c) => c.name));
  return `noobdb.colsizing.v1::${database ?? ""}::${table ?? ""}::${signature}`;
}

/**
 * 列サイジングキー (`noobdb.colsizing.v1::…`) からビュー状態キーを導出する。
 * `colStateKeyFrom` / `footerStateKeyFrom` と同じ発想で、同一のテーブル署名
 * (database+table+列構成) を引き継ぐ。プレビューペイン (キー無し) では undefined に
 * なり永続化しない。
 */
export function gridViewStateKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.gridview.v1") : undefined;
}

const FILTER_OPS: FilterOp[] = [
  "contains",
  "equals",
  "notEquals",
  "startsWith",
  "endsWith",
  "in",
  "eq",
  "ne",
  "gt",
  "lt",
  "between",
];
const NULL_MODES: FilterNullMode[] = ["any", "only", "exclude"];

function isFilterOp(v: unknown): v is FilterOp {
  return typeof v === "string" && (FILTER_OPS as string[]).includes(v);
}

function isNullMode(v: unknown): v is FilterNullMode {
  return typeof v === "string" && (NULL_MODES as string[]).includes(v);
}

/** 構造化フィルタ値の妥当性検証。未知の演算子・型不一致は捨てる。 */
function isColumnFilter(v: unknown): v is ColumnFilter {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.op === "in" && !(Array.isArray(o.values) && o.values.every((x) => typeof x === "string"))) {
    return false;
  }
  return (
    isFilterOp(o.op) && typeof o.value === "string" && typeof o.value2 === "string" && isNullMode(o.nullMode)
  );
}

function sanitizeSorting(raw: unknown): PersistedSort[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PersistedSort[] = [];
  for (const s of raw) {
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      if (typeof o.id === "string" && typeof o.desc === "boolean") {
        out.push({ id: o.id, desc: o.desc });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function sanitizeMasks(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, boolean> = {};
  let any = false;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") {
      out[k] = v;
      any = true;
    }
  }
  return any ? out : undefined;
}

function sanitizeFilters(raw: unknown): PersistedFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PersistedFilter[] = [];
  for (const f of raw) {
    if (f && typeof f === "object") {
      const o = f as Record<string, unknown>;
      if (typeof o.id === "string" && isColumnFilter(o.value)) {
        out.push({ id: o.id, value: o.value });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * パース済み JSON を妥当なビュー状態に整える。純粋 (ストレージ非依存) なので
 * ユニットテストできる。未知の形・不正なエントリは捨てる。
 */
export function normalizeGridView(parsed: unknown): PersistedGridView {
  if (!parsed || typeof parsed !== "object") return {};
  const o = parsed as Record<string, unknown>;
  const out: PersistedGridView = {};
  const sorting = sanitizeSorting(o.sorting);
  if (sorting) out.sorting = sorting;
  const filters = sanitizeFilters(o.filters);
  if (filters) out.filters = filters;
  const masks = sanitizeMasks(o.masks);
  if (masks) out.masks = masks;
  return out;
}

/**
 * 保存済みビュー状態を読む。壊れた JSON・型不一致・未知の演算子は破棄して既定へ
 * フォールバックする (private mode / quota / 破損に耐える。#566)。
 */
export function readStoredGridView(key: string | undefined): PersistedGridView {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    return normalizeGridView(JSON.parse(raw));
  } catch {
    // ignore (corrupt entry, private mode, quota)
    return {};
  }
}

/**
 * ビュー状態を保存する。実質デフォルト (ソート・列フィルタ・列マスクの上書きがどれも無い) ときは
 * エントリを削除して、クリアが確実に既定へ戻るようにする (`writeStoredColumnState` と同じ発想)。
 */
export function writeStoredGridView(key: string | undefined, state: PersistedGridView): void {
  if (!key) return;
  try {
    const hasSorting = !!state.sorting && state.sorting.length > 0;
    const hasFilters = !!state.filters && state.filters.length > 0;
    const hasMasks = !!state.masks && Object.keys(state.masks).length > 0;
    if (!hasSorting && !hasFilters && !hasMasks) {
      localStorage.removeItem(key);
    } else {
      const out: PersistedGridView = {};
      if (hasSorting) out.sorting = state.sorting;
      if (hasFilters) out.filters = state.filters;
      if (hasMasks) out.masks = state.masks;
      touchLayoutLruForKey(key);
      setItemWithEviction(key, JSON.stringify(out));
    }
  } catch {
    // ignore (private mode, quota)
  }
}

/**
 * TanStack の型からストア形へ落とす小さなアダプタ。`SortingState` は同型なので
 * そのまま、`ColumnFiltersState` は不正な値を捨てて `PersistedFilter[]` にする。
 */
export function toPersistedGridView(
  sorting: SortingState,
  columnFilters: ColumnFiltersState,
  masks?: Record<string, boolean>,
): PersistedGridView {
  const state: PersistedGridView = {};
  if (sorting.length > 0) {
    state.sorting = sorting.map((s) => ({ id: s.id, desc: s.desc }));
  }
  const filters: PersistedFilter[] = [];
  for (const f of columnFilters) {
    if (isColumnFilter(f.value)) filters.push({ id: f.id, value: f.value });
  }
  if (filters.length > 0) state.filters = filters;
  if (masks && Object.keys(masks).length > 0) state.masks = masks;
  return state;
}

// ---------------------------------------------------------------------------
// 名前付きビュープリセット (#1942)
// ---------------------------------------------------------------------------
// 自動永続化される「最新 1 状態」(`noobdb.gridview.v1` / `colstate` / `colsizing`) の上に載る
// 任意のレイヤ。ソート・列フィルタ・マスク上書きに加えて列レイアウト (順序/表示/ピン/幅) を
// 名前付きで複数保存し、ワンクリックで丸ごと復元する。保存先は結果シェイプキー体系に
// 相乗りした `noobdb.gridpresets.v1` (LRU の対象。`columnLayoutStorage` の SIBLING_PREFIXES)。

/** 1 結果シェイプあたりのプリセット上限。増え続けて容量を食わないための歯止め。 */
export const GRID_PRESET_MAX = 20;
/** プリセット名の最大文字数。 */
export const GRID_PRESET_NAME_MAX = 40;

/** プリセットに含める列レイアウト。全フィールド任意 (無ければ既定を意味する)。 */
export interface GridPresetLayout {
  /** 表示順 (列 ID = 元の列位置の文字列)。 */
  order?: string[];
  /** 列 ID → 表示フラグ。 */
  visibility?: Record<string, boolean>;
  /** 左右のピン留め列。 */
  pinning?: { left: string[]; right: string[] };
  /** 列 ID → 列幅 (px)。 */
  sizing?: Record<string, number>;
}

/** 名前付きビュー 1 件。 */
export interface GridViewPreset {
  name: string;
  view: PersistedGridView;
  layout?: GridPresetLayout;
}

/** 列サイジングキーからプリセットの保存キーを導出する (プレビューペインでは undefined)。 */
export function gridPresetsKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.gridpresets.v1") : undefined;
}

/** 名前を整える (前後の空白除去・最大長で切り詰め)。空なら空文字。 */
export function normalizePresetName(raw: string): string {
  return raw.trim().slice(0, GRID_PRESET_NAME_MAX).trim();
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function sanitizeLayout(raw: unknown): GridPresetLayout | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: GridPresetLayout = {};
  if (isStringArray(o.order) && o.order.length > 0) out.order = o.order;
  if (o.visibility && typeof o.visibility === "object" && !Array.isArray(o.visibility)) {
    const vis: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(o.visibility as Record<string, unknown>)) {
      if (typeof v === "boolean") vis[k] = v;
    }
    if (Object.keys(vis).length > 0) out.visibility = vis;
  }
  if (o.pinning && typeof o.pinning === "object" && !Array.isArray(o.pinning)) {
    const p = o.pinning as Record<string, unknown>;
    const left = isStringArray(p.left) ? p.left : [];
    const right = isStringArray(p.right) ? p.right : [];
    if (left.length > 0 || right.length > 0) out.pinning = { left, right };
  }
  if (o.sizing && typeof o.sizing === "object" && !Array.isArray(o.sizing)) {
    const sizing: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.sizing as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) sizing[k] = v;
    }
    if (Object.keys(sizing).length > 0) out.sizing = sizing;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * パース済み JSON を妥当なプリセット配列に整える。純粋 (ストレージ非依存)。配列でない・
 * 名前が無い/重複・型不一致のエントリは捨て、上限 (`GRID_PRESET_MAX`) で打ち切る (#566 の作法)。
 */
export function normalizeGridPresets(parsed: unknown): GridViewPreset[] {
  if (!Array.isArray(parsed)) return [];
  const out: GridViewPreset[] = [];
  const seen = new Set<string>();
  for (const p of parsed) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    if (typeof o.name !== "string") continue;
    const name = normalizePresetName(o.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const preset: GridViewPreset = { name, view: normalizeGridView(o.view) };
    const layout = sanitizeLayout(o.layout);
    if (layout) preset.layout = layout;
    out.push(preset);
    if (out.length >= GRID_PRESET_MAX) break;
  }
  return out;
}

/** 保存済みプリセットを読む。壊れた JSON・キー無しは空配列へフォールバックする。 */
export function readStoredGridPresets(key: string | undefined): GridViewPreset[] {
  if (!key) return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    return normalizeGridPresets(JSON.parse(raw));
  } catch {
    // ignore (corrupt entry, private mode, quota)
    return [];
  }
}

/** プリセットを保存する。空配列ならエントリごと削除する。 */
export function writeStoredGridPresets(key: string | undefined, presets: readonly GridViewPreset[]): void {
  if (!key) return;
  try {
    if (presets.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    touchLayoutLruForKey(key);
    setItemWithEviction(key, JSON.stringify(presets));
  } catch {
    // ignore (private mode, quota)
  }
}

/** `upsertGridPreset` の結果。`full` は新規名で上限に達していて追加できなかったとき。 */
export interface UpsertPresetResult {
  presets: GridViewPreset[];
  full: boolean;
}

/**
 * 同名があれば上書き (位置は維持)、無ければ末尾へ追加する。名前は `normalizePresetName` で
 * 整え、空名は何もしない。新規で上限に達しているときは変更せず `full: true`。
 */
export function upsertGridPreset(
  list: readonly GridViewPreset[],
  preset: GridViewPreset,
): UpsertPresetResult {
  const name = normalizePresetName(preset.name);
  if (!name) return { presets: [...list], full: false };
  const next: GridViewPreset = { ...preset, name };
  const idx = list.findIndex((p) => p.name === name);
  if (idx >= 0) {
    const presets = [...list];
    presets[idx] = next;
    return { presets, full: false };
  }
  if (list.length >= GRID_PRESET_MAX) return { presets: [...list], full: true };
  return { presets: [...list, next], full: false };
}

/** 名前でプリセットを取り除く。 */
export function removeGridPreset(list: readonly GridViewPreset[], name: string): GridViewPreset[] {
  return list.filter((p) => p.name !== name);
}

/** `DataGrid` がツールバーのメニューへ公開する操作。現在状態の取得とプリセットの適用。 */
export interface GridViewPresetsHandle {
  /** 現在のソート・フィルタ・マスク・列レイアウトをプリセット本体として切り出す。 */
  capture: () => Pick<GridViewPreset, "view" | "layout">;
  /** プリセットをまとめて適用する (自動永続化の最新 1 状態にも反映される)。 */
  apply: (preset: GridViewPreset) => void;
}

// ---------------------------------------------------------------------------
// 条件付き書式 (データバー/ヒートマップ/閾値ルール) のテーブル単位永続化 (#1958)
// ---------------------------------------------------------------------------
// 列幅・ソート・フッター集計は結果シェイプ単位で永続化済みなのに、条件付き書式 (#1628) だけ
// 揮発性の `useState` で、タブを開き直す/再起動するたびに off へ戻っていた。同じ結果シェイプ
// キー体系へ相乗りした `noobdb.gridcondfmt.v1` に保存する (LRU の対象。`columnLayoutStorage` の
// SIBLING_PREFIXES)。ソート等の `noobdb.gridview.v1` blob と分けるのは、その書き込み経路
// (ソート/フィルタ/マスク/プリセット適用) が書式を巻き込んで消さないため。

/** テーブル単位で保存する条件付き書式。全フィールド任意 (無ければ既定)。 */
export interface PersistedCondFormat {
  /** 列位置 → 適用モード (off は持たない)。 */
  formats?: Record<number, CondFormatMode>;
  /** 列位置 → 閾値ルール。 */
  thresholds?: Record<number, ThresholdRule>;
  /** ヒートマップのパレットキー (既定以外のときだけ持つ)。 */
  palette?: string;
}

/** 列サイジングキーから条件付き書式の保存キーを導出する (プレビューペインでは undefined)。 */
export function condFormatKeyFrom(sizingKey: string | undefined): string | undefined {
  return sizingKey ? sizingKey.replace("noobdb.colsizing.v1", "noobdb.gridcondfmt.v1") : undefined;
}

const COND_MODES: readonly CondFormatMode[] = ["bar", "heat", "threshold"];

function parseColIdx(k: string): number | undefined {
  return /^\d+$/.test(k) ? Number(k) : undefined;
}

function isThresholdRule(v: unknown): v is ThresholdRule {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.op === "string" &&
    (THRESHOLD_OPS as readonly string[]).includes(o.op) &&
    typeof o.value === "number" &&
    Number.isFinite(o.value) &&
    typeof o.tone === "string" &&
    (THRESHOLD_TONES as readonly string[]).includes(o.tone)
  );
}

/**
 * パース済み JSON を妥当な条件付き書式に整える。純粋 (ストレージ非依存)。未知のモード・
 * 不正な列位置・型不一致・未知のパレットは捨てて既定へフォールバックする (#566 の作法)。
 */
export function normalizeCondFormat(parsed: unknown): PersistedCondFormat {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const o = parsed as Record<string, unknown>;
  const out: PersistedCondFormat = {};
  if (o.formats && typeof o.formats === "object" && !Array.isArray(o.formats)) {
    const formats: Record<number, CondFormatMode> = {};
    for (const [k, v] of Object.entries(o.formats as Record<string, unknown>)) {
      const idx = parseColIdx(k);
      if (idx !== undefined && typeof v === "string" && (COND_MODES as readonly string[]).includes(v)) {
        formats[idx] = v as CondFormatMode;
      }
    }
    if (Object.keys(formats).length > 0) out.formats = formats;
  }
  if (o.thresholds && typeof o.thresholds === "object" && !Array.isArray(o.thresholds)) {
    const thresholds: Record<number, ThresholdRule> = {};
    for (const [k, v] of Object.entries(o.thresholds as Record<string, unknown>)) {
      const idx = parseColIdx(k);
      if (idx !== undefined && isThresholdRule(v)) {
        thresholds[idx] = { op: v.op, value: v.value, tone: v.tone };
      }
    }
    if (Object.keys(thresholds).length > 0) out.thresholds = thresholds;
  }
  if (
    typeof o.palette === "string" &&
    o.palette !== DEFAULT_HEAT_PALETTE &&
    Object.prototype.hasOwnProperty.call(HEAT_PALETTES, o.palette)
  ) {
    out.palette = o.palette;
  }
  return out;
}

/** 保存済みの条件付き書式を読む。壊れた JSON・キー無しは空 (= すべて off) へフォールバックする。 */
export function readStoredCondFormat(key: string | undefined): PersistedCondFormat {
  if (!key) return {};
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};
    return normalizeCondFormat(JSON.parse(raw));
  } catch {
    // ignore (corrupt entry, private mode, quota)
    return {};
  }
}

/** 条件付き書式を保存する。実質既定 (書式なし・閾値なし・既定パレット) ならエントリごと削除する。 */
export function writeStoredCondFormat(key: string | undefined, state: PersistedCondFormat): void {
  if (!key) return;
  try {
    const clean = normalizeCondFormat(state);
    // 閾値ルールは閾値モードの列だけが使う。モードを外した列の古い設定は残さない。
    if (clean.thresholds) {
      const used: Record<number, ThresholdRule> = {};
      for (const [k, r] of Object.entries(clean.thresholds)) {
        if (clean.formats?.[Number(k)] === "threshold") used[Number(k)] = r;
      }
      if (Object.keys(used).length > 0) clean.thresholds = used;
      else delete clean.thresholds;
    }
    if (!clean.formats && !clean.thresholds && !clean.palette) {
      localStorage.removeItem(key);
      return;
    }
    touchLayoutLruForKey(key);
    setItemWithEviction(key, JSON.stringify(clean));
  } catch {
    // ignore (private mode, quota)
  }
}
