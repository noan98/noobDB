import type {
  ColumnMapping,
  DriverKind,
  NewColumnType,
  NewTableColumn,
} from "../api/tauri";
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
// 秒は必須 (SQL Server の ISO 8601 形式は秒まで要る)。秒未満は 6 桁まで
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

/**
 * 列の値 (NULL は `null`) から型を推論する。NULL は判定に使わない。すべて NULL
 * (またはデータ行なし) なら何でも入る文字列。MySQL では真偽を文字列へ落とす
 * (`newColumnTypeOptions` の注記を参照)。
 */
export function inferColumnType(
  values: readonly (string | null)[],
  driver: DriverKind,
): NewColumnType {
  let acc: NewColumnType | null = null;
  for (const v of values) {
    if (v === null) continue;
    const ty = inferValueType(v);
    acc = acc === null ? ty : mergeTypes(acc, ty);
    if (acc === "text") break;
  }
  const result = acc ?? "text";
  return newColumnTypeOptions(driver).includes(result) ? result : "text";
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
 * (MySQL / SQL Server / SQLite / DuckDB は列名の大文字小文字を区別しない)。
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
  const cleaned = stem
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
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
): NewColumnDraft[] {
  const width = Math.max(preview.headers.length, ...preview.rows.map((r) => r.length), 0);
  const headers = Array.from({ length: width }, (_, i) => (named ? preview.headers[i] ?? "" : ""));
  const names = proposeColumnNames(headers);
  return names.map((name, i) => {
    // 行が短い (ragged) とき欠けたセルはバックエンドで NULL になる。
    const values = preview.rows.map((r) => (i < r.length ? applyNullToken(r[i], nullToken) : null));
    const ty = inferColumnType(values, driver);
    return { csvIndex: i, name, proposedName: name, type: ty, inferredType: ty, include: true };
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
    case "mssql":
      return { limit: 128, bytes: false };
    case "sqlite":
    case "duckdb":
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
    columns: included.map((d) => ({ name: d.name, type: d.type })),
    mapping: included.map((d) => ({ column: d.name, csvIndex: d.csvIndex })),
  };
}
