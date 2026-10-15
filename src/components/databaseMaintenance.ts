// データベース / スキーマの新規作成・削除の SQL 生成 (純ロジック、#1190)。
//
// ドライバごとに「ツリーの最上位ノード」が指すものが違う点に注意:
//   - MySQL     : ツリーのノード = DATABASE (`CREATE DATABASE` / `DROP DATABASE`)
//   - PostgreSQL: ツリーのノード = SCHEMA (`list_databases` は pg_namespace を返す)。
//                 CREATE DATABASE は接続先クラスタに別 DB を作るだけで、この接続の
//                 ツリーには現れない (別プロファイルで接続する)。
//   - SQLite    : DB はファイル単位。データベース / スキーマの作成・削除は非対応。
//
// 識別子は必ず `quoteIdentFor` でクオートする。PostgreSQL の CREATE DATABASE は
// トランザクション内で実行できないため、呼び出し側は単文の `api.runQuery` を使う
// (`run_query_transaction` を使わない)。

import { isSystemDatabase, quoteIdentFor } from "./sqlDialect";

export type NamespaceKind = "database" | "schema";

/** ドライバが作成できる種別。SQLite は空 (UI を出さない)。 */
export function supportedNamespaceKinds(driver: string): NamespaceKind[] {
  if (driver === "postgres") return ["database", "schema"];
  if (driver === "mysql") return ["database"];
  return [];
}

/** ツリーの最上位ノード (`list_databases` の各要素) が表す種別。SQLite は null。 */
export function treeNamespaceKind(driver: string): NamespaceKind | null {
  if (driver === "postgres") return "schema";
  if (driver === "mysql") return "database";
  return null;
}

/** 名前が空でないこと (前後の空白は無視)。 */
export function isValidNamespaceName(name: string): boolean {
  return name.trim().length > 0 && !name.includes("\0");
}

/** MySQL の CHARACTER SET / COLLATE に渡せるトークン (英数字と `_` のみ)。 */
export function isValidCollationToken(token: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(token);
}

export interface CreateNamespaceOptions {
  /** MySQL の `CHARACTER SET`。空 / 不正なら付けない。 */
  charset?: string;
  /** MySQL の `COLLATE`。空 / 不正なら付けない。 */
  collation?: string;
}

/**
 * `CREATE DATABASE` / `CREATE SCHEMA` 文。ドライバが対応しない種別 (SQLite 全般、
 * MySQL の schema) や空の名前は null を返す。
 */
export function buildCreateNamespaceSql(
  driver: string,
  kind: NamespaceKind,
  name: string,
  opts: CreateNamespaceOptions = {},
): string | null {
  const trimmed = name.trim();
  if (!isValidNamespaceName(trimmed) || !supportedNamespaceKinds(driver).includes(kind)) return null;
  const keyword = kind === "database" ? "DATABASE" : "SCHEMA";
  let sql = `CREATE ${keyword} ${quoteIdentFor(driver, trimmed)}`;
  if (driver === "mysql") {
    const charset = opts.charset?.trim() ?? "";
    const collation = opts.collation?.trim() ?? "";
    if (charset && isValidCollationToken(charset)) sql += ` CHARACTER SET ${charset}`;
    if (collation && isValidCollationToken(collation)) sql += ` COLLATE ${collation}`;
  }
  return `${sql};`;
}

/**
 * `DROP DATABASE` / `DROP SCHEMA` 文。CASCADE は付けない (中身が残っていれば
 * ドライバがエラーにする = 安全側)。非対応なら null。
 */
export function buildDropNamespaceSql(driver: string, kind: NamespaceKind, name: string): string | null {
  const trimmed = name.trim();
  if (!isValidNamespaceName(trimmed) || !supportedNamespaceKinds(driver).includes(kind)) return null;
  const keyword = kind === "database" ? "DATABASE" : "SCHEMA";
  return `DROP ${keyword} ${quoteIdentFor(driver, trimmed)};`;
}

/** 削除させない内部名前空間 (MySQL の information_schema / mysql / sys 等)。 */
export function isProtectedNamespace(driver: string, name: string): boolean {
  return isSystemDatabase(driver, name);
}

/** 名前空間 (DB / スキーマ) の中身の概算 (#1626)。行数は統計値なので「約」で見せる。 */
export interface NamespaceContents {
  tables: number;
  approxRows: number;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * DROP の確認ダイアログに出す「含まれるテーブル数と概算行数」を読む読み取り専用の SELECT (#1626)。
 * MySQL は `information_schema.TABLES` (`TABLE_ROWS` は InnoDB では概算)、PostgreSQL は `pg_class.reltuples`
 * (未集計の -1 は 0 扱い)。結果は 1 行 2 列 (テーブル数, 概算行数)。非対応 (SQLite) や空の名前は null。
 * `CASCADE` を付けない設計はそのままで、中身がある場合に事前に気づけるようにするための情報。
 */
export function namespaceContentsSql(driver: string, kind: NamespaceKind, name: string): string | null {
  const trimmed = name.trim();
  if (!isValidNamespaceName(trimmed) || treeNamespaceKind(driver) !== kind) return null;
  const lit = sqlLiteral(trimmed);
  if (driver === "mysql") {
    return (
      "SELECT COUNT(*), COALESCE(SUM(TABLE_ROWS), 0) FROM information_schema.TABLES " +
      `WHERE TABLE_SCHEMA = ${lit} AND TABLE_TYPE = 'BASE TABLE'`
    );
  }
  if (driver === "postgres") {
    return (
      "SELECT COUNT(*), COALESCE(SUM(GREATEST(c.reltuples, 0))::bigint, 0) FROM pg_class c " +
      `JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ${lit} AND c.relkind IN ('r', 'p')`
    );
  }
  return null;
}

function nonNegativeInt(cell: unknown): number | null {
  const n =
    typeof cell === "number"
      ? cell
      : typeof cell === "string" && /^\d+$/.test(cell.trim())
        ? Number(cell)
        : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** `namespaceContentsSql` の結果の先頭行を読む。形が違えば null。 */
export function parseNamespaceContents(row: readonly unknown[] | undefined): NamespaceContents | null {
  if (!row) return null;
  const tables = nonNegativeInt(row[0]);
  const approxRows = nonNegativeInt(row[1]);
  return tables === null || approxRows === null ? null : { tables, approxRows };
}
