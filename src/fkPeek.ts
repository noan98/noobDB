// 結果グリッドの FK セルから、参照先の 1 行をその場のカードで覗く (#2405) の純ロジック。
//
// 取得 SQL は FK ジャンプ (`buildFkJumpSql`, #621) の SELECT に `LIMIT 1` を付けたもの。
// ここでは (1) その SQL、(2) カードに出す列の選定、(3) 「たどる」操作のパンくず状態遷移 (履歴・戻る /
// 進む)、(4) スライドの向きを決める。DOM・IPC には触れないので Vitest で境界を固定できる。
// 論理リレーション (#2356) は `TableColumnInfo.referenced_table` にマージ済みなので、宣言 FK と同じに扱える。

import type { CellValue, QueryResult, TableColumnInfo } from "./api/tauri";
import { buildFkJumpSql } from "./fkNavigation";
import { classifyTypeName } from "./components/cellTypeMeta";
import { TOOLTIP_OPEN_DELAY_MS } from "./components/Tooltip";

/** ホバーしてからカードを出すまでの待ち (ms)。共有ツールチップ (`TOOLTIP_OPEN_DELAY_MS`) = エディタの識別子ホバーと揃える。 */
export const FK_PEEK_HOVER_DELAY_MS = TOOLTIP_OPEN_DELAY_MS;
/**
 * 取得する行数。複合 FK の 1 列や一意でない論理リレーションでは複数行が一致しうるので、1 行ではなく 2 行取り、
 * 2 行以上なら「複数一致」と注記する (`splitPeekRows`)。
 */
export const FK_PEEK_FETCH_LIMIT = 2;
/** ホバーで開いたカードを、ポインタが離れてから閉じるまでの猶予 (ms)。カードへ移る間に閉じないための余裕。 */
export const FK_PEEK_CLOSE_GRACE_MS = 200;
/** 「主要な列」として出す列数の上限 (PK・NOT NULL の文字列列を優先)。 */
export const FK_PEEK_MAX_COLUMNS = 6;
/** 主要な列とは別に、たどれるように必ず出す FK 列の上限。 */
export const FK_PEEK_MAX_FK_COLUMNS = 4;
/** たどる履歴の上限。超えたら古い方から落とす。 */
export const FK_PEEK_MAX_TRAIL = 12;

/** 参照先の 1 行を指すステップ (たどった 1 段)。 */
export interface PeekStep {
  /** 参照先テーブル。 */
  table: string;
  /** 参照先テーブルのキー列。 */
  column: string;
  /** キー値 (たどる元のセルの値)。 */
  value: CellValue;
  /** キー値の列型 (`Column.type_name`)。型付きリテラル化に使う。 */
  valueType?: string;
}

/** たどった履歴。`index` が現在表示中のステップ。 */
export interface PeekTrail {
  steps: PeekStep[];
  index: number;
}

/** 参照先の行を取る SQL。`SELECT * FROM <table> WHERE <col> = <value> LIMIT 2` (複数一致の検出用、`FK_PEEK_FETCH_LIMIT`)。 */
export function buildFkPeekSql(p: { driver: string; database?: string | null; step: PeekStep }): string {
  return `${buildFkJumpSql({
    driver: p.driver,
    database: p.database,
    refTable: p.step.table,
    refColumn: p.step.column,
    value: p.step.value,
    valueType: p.step.valueType,
  })} LIMIT ${FK_PEEK_FETCH_LIMIT}`;
}

/** 「グリッドで開く」用の SQL (LIMIT なしの既存 FK ジャンプ SQL)。 */
export function buildFkPeekOpenSql(p: { driver: string; database?: string | null; step: PeekStep }): string {
  return buildFkJumpSql({
    driver: p.driver,
    database: p.database,
    refTable: p.step.table,
    refColumn: p.step.column,
    value: p.step.value,
    valueType: p.step.valueType,
  });
}

export function peekStart(step: PeekStep): PeekTrail {
  return { steps: [step], index: 0 };
}

/** 現在位置より先の履歴を捨てて、新しいステップをたどる。 */
export function peekFollow(trail: PeekTrail, step: PeekStep): PeekTrail {
  let steps = [...trail.steps.slice(0, trail.index + 1), step];
  if (steps.length > FK_PEEK_MAX_TRAIL) steps = steps.slice(steps.length - FK_PEEK_MAX_TRAIL);
  return { steps, index: steps.length - 1 };
}

export function peekCanBack(trail: PeekTrail): boolean {
  return trail.index > 0;
}

export function peekCanForward(trail: PeekTrail): boolean {
  return trail.index < trail.steps.length - 1;
}

export function peekBack(trail: PeekTrail): PeekTrail {
  return peekCanBack(trail) ? { ...trail, index: trail.index - 1 } : trail;
}

export function peekForward(trail: PeekTrail): PeekTrail {
  return peekCanForward(trail) ? { ...trail, index: trail.index + 1 } : trail;
}

/** パンくずの項目へ戻る / 進む。範囲外は端へ丸める。 */
export function peekGoTo(trail: PeekTrail, index: number): PeekTrail {
  const clamped = Math.min(Math.max(0, Math.floor(index)), trail.steps.length - 1);
  return clamped === trail.index ? trail : { ...trail, index: clamped };
}

export function peekCurrent(trail: PeekTrail): PeekStep {
  return trail.steps[trail.index] ?? trail.steps[0];
}

/** スライドの向き。`directionalSlide` の `custom` と同じ符号 (正 = 右から入る)。 */
export function peekSlideDirection(prevIndex: number, nextIndex: number): -1 | 0 | 1 {
  if (nextIndex === prevIndex) return 0;
  return nextIndex > prevIndex ? 1 : -1;
}

export interface BreadcrumbItem {
  label: string;
  /** 押したときに移る `PeekTrail.steps` の添字。起点 (グリッドのテーブル) は null (移動先なし)。 */
  stepIndex: number | null;
  current: boolean;
  /** 現在位置より先 (戻った後で進める分)。 */
  ahead: boolean;
}

/** パンくず (`orders → customers → regions`)。先頭は起点のテーブル (空なら省略)。 */
export function breadcrumbItems(origin: string | null, trail: PeekTrail): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [];
  if (origin) items.push({ label: origin, stepIndex: null, current: false, ahead: false });
  trail.steps.forEach((s, i) => {
    items.push({ label: s.table, stepIndex: i, current: i === trail.index, ahead: i > trail.index });
  });
  return items;
}

export interface PeekColumnMeta {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  referenced_table: string | null;
  referenced_column: string | null;
}

export interface PeekColumnPlan {
  /** カードに並べる列の添字 (結果の列順を保つ)。 */
  shown: number[];
  /** そのうち FK で、さらにたどれる列の添字。 */
  followable: number[];
  /** 出さなかった列の数。 */
  hidden: number;
}

/**
 * カードに出す列を選ぶ。主要な列は「PK → NOT NULL の文字列列 → それ以外」の優先順で
 * `FK_PEEK_MAX_COLUMNS` 件まで。メタが無ければ先頭から。さらに、たどれるように参照先が解決できる FK 列は
 * 主要な列に入らなくても `FK_PEEK_MAX_FK_COLUMNS` 件まで加える。表示は結果の列順。
 */
export function planPeekColumns(
  resultColumns: readonly { name: string; type_name: string }[],
  meta: readonly PeekColumnMeta[] | null,
  maxColumns: number = FK_PEEK_MAX_COLUMNS,
): PeekColumnPlan {
  const byName = new Map((meta ?? []).map((m) => [m.name, m]));
  const rank = (i: number): number => {
    const m = byName.get(resultColumns[i]?.name ?? "");
    if (!m) return 3;
    if (m.key.toUpperCase() === "PRI") return 0;
    if (!m.nullable && classifyTypeName(m.data_type || resultColumns[i].type_name) === "string") return 1;
    return 2;
  };
  const isFk = (i: number): boolean => {
    const m = byName.get(resultColumns[i]?.name ?? "");
    return !!m?.referenced_table && !!m.referenced_column;
  };
  const order = resultColumns.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || a - b);
  const chosen = new Set(order.slice(0, Math.max(0, maxColumns)));
  let extra = 0;
  for (let i = 0; i < resultColumns.length && extra < FK_PEEK_MAX_FK_COLUMNS; i++) {
    if (!chosen.has(i) && isFk(i)) {
      chosen.add(i);
      extra++;
    }
  }
  const shown = [...chosen].sort((a, b) => a - b);
  return {
    shown,
    followable: shown.filter(isFk),
    hidden: resultColumns.length - shown.length,
  };
}

/** メタ (`TableColumnInfo`) から、列名で FK 参照先を引く。たどれなければ null。 */
export function peekFollowTarget(
  meta: readonly Pick<TableColumnInfo, "name" | "referenced_table" | "referenced_column">[] | null,
  columnName: string,
): { table: string; column: string } | null {
  const m = meta?.find((c) => c.name === columnName);
  if (!m?.referenced_table || !m.referenced_column) return null;
  return { table: m.referenced_table, column: m.referenced_column };
}

/** 取得した行から、表示する先頭行と「複数の行が一致した」かを返す。0 行なら row は null。 */
export function splitPeekRows<T>(rows: readonly T[]): { row: T | null; multiple: boolean } {
  return { row: rows[0] ?? null, multiple: rows.length > 1 };
}

/** カードの取得結果のキャッシュ。グリッドが結果 (rows) の世代ごとに作り直し、ホバーし直しの再取得を避ける。 */
export interface FkPeekCache {
  /** SQL → 取得結果。 */
  results: Map<string, QueryResult>;
  /** `データベース\0テーブル` → 列メタ (取得失敗は null)。 */
  meta: Map<string, TableColumnInfo[] | null>;
}

export function newFkPeekCache(): FkPeekCache {
  return { results: new Map(), meta: new Map() };
}

export function peekMetaKey(database: string | null, table: string): string {
  return `${database ?? ""}\0${table}`;
}
