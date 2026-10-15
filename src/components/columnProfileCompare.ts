import type { CellValue, ColumnProfile } from "../api/tauri";
import { formatPercent, formatProfileCount, profilePercent, profileValueLabel } from "./columnProfile";

/**
 * 同じ列の分布を複数接続で並べて比べる (#1539) 純ロジック。移行・同期の検証で
 * 「本番と検証環境で列の分布が一致するか」を確かめるため、各接続の `profile_column` の
 * 結果 (`ColumnProfile`) を指標の表と上位頻出値の表に整形し、基準 (先頭) との差を強調する
 * ための判定を返す。集計そのものは既存の `profile_column` が各接続で行う (新しい SQL は無い)。
 *
 * 環境ごとに行数が違うのは普通なので、**頻出値は件数ではなく構成比 (%) で比べる**。
 * NULL 率も同様に、わずかな差 (`NULL_PCT_TOLERANCE`) は差とみなさない。
 */

/** 1 接続ぶんの結果。`profile` が null ならエラー (または未取得)。 */
export interface CompareEntry {
  id: string;
  label: string;
  profile: ColumnProfile | null;
  error: string | null;
}

/** NULL 率の差をこの値 (百分率ポイント) 未満なら同じとみなす。 */
export const NULL_PCT_TOLERANCE = 0.5;
/** 頻出値の構成比の差をこの値 (百分率ポイント) 未満なら同じとみなす。 */
export const SHARE_TOLERANCE = 1;

export interface CompareCell {
  text: string;
  /** 基準 (先頭の取得済み接続) と違う。基準自身は常に false。 */
  differs: boolean;
}

export type MetricId = "type" | "total" | "nulls" | "nullPct" | "distinct" | "min" | "max";

export interface MetricRow {
  id: MetricId;
  cells: (CompareCell | null)[];
}

/** 基準にする接続の添字 (取得できた最初の接続)。無ければ -1。 */
export function baselineIndex(entries: readonly CompareEntry[]): number {
  return entries.findIndex((e) => e.profile !== null);
}

function valueText(v: CellValue): string {
  return profileValueLabel(v) ?? "NULL";
}

/**
 * 指標の行 (型・件数・NULL 数・NULL 率・DISTINCT・MIN・MAX)。取得できなかった接続の
 * セルは null。基準と異なるセルに `differs` を立てる。
 */
export function buildMetricRows(entries: readonly CompareEntry[]): MetricRow[] {
  const base = baselineIndex(entries);
  const defs: {
    id: MetricId;
    text: (p: ColumnProfile) => string;
    same?: (a: ColumnProfile, b: ColumnProfile) => boolean;
  }[] = [
    { id: "type", text: (p) => p.data_type },
    { id: "total", text: (p) => formatProfileCount(p.total_count) },
    { id: "nulls", text: (p) => formatProfileCount(p.null_count) },
    {
      id: "nullPct",
      text: (p) => formatPercent(profilePercent(p.null_count, p.total_count)),
      same: (a, b) => {
        const x = profilePercent(a.null_count, a.total_count);
        const y = profilePercent(b.null_count, b.total_count);
        if (x === null || y === null) return x === y;
        return Math.abs(x - y) < NULL_PCT_TOLERANCE;
      },
    },
    {
      id: "distinct",
      text: (p) => formatProfileCount(p.distinct_count) + (p.distinct_approximate ? " ~" : ""),
    },
    { id: "min", text: (p) => valueText(p.min_value) },
    { id: "max", text: (p) => valueText(p.max_value) },
  ];
  return defs.map((d) => {
    const baseProfile = base >= 0 ? entries[base].profile : null;
    const cells = entries.map((e, i): CompareCell | null => {
      if (!e.profile) return null;
      const text = d.text(e.profile);
      if (i === base || !baseProfile) return { text, differs: false };
      const same = d.same ? d.same(baseProfile, e.profile) : d.text(baseProfile) === text;
      return { text, differs: !same };
    });
    return { id: d.id, cells };
  });
}

export interface TopValueCell {
  count: string;
  /** 構成比 (0〜100)。総数が 0 のときは null。 */
  share: number | null;
  differs: boolean;
}

export interface TopValueRow {
  /** 比較用キー (NULL と文字列 "NULL" を区別する)。 */
  key: string;
  label: string;
  isNull: boolean;
  /** 接続ごとのセル。その接続の上位値に無ければ null。 */
  cells: (TopValueCell | null)[];
}

/** 頻出値の同一判定キー。NULL を文字列と取り違えない。 */
function valueKey(v: CellValue): string {
  return v === null || v === undefined ? "\u0000null" : `v:${String(v)}`;
}

/**
 * 上位頻出値の比較表。行は全接続の上位値の和集合で、基準の構成比が大きい順 → 他接続での
 * 最大構成比の順に並べ、`limit` 行で打ち切る。基準の上位値が相手に無い (または逆) セルと、
 * 構成比の差が `SHARE_TOLERANCE` 以上のセルを `differs` にする。上位値には件数上限があるため、
 * 「無い」は「その接続の上位値には入っていない」の意味 (画面にも注記する)。
 */
export function buildTopValueRows(entries: readonly CompareEntry[], limit = 20): TopValueRow[] {
  const base = baselineIndex(entries);
  const byKey = new Map<string, TopValueRow>();
  entries.forEach((e, i) => {
    if (!e.profile) return;
    for (const tv of e.profile.top_values) {
      const key = valueKey(tv.value);
      let row = byKey.get(key);
      if (!row) {
        row = {
          key,
          label: valueText(tv.value),
          isNull: tv.value === null,
          cells: entries.map(() => null),
        };
        byKey.set(key, row);
      }
      const share = profilePercent(tv.count, e.profile.total_count);
      row.cells[i] = { count: formatProfileCount(tv.count), share, differs: false };
    }
  });
  const rows = [...byKey.values()];
  const baseProfile = base >= 0 ? entries[base].profile : null;
  if (baseProfile) {
    for (const row of rows) {
      const baseCell = row.cells[base];
      row.cells.forEach((cell, i) => {
        if (i === base) return;
        const e = entries[i];
        if (!e.profile) return;
        if (!baseCell && !cell) return;
        // 片方にしか無い場合は `topValueCellDiffers` が欠けている側も含めて拾う。
        if (!baseCell || !cell) return;
        if (baseCell.share === null || cell.share === null) return;
        cell.differs = Math.abs(baseCell.share - cell.share) >= SHARE_TOLERANCE;
      });
    }
  }
  const sortKey = (row: TopValueRow): [number, number] => {
    const baseShare = base >= 0 ? (row.cells[base]?.share ?? -1) : -1;
    const others = Math.max(-1, ...row.cells.map((c, i) => (i === base ? -1 : (c?.share ?? -1))));
    return [baseShare, others];
  };
  rows.sort((a, b) => {
    const [a1, a2] = sortKey(a);
    const [b1, b2] = sortKey(b);
    return b1 - a1 || b2 - a2 || a.label.localeCompare(b.label);
  });
  return rows.slice(0, Math.max(0, limit));
}

/**
 * 頻出値のセルを「基準と違う」と強調するか。構成比の差に加え、基準にだけ・相手にだけ在る
 * 場合 (欠けている側のセルも) を差に数える。基準自身・取得できなかった接続は false。
 */
export function topValueCellDiffers(
  row: TopValueRow,
  index: number,
  entries: readonly CompareEntry[],
): boolean {
  const base = baselineIndex(entries);
  if (base < 0 || index === base || !entries[index]?.profile) return false;
  const baseCell = row.cells[base];
  const cell = row.cells[index];
  if (!baseCell && !cell) return false;
  if (!baseCell || !cell) return true;
  return cell.differs;
}

/** 行のどこかに差があるか。取得できた接続が 2 つ未満なら false。 */
export function topValueRowDiffers(row: TopValueRow, entries: readonly CompareEntry[]): boolean {
  return row.cells.some((_, i) => topValueCellDiffers(row, i, entries));
}

/** 指標の差を数える (サマリ表示用)。 */
export function countMetricDifferences(rows: readonly MetricRow[]): number {
  return rows.reduce((n, r) => n + r.cells.filter((c) => c?.differs).length, 0);
}

/** 書き出し表の見出し・文言 (i18n は呼び出し側で解決して渡す)。 */
export interface CompareExportLabels {
  section: string;
  item: string;
  /** 基準と差がある接続名の列の見出し。 */
  differs: string;
  sectionMetric: string;
  sectionTop: string;
  /** 指標 ID → 表示名。 */
  metric: Record<MetricId, string>;
  /** 上位値に無いときの文言。 */
  absent: string;
}

/**
 * 列分布の比較結果 (指標の表と上位値の表) を 1 枚の表 (CSV / Markdown 用) に整形する (#1624)。
 * 先頭列 `section` で指標 (metric) と上位値 (top) を分け、接続ごとの列には画面と同じ表記
 * (上位値は `件数 (構成比)`) を入れる。最後の列は基準と差のある接続名 (画面の強調と同じ判定)。
 */
export function compareExportTable(
  entries: readonly CompareEntry[],
  labels: CompareExportLabels,
  topLimit = 20,
): { header: string[]; rows: CellValue[][] } {
  const header = [labels.section, labels.item, ...entries.map((e) => e.label), labels.differs];
  const rows: CellValue[][] = [];
  for (const m of buildMetricRows(entries)) {
    const differing = m.cells.flatMap((c, i) => (c?.differs ? [entries[i]?.label ?? ""] : []));
    rows.push([
      labels.sectionMetric,
      labels.metric[m.id],
      ...m.cells.map((c) => (c ? c.text : null)),
      differing.join(", "),
    ]);
  }
  for (const r of buildTopValueRows(entries, topLimit)) {
    const differing = r.cells.flatMap((_, i) =>
      topValueCellDiffers(r, i, entries) ? [entries[i]?.label ?? ""] : [],
    );
    rows.push([
      labels.sectionTop,
      r.label,
      ...r.cells.map((c, i) =>
        c ? `${c.count} (${formatPercent(c.share)})` : entries[i]?.profile ? labels.absent : null,
      ),
      differing.join(", "),
    ]);
  }
  return { header, rows };
}
