import type {
  AlterStatement,
  ExistingColumnBaseline,
  ExistingColumnEdit,
  IndexDef,
  NewColumn,
} from "./alterTable";
import { normalizeType, parseTypeSpec } from "./alterPrecheck";
import { isCompleteCheck, isCompleteForeignKey, type CheckDef, type ForeignKeyDef } from "./tableConstraints";

/**
 * ALTER TABLE の「成功するが本番で重い」操作の分類 (#1771)。型縮小や NOT NULL 付与の事前検査
 * (`alterPrecheck.ts`, #1536 / #1757) は「失敗する」変更を見つけるが、こちらは **成功する代わりに
 * テーブルを書き換え / 全件走査しながら長時間ロックを持つ** 変更を、ドライバ別の表で見つける純ロジック。
 * 概算行数 (`table_statistics`) と掛け合わせて警告するかどうかは `shouldWarnForRows` で決める。
 *
 * 対象は MySQL (8.0 / InnoDB) と PostgreSQL (11+)。SQLite は単一ファイル・単一ライタで ALTER が
 * 軽いので何も返さない。判定は保守的で、「インプレースで済むと確信できる変更」だけを除外する。
 */

/** 警告の重さ。`rewrite` が最も重く、`rebuild` は書き込みと並行して進む再構築。 */
export type AlterCostSeverity = "rewrite" | "scan" | "lock" | "rebuild";

export type AlterCostReason =
  /** MySQL: 型変更は COPY アルゴリズム (全行を新テーブルへコピー、その間書き込み不可)。 */
  | "mysqlCopyType"
  /** MySQL: 外部キーの追加は `foreign_key_checks=1` なら COPY。 */
  | "mysqlCopyForeignKey"
  /** MySQL: CHECK の追加は全行検証を伴い COPY になりうる。 */
  | "mysqlCopyCheck"
  /** MySQL: NULL 可否の変更はインプレースだがテーブルを再構築する (DML は並行可)。 */
  | "mysqlRebuildNullability"
  /** PostgreSQL: 型変更でテーブル全体を書き換える (`ACCESS EXCLUSIVE`)。 */
  | "pgRewriteType"
  /** PostgreSQL: 揮発的な DEFAULT 付き ADD COLUMN は全行を書き換える。 */
  | "pgRewriteVolatileDefault"
  /** PostgreSQL: SET NOT NULL は `ACCESS EXCLUSIVE` のまま全行を検証する。 */
  | "pgScanSetNotNull"
  /** PostgreSQL: 外部キー追加は両テーブルをロックして全行を検証する。 */
  | "pgScanForeignKey"
  /** PostgreSQL: CHECK 追加は `ACCESS EXCLUSIVE` で全行を検証する。 */
  | "pgScanCheck"
  /** PostgreSQL: `CREATE INDEX` (CONCURRENTLY なし) は構築中ずっと書き込みを止める。 */
  | "pgIndexBuildLock";

export interface AlterCostRisk {
  id: string;
  severity: AlterCostSeverity;
  reason: AlterCostReason;
  /** 対象の列名 / 制約名 / インデックス名。 */
  subject: string;
}

/** この行数 (概算) 未満のテーブルは書き換えも一瞬なので警告しない。 */
export const ALTER_COST_ROW_THRESHOLD = 100_000;

/** 概算行数から警告を出すか。不明 (`null` / 未取得) のときは、大きいかもしれないので出す。 */
export function shouldWarnForRows(rowEstimate: number | null | undefined): boolean {
  if (rowEstimate == null || !Number.isFinite(rowEstimate)) return true;
  return rowEstimate >= ALTER_COST_ROW_THRESHOLD;
}

/** MySQL の ALTER に付けると、インプレース + ロックなしで実行できないとき COPY せずに失敗させる句。 */
export const MYSQL_ONLINE_CLAUSE = "ALGORITHM=INPLACE, LOCK=NONE";

/** PostgreSQL で揮発的 (行ごとに評価され、全行の書き換えが要る) として知られる関数。 */
const PG_VOLATILE_FN =
  /\b(random|gen_random_uuid|uuid_generate_v\d\w*|clock_timestamp|timeofday|nextval|setseed|txid_current|pg_current_xact_id)\s*\(/i;

/** MySQL の VARCHAR 長さプレフィックスが 1 バイトで済む上限 (utf8mb4 の 4 バイト/文字で 63 文字)。 */
const MYSQL_VARCHAR_ONE_BYTE_CHARS = 63;

function isVarchar(t: string): boolean {
  return /^(varchar|character varying)\b/.test(normalizeType(t));
}

/** MySQL で型変更がインプレースで済むか。VARCHAR の同一長さクラス内での拡張のみ確実とみなす。 */
function mysqlTypeChangeInPlace(from: string, to: string): boolean {
  if (!isVarchar(from) || !isVarchar(to)) return false;
  const a = parseTypeSpec("mysql", from);
  const b = parseTypeSpec("mysql", to);
  if (a.kind !== "string" || b.kind !== "string" || a.length === null || b.length === null) return false;
  if (b.length < a.length) return false;
  const small = (n: number) => n <= MYSQL_VARCHAR_ONE_BYTE_CHARS;
  return small(a.length) === small(b.length);
}

/** PostgreSQL で型変更がテーブルの書き換えを要さないか (型の別名・VARCHAR 拡張・NUMERIC 精度拡張)。 */
function pgTypeChangeNoRewrite(from: string, to: string): boolean {
  const a = parseTypeSpec("postgres", from);
  const b = parseTypeSpec("postgres", to);
  if (a.kind === "int" && b.kind === "int") {
    return a.range.min === b.range.min && a.range.max === b.range.max;
  }
  if (
    a.kind === "string" &&
    b.kind === "string" &&
    isVarchar(from) &&
    (isVarchar(to) || /^text$/.test(normalizeType(to)))
  ) {
    if (b.length === null) return true;
    return a.length !== null && b.length >= a.length;
  }
  if (a.kind === "decimal" && b.kind === "decimal") {
    // 精度の拡張 (小数桁は同じ) と、精度指定なし NUMERIC への変更は書き換え不要。
    if (b.integerDigits === null) return true;
    return a.integerDigits !== null && a.scale === b.scale && b.integerDigits >= a.integerDigits;
  }
  return false;
}

export interface AlterCostInput {
  baseline: readonly ExistingColumnBaseline[];
  existing: readonly ExistingColumnEdit[];
  added: readonly Pick<NewColumn, "name" | "defaultValue">[];
  /** 作成するインデックス (不備のない行だけ渡す)。 */
  indexes?: readonly IndexDef[];
  addedForeignKeys?: readonly ForeignKeyDef[];
  addedChecks?: readonly CheckDef[];
}

/** 編集内容をドライバ別の表に当てて、書き換え / 全件走査 / 長いロックを伴う操作を列挙する。 */
export function classifyAlterCost(driver: string, input: AlterCostInput): AlterCostRisk[] {
  if (driver !== "mysql" && driver !== "postgres") return [];
  const mysql = driver === "mysql";
  const out: AlterCostRisk[] = [];
  const baseByName = new Map(input.baseline.map((b) => [b.name, b]));

  for (const edit of input.existing) {
    if (edit.drop) continue;
    const base = baseByName.get(edit.original);
    if (!base) continue;
    // `buildAlterPlan` と同じ規則: 型欄が空なら baseline の型のまま。
    const newType = edit.type.trim() || base.type.trim();
    if (newType !== base.type.trim()) {
      const inPlace = mysql
        ? mysqlTypeChangeInPlace(base.type, newType)
        : pgTypeChangeNoRewrite(base.type, newType);
      if (!inPlace) {
        out.push({
          id: `type:${edit.original}`,
          severity: "rewrite",
          reason: mysql ? "mysqlCopyType" : "pgRewriteType",
          subject: edit.original,
        });
      }
    }
    if (edit.notNull !== base.notNull) {
      if (mysql) {
        out.push({
          id: `nullability:${edit.original}`,
          severity: "rebuild",
          reason: "mysqlRebuildNullability",
          subject: edit.original,
        });
      } else if (edit.notNull) {
        out.push({
          id: `setNotNull:${edit.original}`,
          severity: "scan",
          reason: "pgScanSetNotNull",
          subject: edit.original,
        });
      }
    }
  }

  // 列追加は MySQL 8 では INSTANT。PostgreSQL 11+ も定数 DEFAULT なら書き換えないが、揮発的な DEFAULT は全行書き換え。
  if (!mysql) {
    for (const col of input.added) {
      const name = col.name.trim();
      if (name && PG_VOLATILE_FN.test(col.defaultValue)) {
        out.push({
          id: `volatileDefault:${name}`,
          severity: "rewrite",
          reason: "pgRewriteVolatileDefault",
          subject: name,
        });
      }
    }
  }

  (input.addedForeignKeys ?? []).filter(isCompleteForeignKey).forEach((fk, i) => {
    out.push({
      id: `fk:${i}`,
      severity: mysql ? "rewrite" : "scan",
      reason: mysql ? "mysqlCopyForeignKey" : "pgScanForeignKey",
      subject: fk.name.trim() || fk.columns.map((c) => c.trim()).join(", "),
    });
  });
  (input.addedChecks ?? []).filter(isCompleteCheck).forEach((ck, i) => {
    out.push({
      id: `check:${i}`,
      severity: mysql ? "rewrite" : "scan",
      reason: mysql ? "mysqlCopyCheck" : "pgScanCheck",
      subject: ck.name.trim() || ck.expression.trim(),
    });
  });

  // MySQL の CREATE INDEX はインプレースで並行 DML も通る。PostgreSQL は CONCURRENTLY なしだと書き込みを止める。
  if (!mysql) {
    (input.indexes ?? []).forEach((idx, i) => {
      out.push({
        id: `index:${i}`,
        severity: "lock",
        reason: "pgIndexBuildLock",
        subject: idx.name.trim(),
      });
    });
  }
  return out;
}

/** 警告の中に MySQL の COPY (= `ALGORITHM=INPLACE` で止められる) 操作があるか。 */
export function hasMysqlCopyRisk(risks: readonly AlterCostRisk[]): boolean {
  return risks.some((r) => r.reason.startsWith("mysqlCopy") || r.reason === "mysqlRebuildNullability");
}

/**
 * MySQL の文に `ALGORITHM=INPLACE, LOCK=NONE` を付ける。インプレース + ロックなしで実行できない変更は
 * COPY にフォールバックせずエラーで止まるので、「気付かずに本番テーブルを書き換え続ける」事故を防げる。
 * `ALTER TABLE` は末尾の `;` の前に `, 句`、`CREATE INDEX` は空白区切りで付ける。他ドライバ・他の文はそのまま。
 */
export function withMysqlOnlineClause(
  driver: string,
  statements: readonly AlterStatement[],
): AlterStatement[] {
  if (driver !== "mysql") return [...statements];
  return statements.map((s) => {
    const m = /^([\s\S]*?);\s*$/.exec(s.sql);
    if (!m) return s;
    if (/^\s*ALTER TABLE\b/i.test(s.sql)) return { ...s, sql: `${m[1]}, ${MYSQL_ONLINE_CLAUSE};` };
    if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s.sql)) {
      return { ...s, sql: `${m[1]} ${MYSQL_ONLINE_CLAUSE.replace(", ", " ")};` };
    }
    return s;
  });
}
