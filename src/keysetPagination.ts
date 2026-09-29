// キーセット (シーク) ページネーションの純ロジック (#1150)。
//
// OFFSET ページングは深いページほど線形に遅く、ページ間で行が増減すると重複/欠落する。
// table タブの「次へ/前へ」だけは、現在ページの先頭/末尾行の ORDER BY キーを起点に
// `WHERE (k) > (last_k) ORDER BY k LIMIT n` で取り直す。任意ページへのジャンプ・
// ページサイズ変更・ソート/フィルタ適用は従来どおり `pagination.ts` の OFFSET を使う。
//
// 設計上の決定 (テストで担保):
// - キー = 明示ソート列 (あれば先頭) + 主キー列 (順序を一意にするタイブレーク)。
//   主キーが無いテーブルは keyset を使わず OFFSET にフォールバックする。
// - **NULL 可能なキー列が 1 つでもあれば keyset を無効化して OFFSET にフォールバック**
//   する (行値比較・比較演算子は三値論理で NULL 行を落とし、NULLS FIRST/LAST も
//   方言ごとに既定が違うため)。
// - 主キー列はソート列と同じ方向で並べるので方向は常に一様 (行値比較が使える) だが、
//   方向が混在するキーが渡されたときは OR 展開で正しく生成する。
// - 値は JS number に変換し直さず、バックエンドが返した CellValue をそのままリテラル化する
//   (64bit 整数は文字列で来るので丸められない。数値列なら裸の数値、他は quoteString)。
import type { CellValue, Column, TableColumnInfo } from "./api/tauri";
import { isNumericParam } from "./queryParams";
import { literalFromCellValue } from "./components/cellEdit";
import {
  buildServerFilterClause,
  type ServerFilter,
  type ServerSort,
  type ServerSortDirection,
} from "./components/serverBrowse";
import { quoteIdentFor } from "./components/sqlDialect";

export interface KeysetKey {
  column: string;
  direction: ServerSortDirection;
  /** 数値型の列か。true で値が数値リテラルなら裸で埋め込む (64bit 精度を保つ)。 */
  numeric: boolean;
}

/** keyset に使えるキー列の並び (ORDER BY の順)。 */
export interface KeysetPlan {
  keys: KeysetKey[];
}

/** 比較・並べ替えの正しさをこの層で保証できない型 (バイナリ・JSON・空間型など)。 */
const UNSUPPORTED_KEY_TYPE_RE = /blob|binary|bytea|json|geometry|geography|point|xml|array/i;
const NUMERIC_TYPE_RE = /int|serial|numeric|decimal|float|double|real|number|money/i;

function isOrderableKeyColumn(c: TableColumnInfo): boolean {
  return !c.nullable && !UNSUPPORTED_KEY_TYPE_RE.test(c.data_type);
}

function flip(d: ServerSortDirection): ServerSortDirection {
  return d === "asc" ? "desc" : "asc";
}

/**
 * keyset で走査できるかを判定し、使うキー列を返す。できない場合は null
 * (呼び出し側は OFFSET にフォールバックする)。
 *
 * - `tableColumns` が無い / 主キーが無い → null
 * - ソート列またはいずれかのキー列が NULL 可能・未対応型・結果に含まれない → null
 */
export function resolveKeysetPlan(
  tableColumns: TableColumnInfo[] | null | undefined,
  sort: ServerSort | null | undefined,
  resultColumns: Column[],
): KeysetPlan | null {
  if (!tableColumns) return null;
  const pk = tableColumns.filter((c) => c.key.toUpperCase() === "PRI");
  if (pk.length === 0) return null;
  const direction: ServerSortDirection = sort?.direction ?? "asc";
  const cols: TableColumnInfo[] = [];
  if (sort) {
    const sortCol = tableColumns.find((c) => c.name === sort.column);
    if (!sortCol) return null;
    cols.push(sortCol);
  }
  for (const c of pk) if (!cols.some((x) => x.name === c.name)) cols.push(c);
  for (const c of cols) {
    if (!isOrderableKeyColumn(c)) return null;
    if (!resultColumns.some((rc) => rc.name === c.name)) return null;
  }
  return {
    keys: cols.map((c) => ({
      column: c.name,
      direction,
      numeric: NUMERIC_TYPE_RE.test(c.data_type),
    })),
  };
}

/**
 * 行から plan のキー値を取り出す (ページの先頭/末尾行のアンカー)。列が無い・値が NULL
 * なら null (keyset 不可 → OFFSET にフォールバック)。
 */
export function readKeysetAnchor(
  plan: KeysetPlan,
  resultColumns: Column[],
  row: CellValue[] | undefined,
): CellValue[] | null {
  if (!row) return null;
  const out: CellValue[] = [];
  for (const k of plan.keys) {
    const i = resultColumns.findIndex((c) => c.name === k.column);
    if (i < 0) return null;
    const v = row[i];
    if (v === null || v === undefined) return null;
    out.push(v);
  }
  return out;
}

function keyLiteral(driver: string, key: KeysetKey, v: CellValue): string {
  if (key.numeric && typeof v === "string" && isNumericParam(v)) return v.trim();
  return literalFromCellValue(driver, v);
}

export type KeysetMove = "next" | "prev";

/** 移動方向を加味した各キーの実効 ORDER BY 方向 (prev は反転)。 */
function effectiveKeys(plan: KeysetPlan, move: KeysetMove): KeysetKey[] {
  return move === "prev" ? plan.keys.map((k) => ({ ...k, direction: flip(k.direction) })) : plan.keys;
}

/**
 * アンカーより「移動方向の先」にある行の条件。全キーが同方向なら行値比較
 * `(a, b) > (x, y)`、方向が混在するなら OR 展開 `(a > x) OR (a = x AND b < y)`。
 */
export function buildKeysetCondition(
  driver: string,
  plan: KeysetPlan,
  anchor: CellValue[],
  move: KeysetMove,
): string {
  const keys = effectiveKeys(plan, move);
  const idents = keys.map((k) => quoteIdentFor(driver, k.column));
  const lits = keys.map((k, i) => keyLiteral(driver, k, anchor[i] ?? null));
  const op = (k: KeysetKey) => (k.direction === "asc" ? ">" : "<");
  if (keys.length === 1) return `${idents[0]} ${op(keys[0])} ${lits[0]}`;
  if (keys.every((k) => k.direction === keys[0].direction)) {
    return `(${idents.join(", ")}) ${op(keys[0])} (${lits.join(", ")})`;
  }
  const terms = keys.map((k, i) => {
    const eqs = keys.slice(0, i).map((_, j) => `${idents[j]} = ${lits[j]}`);
    return `(${[...eqs, `${idents[i]} ${op(k)} ${lits[i]}`].join(" AND ")})`;
  });
  return `(${terms.join(" OR ")})`;
}

/**
 * keyset で 1 ページ分を取る SQL。`base` は paginatable な `SELECT * FROM ...`。
 * `prev` は ORDER BY を反転して取るので、返った行は呼び出し側で反転して表示順に戻す
 * (`reverseRowsForPrev`)。
 */
export function buildKeysetPageSql(
  base: string,
  driver: string,
  filter: ServerFilter | null | undefined,
  plan: KeysetPlan,
  anchor: CellValue[],
  move: KeysetMove,
  pageSize: number,
): string {
  const size = Math.max(1, Math.floor(pageSize));
  const conds: string[] = [];
  if (filter) conds.push(`(${buildServerFilterClause(driver, filter)})`);
  conds.push(buildKeysetCondition(driver, plan, anchor, move));
  const order = effectiveKeys(plan, move)
    .map((k) => `${quoteIdentFor(driver, k.column)} ${k.direction === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
  return `${base} WHERE ${conds.join(" AND ")} ORDER BY ${order} LIMIT ${size}`;
}

/** `prev` の結果 (反転 ORDER BY で取得) を表示順に戻す。next は何もしない。 */
export function reverseRowsForPrev<T>(rows: T[], move: KeysetMove): T[] {
  return move === "prev" ? [...rows].reverse() : rows;
}

/**
 * keyset を使ってよい遷移か。隣接ページ (±1) への移動で、強制再取得 (ソート/フィルタ
 * 適用) ではないときだけ方向を返す。それ以外 (ジャンプ・ページサイズ変更) は OFFSET。
 */
export function keysetMoveFor(
  currentPage: number,
  targetPage: number,
  force: boolean,
  sizeChanged: boolean,
): KeysetMove | null {
  if (force || sizeChanged) return null;
  if (targetPage === currentPage + 1) return "next";
  // 1 ページ目への復帰は OFFSET 0 で足りる (安価で、行の増減でズレた先頭も自己修復する)。
  if (targetPage === currentPage - 1 && targetPage >= 2) return "prev";
  return null;
}
