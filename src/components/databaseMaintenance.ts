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
