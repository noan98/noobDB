import type { ColumnMapping, DriverKind, NewColumnType, NewTableColumn } from "../api/tauri";
import type { CellKind } from "./cellTypeMeta";

/**
 * ファイルから新規テーブルを作成してインポートする (#985) ための純ロジック。
 *
 * - プレビュー行から列ごとの型 (整数 / 64bit 整数 / 固定小数 / 浮動小数 / 真偽 /
 *   日付 / 日時 / 文字列) を推論する。
 * - ヘッダから列名を提案する (空名・重複の解消)。
 * - バックエンド (`db/create_table.rs::validate_new_table`) と同じ規則で
 *   テーブル名・列名を検証し、実行前に理由を表示できるようにする。
 *
 * DDL の生成そのものはバックエンドだけが持つ (プレビューも
 * `preview_create_table_ddl` 経由で同じ関数を通す)。フロントは方言を再実装しない。
 */

/** UI に並べる型の順序 (上書き用のセレクトもこの順)。 */
const ALL_TYPES: readonly NewColumnType[] = [
  "integer",
  "bigint",
  "decimal",
  "double",
  "boolean",
  "date",
  "datetime",
  "text",
];

/**
 * 方言ごとに選べる型。MySQL の BOOLEAN は TINYINT(1) の別名で、インポートは
 * 値を文字列リテラルで流すため `'true'` が変換エラーになる。推論でも選択肢でも
 * 出さない (0/1 の列は整数として推論される)。
 */
export function newColumnTypeOptions(driver: DriverKind): NewColumnType[] {
  return ALL_TYPES.filter((ty) => !(driver === "mysql" && ty === "boolean"));
}

/** 型 → 結果グリッドと同じ型アイコンの分類 (`cellTypeMeta.ts`)。 */
export function newColumnTypeCellKind(ty: NewColumnType): CellKind {
  switch (ty) {
    case "integer":
    case "bigint":
      return "number";
    case "decimal":
    case "double":
      return "decimal";
    case "boolean":
      return "bool";
    case "date":
    case "datetime":
      return "date";
    case "text":
      return "string";
  }
}

const I32_MIN = -(2n ** 31n);
const I32_MAX = 2n ** 31n - 1n;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
/** DECIMAL(38, 10) に収まる桁数 (整数部 28 桁 + 小数部 10 桁)。 */
const DECIMAL_INT_DIGITS = 28;
const DECIMAL_FRAC_DIGITS = 10;

// 先頭ゼロ ("007") は郵便番号やコードの可能性が高いので数値扱いしない (文字列の
// まま残す)。符号は "-" のみ ("+1" は DB によって解釈が揺れるため文字列)。
const INTEGER_RE = /^-?(0|[1-9]\d*)$/;
const DECIMAL_RE = /^-?(0|[1-9]\d*)\.(\d+)$/;
const EXPONENT_RE = /^-?(0|[1-9]\d*)(\.\d+)?[eE][+-]?\d+$/;
const BOOLEAN_RE = /^(true|false)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// 秒は必須 (時刻部分を曖昧にしないため)。秒未満は 6 桁まで
// (MySQL DATETIME(6) / PostgreSQL TIMESTAMP の精度)。タイムゾーン付きは方言間で
// 扱いが揺れる (PostgreSQL の TIMESTAMP は黙って捨てる) ので文字列のまま。
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?$/;

function isValidDate(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[m - 1];
}

/**
 * 1 つの非 NULL 値の型を判定する。64bit 整数の境界は `BigInt` で比較する
 * (`Number` だと 2^53 を超えた時点で丸められ、BIGINT と DECIMAL の判定を誤る)。
 */
export function inferValueType(raw: string): NewColumnType {
  if (INTEGER_RE.test(raw)) {
    const n = BigInt(raw);
    if (n >= I32_MIN && n <= I32_MAX) return "integer";
    if (n >= I64_MIN && n <= I64_MAX) return "bigint";
    const digits = raw.replace("-", "").length;
    return digits <= DECIMAL_INT_DIGITS ? "decimal" : "text";
  }
  const dec = DECIMAL_RE.exec(raw);
  if (dec) {
    const intDigits = dec[1].length;
    const fracDigits = dec[2].length;
    if (intDigits <= DECIMAL_INT_DIGITS && fracDigits <= DECIMAL_FRAC_DIGITS) return "decimal";
    return Number.isFinite(Number(raw)) ? "double" : "text";
  }
  if (EXPONENT_RE.test(raw)) {
    return Number.isFinite(Number(raw)) ? "double" : "text";
  }
  if (BOOLEAN_RE.test(raw)) return "boolean";
  const date = DATE_RE.exec(raw);
  if (date) {
    return isValidDate(Number(date[1]), Number(date[2]), Number(date[3])) ? "date" : "text";
  }
  const dt = DATETIME_RE.exec(raw);
  if (dt) {
    const ok =
      isValidDate(Number(dt[1]), Number(dt[2]), Number(dt[3])) &&
      Number(dt[4]) <= 23 &&
      Number(dt[5]) <= 59 &&
      Number(dt[6]) <= 59;
    return ok ? "datetime" : "text";
  }
  return "text";
}

const NUMERIC_RANK: Partial<Record<NewColumnType, number>> = {
  integer: 0,
  bigint: 1,
  decimal: 2,
  double: 3,
};

/** 2 つの型を両方の値を表せる最小の型へまとめる (合わなければ文字列)。 */
function mergeTypes(a: NewColumnType, b: NewColumnType): NewColumnType {
  if (a === b) return a;
  const ra = NUMERIC_RANK[a];
  const rb = NUMERIC_RANK[b];
  if (ra !== undefined && rb !== undefined) return ra >= rb ? a : b;
  if ((a === "date" && b === "datetime") || (a === "datetime" && b === "date")) {
    return "datetime";
  }
  return "text";
}

/** 推論を文字列へ落とした最初の値と、その理由 (#1623)。 */
export interface InferenceFallback {
  /** 落とした値そのもの。 */
  value: string;
  /** プレビュー内の行位置 (0 始まり)。 */
  row: number;
  /**
   * - `value`: その値単体が文字列 (数値・日付として読めない)。
   * - `conflict`: 値単体は `valueType` だが、それまでの `previousType` とまとめられない。
   * - `driver`: 値は真偽値だが、この方言 (MySQL) では真偽型を選べない。
   */
  reason: "value" | "conflict" | "driver";
  valueType: NewColumnType;
  /** `conflict` のとき、その値の直前までの推論型。 */
  previousType: NewColumnType | null;
}

/** 推論の根拠 (取り込みモーダルが列ごとに「なぜこの型か」を示すのに使う)。 */
export interface ColumnInferenceDetail {
  type: NewColumnType;
  /** 値単体で判定した型ごとの非 NULL 値の件数 (値を最後まで数える)。 */
  counts: Partial<Record<NewColumnType, number>>;
  nullCount: number;
  /** 推論を文字列へ落とした最初の値。文字列に落ちていなければ `null`。 */
  firstText: InferenceFallback | null;
}

/**
 * 列の値 (NULL は `null`) から型を推論し、その根拠も返す (#1623)。型の決定規則は
 * {@link inferColumnType} と同じで、件数は最後の値まで数える (文字列に落ちた後も
 * 「他の値はどの型だったか」を示すため)。
 */
export function inferColumnTypeDetail(
  values: readonly (string | null)[],
  driver: DriverKind,
): ColumnInferenceDetail {
  const counts: Partial<Record<NewColumnType, number>> = {};
  let nullCount = 0;
  let acc: NewColumnType | null = null;
  let firstText: InferenceFallback | null = null;
  let firstBoolean: { value: string; row: number } | null = null;
  for (let row = 0; row < values.length; row += 1) {
    const v = values[row];
    if (v === null) {
      nullCount += 1;
      continue;
    }
    const ty = inferValueType(v);
    counts[ty] = (counts[ty] ?? 0) + 1;
    if (ty === "boolean" && firstBoolean === null) firstBoolean = { value: v, row };
    if (acc === "text") continue;
    const merged: NewColumnType = acc === null ? ty : mergeTypes(acc, ty);
    if (merged === "text" && firstText === null) {
      firstText =
        ty === "text"
          ? { value: v, row, reason: "value", valueType: ty, previousType: acc }
          : { value: v, row, reason: "conflict", valueType: ty, previousType: acc };
    }
    acc = merged;
  }
  let type: NewColumnType = acc ?? "text";
  if (!newColumnTypeOptions(driver).includes(type)) {
    // MySQL は真偽型を選べないので文字列へ戻す。落とした値は最初の真偽値。
    type = "text";
    if (firstBoolean) {
      const { value, row } = firstBoolean;
      firstText = { value, row, reason: "driver", valueType: "boolean", previousType: null };
    }
  }
  return { type, counts, nullCount, firstText: type === "text" ? firstText : null };
}

/**
 * 列の値 (NULL は `null`) から型を推論する。NULL は判定に使わない。すべて NULL
 * (またはデータ行なし) なら何でも入る文字列。MySQL では真偽を文字列へ落とす
 * (`newColumnTypeOptions` の注記を参照)。根拠が要るときは {@link inferColumnTypeDetail}。
 */
export function inferColumnType(values: readonly (string | null)[], driver: DriverKind): NewColumnType {
  return inferColumnTypeDetail(values, driver).type;
}

/**
 * バックエンドの `apply_null` と同じ規則でセルを NULL 化する。プレビューは
 * NULL 化前の生テキストなので、推論前にここで揃える。
 */
export function applyNullToken(raw: string, nullToken: string | null): string | null {
  return nullToken !== null && raw === nullToken ? null : raw;
}

/**
 * ヘッダから列名を提案する。前後空白を落とし、空なら `column_N` (N は 1 始まりの
 * 列位置)、大文字小文字を無視して重複したら `_2`, `_3`, ... を付ける
 * (MySQL / SQLite は列名の大文字小文字を区別しない)。
 */
export function proposeColumnNames(headers: readonly string[]): string[] {
  const seen = new Set<string>();
  return headers.map((h, i) => {
    const base = h.trim() || `column_${i + 1}`;
    let name = base;
    let n = 2;
    while (seen.has(name.toLowerCase())) {
      name = `${base}_${n}`;
      n += 1;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/**
 * ファイルパスからテーブル名を提案する。拡張子を落とし、英数字・アンダースコア
 * 以外 (空白・記号) を `_` にまとめる (文字は Unicode の文字も許す)。
 */
export function suggestTableName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const stem = base.replace(/\.[^.]*$/, "");
  const cleaned = stem.replace(/[^\p{L}\p{N}_]+/gu, "_").replace(/^_+|_+$/g, "");
  return cleaned || "imported_table";
}

/** 新規テーブルの 1 列の下書き (UI の編集対象)。 */
export interface NewColumnDraft {
  /** 元ファイルの列位置 (`ColumnMapping.csvIndex`)。 */
  csvIndex: number;
  name: string;
  /** ヘッダから提案した列名 (ユーザが名前を変えたかの判定に使う)。 */
  proposedName: string;
  type: NewColumnType;
  /** プレビューから推論した型 (ユーザが上書きしたかの表示に使う)。 */
  inferredType: NewColumnType;
  /** false なら作成も取り込みもしない列。 */
  include: boolean;
  /** 主キーに含める列 (#1623)。省略は false。 */
  primaryKey?: boolean;
  /** 推論の根拠 (型ごとの件数・文字列に落ちた最初の値。#1623)。 */
  detail?: ColumnInferenceDetail;
}

/**
 * Excel のエラー値トークン。xlsx のプレビューはエラーセルを文字列のまま見せるが
 * (どのセルが NULL になるか分かるように)、取り込みでは NULL になる (#1532)。
 * 型推論・列名提案では NULL 相当として扱う。
 */
const EXCEL_ERROR_TOKENS: ReadonlySet<string> = new Set([
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
  "#SPILL!",
  "#CALC!",
  "#GETTING_DATA",
]);

export function isExcelErrorToken(value: string): boolean {
  return EXCEL_ERROR_TOKENS.has(value.trim().toUpperCase());
}

/** プレビュー行にある Excel エラー値のセル数 (取り込み時に NULL になる件数)。 */
export function countExcelErrors(rows: readonly (readonly string[])[]): number {
  let n = 0;
  for (const r of rows) for (const c of r) if (isExcelErrorToken(c)) n += 1;
  return n;
}

/**
 * プレビューから列の下書きを作る。`named` が false (ヘッダ行なしの CSV) なら
 * ヘッダ名を使わず `column_N` を提案する。
 */
export function buildColumnDrafts(
  preview: { headers: readonly string[]; rows: readonly (readonly string[])[] },
  nullToken: string | null,
  driver: DriverKind,
  named: boolean,
  excelErrors = false,
): NewColumnDraft[] {
  const width = Math.max(preview.headers.length, ...preview.rows.map((r) => r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => {
    const h = named ? (preview.headers[i] ?? "") : "";
    // xlsx のヘッダ行にあるエラーセルは列名にせず column_N にする。
    return excelErrors && isExcelErrorToken(h) ? "" : h;
  });
  const names = proposeColumnNames(headers);
  return names.map((name, i) => {
    // 行が短い (ragged) とき欠けたセルはバックエンドで NULL になる。
    const values = preview.rows.map((r) => {
      if (i >= r.length) return null;
      // xlsx のエラー値は取り込みで NULL になるので、推論でも NULL として扱う。
      if (excelErrors && isExcelErrorToken(r[i])) return null;
      return applyNullToken(r[i], nullToken);
    });
    const detail = inferColumnTypeDetail(values, driver);
    const ty = detail.type;
    return { csvIndex: i, name, proposedName: name, type: ty, inferredType: ty, include: true, detail };
  });
}

/**
 * プレビューを取り直したとき (NULL トークンやエラーモードの変更など) に、
 * ユーザが手で変えた列名・型・取り込み対象の選択を新しい下書きへ引き継ぐ。
 * 同じ列位置 (`csvIndex`) の下書き同士で、提案 / 推論から変わっている項目だけを
 * 残す (変えていない項目は新しい提案 / 推論に追従する)。
 */
export function mergeColumnDrafts(
  prev: readonly NewColumnDraft[] | null,
  next: readonly NewColumnDraft[],
): NewColumnDraft[] {
  if (!prev) return [...next];
  return next.map((n) => {
    const p = prev.find((d) => d.csvIndex === n.csvIndex);
    if (!p) return n;
    return {
      ...n,
      name: p.name !== p.proposedName ? p.name : n.name,
      type: p.type !== p.inferredType ? p.type : n.type,
      include: p.include ? n.include : false,
      primaryKey: p.primaryKey,
    };
  });
}

/** 新規テーブル定義の検証結果。`null` なら実行可能。 */
export type NewTableError =
  | { kind: "tableNameRequired" }
  | { kind: "nameWhitespace"; name: string }
  | { kind: "nameTooLong"; name: string; limit: number }
  | { kind: "noColumns" }
  | { kind: "columnNameRequired" }
  | { kind: "duplicateColumn"; name: string }
  | null;

/** バックエンドの `max_ident_len` と同じ上限。`bytes` は UTF-8 バイト数で数える。 */
function identLimit(driver: DriverKind): { limit: number; bytes: boolean } | null {
  switch (driver) {
    case "mysql":
      return { limit: 64, bytes: false };
    case "postgres":
      return { limit: 63, bytes: true };
    case "sqlite":
      return null;
  }
}

function identError(driver: DriverKind, name: string): NewTableError {
  if (name !== name.trim()) return { kind: "nameWhitespace", name };
  const lim = identLimit(driver);
  if (lim) {
    const len = lim.bytes ? new TextEncoder().encode(name).length : [...name].length;
    if (len > lim.limit) return { kind: "nameTooLong", name, limit: lim.limit };
  }
  return null;
}

/**
 * バックエンドの `validate_new_table` と同じ規則で検証する (取り込み対象の列
 * だけを見る)。
 */
export function validateNewTable(
  driver: DriverKind,
  tableName: string,
  drafts: readonly NewColumnDraft[],
): NewTableError {
  if (tableName.trim() === "") return { kind: "tableNameRequired" };
  const tableErr = identError(driver, tableName);
  if (tableErr) return tableErr;
  const included = drafts.filter((d) => d.include);
  if (included.length === 0) return { kind: "noColumns" };
  const seen = new Set<string>();
  for (const d of included) {
    if (d.name.trim() === "") return { kind: "columnNameRequired" };
    const err = identError(driver, d.name);
    if (err) return err;
    const key = d.name.toLowerCase();
    if (seen.has(key)) return { kind: "duplicateColumn", name: d.name };
    seen.add(key);
  }
  return null;
}

/** 取り込み対象の下書きから、IPC へ渡す列定義とマッピングを作る。 */
export function newTableRequest(drafts: readonly NewColumnDraft[]): {
  columns: NewTableColumn[];
  mapping: ColumnMapping[];
} {
  const included = drafts.filter((d) => d.include);
  return {
    columns: included.map((d) => (d.primaryKey ? { name: d.name, type: d.type, primaryKey: true } : { name: d.name, type: d.type })),
    mapping: included.map((d) => ({ column: d.name, csvIndex: d.csvIndex })),
  };
}

/** 主キーの事前検証 (プレビュー行の範囲) で見つかった問題 (#1623)。 */
export type PrimaryKeyIssue =
  | { kind: "null"; column: string; row: number }
  | { kind: "duplicate"; row: number; firstRow: number };

/**
 * 主キーに選んだ列について、プレビュー行の NULL と重複を調べる。`row` は 1 始まりの
 * データ行番号。プレビューは先頭の一部 (最大 50 行) だけなので「無問題」はファイル全体の
 * 保証ではない — 全行の検証は取り込み時にバックエンド (テーブルを作る前) が行う。
 * 値は文字列として比べる (バックエンドと同じ)。
 */
export function findPrimaryKeyIssue(
  drafts: readonly NewColumnDraft[],
  rows: readonly (readonly string[])[],
  nullToken: string | null,
): PrimaryKeyIssue | null {
  const keys = drafts.filter((d) => d.include && d.primaryKey);
  if (keys.length === 0) return null;
  const seen = new Map<string, number>();
  for (let n = 0; n < rows.length; n += 1) {
    const cells: string[] = [];
    for (const k of keys) {
      const raw = rows[n][k.csvIndex];
      const v = raw === undefined ? null : applyNullToken(raw, nullToken);
      if (v === null) return { kind: "null", column: k.name, row: n + 1 };
      cells.push(v);
    }
    // 区切りの曖昧さ (("ab","c") と ("a","bc")) を避けるため JSON 配列でキー化する。
    const key = JSON.stringify(cells);
    const first = seen.get(key);
    if (first !== undefined) return { kind: "duplicate", row: n + 1, firstRow: first };
    seen.set(key, n + 1);
  }
  return null;
}
