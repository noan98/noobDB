/**
 * オブジェクト依存検索 (Where-used / 影響分析、#1027) の表示側の純ロジック。
 *
 * 「このテーブル / 列を DROP・RENAME したら何が壊れるか」に答えるため、ビュー・
 * ルーチン・トリガーの定義本文と保存済みスニペットを走査し、指定した識別子への参照を
 * 洗い出す。**走査そのものは Rust (`find_where_used`、#1261) が行う** — 定義本文の
 * 一括取得・コメント/文字列のマスク・識別子トークンの照合・行単位のまとめまでを
 * バックエンドが担い、ここには結果の並べ替えと強調表示の区間分割、ドライバごとの
 * 縮退表示だけが残る。検出規則 (識別子境界・引用・スキーマ修飾・別名解決) は
 * `src-tauri/src/db/where_used.rs` のドキュメントと、共有ゴールデン
 * `fixtures/whereUsedVectors.json` を参照。
 *
 * 動的 SQL (`EXECUTE 'SELECT … FROM orders'`) の中の参照は文字列リテラルなので
 * 検出できない (既知の限界として UI で明示する)。
 */

import type {
  CellValue,
  ReferenceConfidence,
  SchemaObjectKind,
  WhereUsedMatch,
  WhereUsedReport,
} from "../api/tauri";
import { tableToMarkdown } from "./tabularText";

const ALL_KINDS: readonly SchemaObjectKind[] = [
  "view",
  "materialized_view",
  "procedure",
  "function",
  "trigger",
];

/**
 * ドライバごとに定義本文を取得できるオブジェクト種別。Rust 側の
 * `where_used::supports_kind` と対応する。
 *
 * - MySQL: ビュー / プロシージャ / 関数 / トリガー (`SHOW CREATE …`)
 * - PostgreSQL: 上記 + マテリアライズドビュー
 * - SQLite: ビュー / トリガーのみ (ストアドルーチンが存在しない)
 */
const WHERE_USED_KIND_SUPPORT: Readonly<Record<string, readonly SchemaObjectKind[]>> = {
  mysql: ["view", "procedure", "function", "trigger"],
  postgres: ALL_KINDS,
  sqlite: ["view", "trigger"],
};

/**
 * このドライバでは走査できない (存在しない / 取得できない) 種別。UI の縮退表示用。
 * マテリアライズドビューは PostgreSQL 以外に存在しない種別なので、毎回ノイズに
 * ならないよう挙げない。
 */
export function unsupportedWhereUsedKinds(driver: string): SchemaObjectKind[] {
  const supported = WHERE_USED_KIND_SUPPORT[driver] ?? ALL_KINDS;
  return ALL_KINDS.filter((k) => k !== "materialized_view" && !supported.includes(k));
}

/** 行テキストを「強調する / しない」区間に分ける (描画用。範囲の重なり・逆順を吸収する)。 */
export function splitHighlightSegments(
  text: string,
  ranges: readonly [number, number][],
): { text: string; hit: boolean }[] {
  const sorted = [...ranges]
    .map(([s, e]) => [Math.max(0, s), Math.min(text.length, e)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: { text: string; hit: boolean }[] = [];
  let pos = 0;
  for (const [s, e] of sorted) {
    if (e <= pos) continue;
    const from = Math.max(s, pos);
    if (from > pos) out.push({ text: text.slice(pos, from), hit: false });
    out.push({ text: text.slice(from, e), hit: true });
    pos = e;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

const KIND_ORDER: Record<WhereUsedMatch["kind"], number> = {
  view: 0,
  materialized_view: 1,
  procedure: 2,
  function: 3,
  trigger: 4,
  snippet: 5,
};

/** 表示順: 直接参照 → 候補、その中で種別順 → 名前順。 */
export function sortWhereUsedMatches(matches: readonly WhereUsedMatch[]): WhereUsedMatch[] {
  return [...matches].sort(
    (a, b) =>
      (a.confidence === b.confidence ? 0 : a.confidence === "direct" ? -1 : 1) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
}

/** 書き出し表の見出しと、種別・確度・状態の表示名 (i18n は呼び出し側で解決して渡す)。 */
export interface WhereUsedExportLabels {
  kind: string;
  name: string;
  status: string;
  confidence: string;
  hits: string;
  line: string;
  text: string;
  kindName: (kind: WhereUsedMatch["kind"]) => string;
  confidenceName: (c: ReferenceConfidence) => string;
  statusMatch: string;
  statusFailed: string;
  statusEmpty: string;
}

/**
 * 影響分析の結果を書き出し用の表にする (#1624)。参照のあったオブジェクト / スニペットは該当行ごとに
 * 1 行 (行が無いときは 1 行)、定義を取得できなかったもの・本文が空だったものも、レビューで「見て
 * いない範囲」が分かるよう状態つきで末尾に並べる。並びは画面と同じ (呼び出し側で並べ替え済みの
 * `report.matches` をそのまま使う)。
 */
export function whereUsedExportTable(
  report: WhereUsedReport,
  labels: WhereUsedExportLabels,
): { header: string[]; rows: CellValue[][] } {
  const header = [
    labels.kind,
    labels.name,
    labels.status,
    labels.confidence,
    labels.hits,
    labels.line,
    labels.text,
  ];
  const rows: CellValue[][] = [];
  for (const m of report.matches) {
    const head = [labels.kindName(m.kind), m.name, labels.statusMatch, labels.confidenceName(m.confidence)];
    if (m.lines.length === 0) {
      rows.push([...head, m.hitCount, null, null]);
      continue;
    }
    for (const l of m.lines) {
      rows.push([
        ...head,
        m.hitCount,
        l.line,
        `${l.clippedStart ? "…" : ""}${l.text}${l.clippedEnd ? "…" : ""}`,
      ]);
    }
  }
  for (const f of report.failed) {
    rows.push([labels.kindName(f.kind), f.name, labels.statusFailed, null, null, null, f.error]);
  }
  for (const f of report.emptyDefinitions) {
    rows.push([labels.kindName(f.kind), f.name, labels.statusEmpty, null, null, null, null]);
  }
  return { header, rows };
}

/** Markdown 版: 見出し + 要約 (+ 途中終了の注記) + 表。 */
export function whereUsedMarkdown(
  report: WhereUsedReport,
  labels: WhereUsedExportLabels,
  text: { heading: string; summary: string; cancelled: string },
): string {
  const { header, rows } = whereUsedExportTable(report, labels);
  const lines = [`# ${text.heading}`, "", text.summary];
  if (report.cancelled) lines.push("", `> ${text.cancelled}`);
  lines.push("", tableToMarkdown(header, rows));
  return lines.join("\n");
}
