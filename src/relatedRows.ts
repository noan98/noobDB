// 行インスペクタの「関連」タブ (master-detail、#1028) の純ロジック。
//
// FK ジャンプナビ (#621) の逆方向 (`buildReverseRefSql`) は結果グリッドを新しい
// クエリで**置換**する。ここではその SQL をそのまま再利用し、現在の結果を離れずに
// 親行の子行 (1 対多) をインスペクタ内で展開表示するための判定・SQL 生成・整形を
// 持つ。副作用なし (実行は `ResultGrid` → App の `run_query` 経路、内部クエリ扱いで
// クエリ履歴には残らない)。
//
// - 子行取得 SQL は `SELECT *` の読み取り専用で、識別子クォート・値のリテラル化は
//   `fkNavigation.ts` (→ `sqlDialect.ts` / `cellEdit.ts`) に委ねる。件数上限は
//   方言ごとに `LIMIT n` / `TOP (n)` を付け、「さらに読み込む」は上限を増やして
//   取り直す (MSSQL の OFFSET は ORDER BY 必須なので OFFSET ページングにしない)。
// - 上限 + 1 件を取得し、溢れたら「続きあり」とする (`splitRelatedRows`)。
// - 参照されているキー値が NULL の行には子行が存在し得ない (FK の NULL は何も
//   参照しない) ので、`IS NULL` で無関係な行を拾わないよう取得自体をしない。
// - 機微カラムのマスク (#1069) 中のキー値からは辿らない — FK ジャンプの右クリック
//   メニューと同じ方針 (キー値そのものは画面に出ないが、子行の FK 列から実値が
//   読めてしまうため)。

import type { CellValue } from "./api/tauri";
import { buildReverseRefSql, type IncomingFk } from "./fkNavigation";
import type { CellKind } from "./components/cellTypeMeta";

/** 1 回に追加で読み込む子行の件数 (初回の上限も同じ)。 */
export const RELATED_ROWS_PAGE = 50;
/** 子行の上限の最大値。これを超える探索はグリッドで開いてもらう。 */
export const RELATED_ROWS_MAX = 1000;
/** 子行セルの表示を切り詰める文字数 (全文はグリッドで開いて見る)。 */
export const RELATED_CELL_MAX_CHARS = 120;

/** 上限を [1, RELATED_ROWS_MAX] の整数へクランプする。 */
export function clampRelatedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return RELATED_ROWS_PAGE;
  return Math.min(RELATED_ROWS_MAX, Math.max(1, Math.floor(limit)));
}

/** 「さらに読み込む」後の上限。最大値に達していれば null (これ以上増やせない)。 */
export function nextRelatedLimit(limit: number): number | null {
  const cur = clampRelatedLimit(limit);
  if (cur >= RELATED_ROWS_MAX) return null;
  return Math.min(RELATED_ROWS_MAX, cur + RELATED_ROWS_PAGE);
}

/** `SELECT * …` に方言ごとの行数上限を付ける。 */
function withRowLimit(driver: string, selectStar: string, n: number): string {
  if (driver === "mssql") {
    // `buildReverseRefSql` は常に `SELECT * FROM …` で始まる。
    return selectStar.replace(/^SELECT \* /, `SELECT TOP (${n}) * `);
  }
  return `${selectStar} LIMIT ${n}`;
}

export interface RelatedRowsSqlParams {
  driver: string;
  database?: string | null;
  childTable: string;
  childColumn: string;
  /** 親行が持つ、参照されているキー値。 */
  value: CellValue;
  /** 表示する件数の上限 (実際には「続きあり」判定のため +1 件取る)。 */
  limit: number;
}

/**
 * 子行取得 SQL。例: `SELECT * FROM \`shop\`.\`orders\` WHERE \`user_id\` = 42 LIMIT 51`。
 * キー値が NULL (子行が存在し得ない) なら null。
 */
export function buildRelatedRowsSql(p: RelatedRowsSqlParams): string | null {
  if (p.value === null || p.value === undefined) return null;
  const base = buildReverseRefSql({
    driver: p.driver,
    database: p.database,
    childTable: p.childTable,
    childColumn: p.childColumn,
    value: p.value,
  });
  return withRowLimit(p.driver, base, clampRelatedLimit(p.limit) + 1);
}

/**
 * 「グリッドで開く」用の SQL (上限なし。グリッド側の自動 LIMIT / ページングに
 * 任せる)。キー値が NULL なら null。
 */
export function buildRelatedOpenSql(
  p: Omit<RelatedRowsSqlParams, "limit">,
): string | null {
  if (p.value === null || p.value === undefined) return null;
  return buildReverseRefSql(p);
}

/** 上限 + 1 件で取った行を、表示分と「続きあり」に分ける。 */
export function splitRelatedRows<T>(
  rows: readonly T[],
  limit: number,
): { rows: T[]; hasMore: boolean } {
  const n = clampRelatedLimit(limit);
  return { rows: rows.slice(0, n), hasMore: rows.length > n };
}

/** 関連 1 件がたどれない理由。null ならたどれる。 */
export type RelatedBlockReason = "missingKey" | "masked" | "nullKey";

export interface RelatedEntry {
  /** リスト描画・展開状態のキー (`子テーブル.子カラム`)。 */
  key: string;
  fk: IncomingFk;
  /** 親行で参照されているキーカラムの列インデックス (-1 なら結果に無い)。 */
  refColIdx: number;
  /** 参照されているキー値 (たどれないときは null)。 */
  value: CellValue;
  blocked: RelatedBlockReason | null;
}

/**
 * 被参照 FK 一覧を、現在の行でたどれるかどうか付きのエントリへ解決する。
 * 同じ `子テーブル.子カラム` の重複 (複合 FK の分解など) は先勝ちで 1 件にする。
 *
 * @param columnNames 親結果の列名 (元の列順)
 * @param row 親行の値 (元の列順)
 * @param isMasked 親行のその列がマスク中 (#1069) か
 */
export function resolveRelatedEntries(
  incoming: readonly IncomingFk[],
  columnNames: readonly string[],
  row: readonly CellValue[],
  isMasked: (colIdx: number) => boolean,
): RelatedEntry[] {
  const out: RelatedEntry[] = [];
  const seen = new Set<string>();
  for (const fk of incoming) {
    const key = `${fk.table}.${fk.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const refColIdx = columnNames.indexOf(fk.referencedColumn);
    if (refColIdx < 0) {
      out.push({ key, fk, refColIdx, value: null, blocked: "missingKey" });
      continue;
    }
    if (isMasked(refColIdx)) {
      out.push({ key, fk, refColIdx, value: null, blocked: "masked" });
      continue;
    }
    const v = row[refColIdx] ?? null;
    out.push({ key, fk, refColIdx, value: v, blocked: v === null ? "nullKey" : null });
  }
  return out;
}

/** 子行セルの表示。 */
export type RelatedCell =
  | { tone: "null" }
  | { tone: "masked" }
  | { tone: "value"; text: string; truncated: boolean };

/**
 * 子行セルの表示用整形。マスク列は値を一切読まずに伏せ字、NULL は明示、BLOB は
 * `0x` 付き、長い値は切り詰める (表示専用 — 実値は変えない)。
 */
export function formatRelatedCell(
  value: CellValue | undefined,
  kind: CellKind,
  masked: boolean,
): RelatedCell {
  if (masked) return { tone: "masked" };
  if (value === null || value === undefined) return { tone: "null" };
  const s = kind === "binary" ? `0x${String(value)}` : String(value);
  const oneLine = s.replace(/\s+/g, " ");
  if (oneLine.length > RELATED_CELL_MAX_CHARS) {
    return { tone: "value", text: `${oneLine.slice(0, RELATED_CELL_MAX_CHARS)}…`, truncated: true };
  }
  return { tone: "value", text: oneLine, truncated: false };
}
