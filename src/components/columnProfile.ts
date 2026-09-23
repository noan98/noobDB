/**
 * 列データプロファイル (「列を探索」、#974) の純ロジック。副作用なし。
 *
 * 集計そのものはバックエンド (`db/profile.rs`) がサーバ側で全件に対して行う。
 * ここは返ってきた `ColumnProfile` を**表示用に整形する**だけ:
 *
 * - 件数は 2^53 を超えると十進文字列で届く (`Value::from_u64_lossless`)。表示は
 *   文字列のまま桁区切りし、率の計算だけ `Number` に落とす (率は丸めても害がない)。
 * - 描画は既存の `ChartView` の棒グラフ (`CartesianChart`) を再利用する。数値列は
 *   ヒストグラム、非数値列 (または区間が取れない数値列) は上位頻出値を 1 系列の
 *   棒にする。モデルは `chartData.ts::buildChartModel` で組み、チャート側の
 *   ロジックを二重実装しない。
 * - 縮退理由コード (`notes`) を i18n キーへ写す。
 */
import type { CellValue, Column, ColumnProfile, ProfileCount } from "../api/tauri";
import { buildChartModel, type ChartModel } from "./chartData";

/** 件数を数値にする (率・比較用)。解釈できなければ 0。 */
export function profileCountValue(c: ProfileCount | null | undefined): number {
  if (c == null) return 0;
  const n = typeof c === "number" ? c : Number(c);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 件数を桁区切りで表示する。文字列 (2^53 超) は丸めずに区切りだけ入れる —
 * `Number` を経由すると末尾の桁が変わってしまうため。
 */
export function formatProfileCount(c: ProfileCount | null | undefined): string {
  if (c == null) return "—";
  if (typeof c === "number") return c.toLocaleString("en-US");
  const s = c.trim();
  if (!/^-?\d+$/.test(s)) return s;
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

/** 百分率 (0〜100)。分母が 0 のときは null (「0 行中の 0%」を出さない)。 */
export function profilePercent(part: ProfileCount | null | undefined, whole: ProfileCount | null | undefined): number | null {
  const w = profileCountValue(whole);
  if (w <= 0) return null;
  return (profileCountValue(part) / w) * 100;
}

/** 百分率の表示 (小数 1 桁。0 より大きく 0.1 未満は `<0.1%`)。 */
export function formatPercent(p: number | null): string {
  if (p == null) return "—";
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}

/** セル値の表示 (MIN/MAX/上位値)。NULL は null を返し、呼び出し側が NULL 表記にする。 */
export function profileValueLabel(v: CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** ヒストグラムの区間ラベル (`lower – upper`)。整数だけの区間は小数を出さない。 */
export function formatBucketLabel(lower: number, upper: number): string {
  const fmt = (v: number) => {
    if (Number.isInteger(v)) return String(v);
    const abs = Math.abs(v);
    if (abs !== 0 && (abs >= 1e6 || abs < 1e-3)) return v.toExponential(2);
    return String(Number(v.toPrecision(4)));
  };
  return `${fmt(lower)}–${fmt(upper)}`;
}

export type ProfileChartKind = "histogram" | "topValues";

/** どちらのチャートを描くか。描くものが無ければ null。 */
export function profileChartKind(p: ColumnProfile): ProfileChartKind | null {
  if (p.numeric && p.histogram.length > 0) return "histogram";
  if (p.top_values.length > 0) return "topValues";
  return null;
}

/**
 * チャート用の疑似結果セット (ラベル列 + 件数列)。`ChartView` と同じモデル
 * 構築 (`buildChartModel`) を通すため、クエリ結果と同じ形にそろえる。
 */
export function profileChartModel(
  p: ColumnProfile,
  kind: ProfileChartKind,
  labels: { value: string; count: string; nullLabel: string },
): ChartModel {
  const columns: Column[] = [
    { name: labels.value, type_name: "TEXT" },
    { name: labels.count, type_name: "BIGINT" },
  ];
  const rows: CellValue[][] =
    kind === "histogram"
      ? p.histogram.map((b) => [formatBucketLabel(b.lower, b.upper), profileCountValue(b.count)])
      : p.top_values.map((tv) => [
          profileValueLabel(tv.value) ?? labels.nullLabel,
          profileCountValue(tv.count),
        ]);
  return buildChartModel(columns, rows, { type: "bar", xCol: 0, yCols: [1], aggregation: "none" });
}

/** 縮退理由コード → i18n キー。未知のコードは汎用文言へ倒す。 */
const NOTE_KEYS = {
  stats_unavailable: "profileNoteStatsUnavailable",
  top_values_unavailable: "profileNoteTopUnavailable",
  histogram_unavailable: "profileNoteHistogramUnavailable",
  approx_distinct_unsupported: "profileNoteApproxUnsupported",
  approx_distinct_no_stats: "profileNoteApproxNoStats",
} as const;

export type ProfileNoteKey = (typeof NOTE_KEYS)[keyof typeof NOTE_KEYS] | "profileNoteUnknown";

export function profileNoteKey(code: string): ProfileNoteKey {
  return (NOTE_KEYS as Record<string, ProfileNoteKey>)[code] ?? "profileNoteUnknown";
}

/** ボトムパネルの「列を探索」タブの対象。列が未選択なら `column` は null。 */
export interface ProfileTarget {
  database: string;
  table: string;
  column: string | null;
}

/** 対象テーブル/列の表示名 (`db.table.column`。SQLite はデータベースを省く)。 */
export function profileTargetLabel(driver: string, target: ProfileTarget): string {
  const parts = driver === "sqlite" || !target.database ? [target.table] : [target.database, target.table];
  if (target.column) parts.push(target.column);
  return parts.join(".");
}
