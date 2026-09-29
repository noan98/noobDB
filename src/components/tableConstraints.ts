// 外部キー / CHECK 制約の SQL 断片生成 (純ロジック、#1191)。
//
// `createTable.ts` (CREATE TABLE 内のテーブル制約) と `alterTable.ts`
// (`ALTER TABLE ... ADD CONSTRAINT` / `DROP ...`) が共有する。識別子のクオートは
// `sqlDialect.ts`。CHECK の式は利用者入力の SQL 式なのでそのまま埋め込む
// (呼び出し側 UI がプレビューで見せてから実行する)。

import { quoteIdentFor } from "./sqlDialect";

/** 参照アクション。空文字は「指定なし (DB の既定 = NO ACTION 相当)」。 */
export type ReferentialAction = "" | "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION";

export const REFERENTIAL_ACTIONS: readonly ReferentialAction[] = [
  "",
  "CASCADE",
  "SET NULL",
  "RESTRICT",
  "NO ACTION",
];

export interface ForeignKeyDef {
  /** 制約名。空なら無名 (DB が自動命名)。 */
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onDelete: ReferentialAction;
  onUpdate: ReferentialAction;
}

export interface CheckDef {
  /** 制約名。空なら無名。 */
  name: string;
  /** CHECK の式 (括弧の中身。`price > 0` など)。 */
  expression: string;
}

export function emptyForeignKey(): ForeignKeyDef {
  return { name: "", columns: [], refTable: "", refColumns: [], onDelete: "", onUpdate: "" };
}

export function emptyCheck(): CheckDef {
  return { name: "", expression: "" };
}

/** 生成対象になる FK か (列・参照先・参照列が揃い、列数が一致する)。 */
export function isCompleteForeignKey(fk: ForeignKeyDef): boolean {
  const cols = fk.columns.filter((c) => c.trim());
  const refs = fk.refColumns.filter((c) => c.trim());
  return fk.refTable.trim() !== "" && cols.length > 0 && cols.length === refs.length;
}

/** 生成対象になる CHECK か (式が空でない)。 */
export function isCompleteCheck(ck: CheckDef): boolean {
  return ck.expression.trim() !== "";
}

function identList(driver: string, names: string[]): string {
  return names
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
    .map((n) => quoteIdentFor(driver, n))
    .join(", ");
}

function constraintPrefix(driver: string, name: string): string {
  const n = name.trim();
  return n ? `CONSTRAINT ${quoteIdentFor(driver, n)} ` : "";
}

/**
 * `[CONSTRAINT n] FOREIGN KEY (...) REFERENCES t (...) [ON DELETE x] [ON UPDATE y]`。
 * `database` は参照先の修飾 (MySQL / PostgreSQL のみ。SQLite はスキーマ非対応)。
 */
export function foreignKeyClause(
  driver: string,
  database: string | null | undefined,
  fk: ForeignKeyDef,
): string {
  const ref =
    driver === "sqlite" || !database
      ? quoteIdentFor(driver, fk.refTable.trim())
      : `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, fk.refTable.trim())}`;
  let sql =
    `${constraintPrefix(driver, fk.name)}FOREIGN KEY (${identList(driver, fk.columns)}) ` +
    `REFERENCES ${ref} (${identList(driver, fk.refColumns)})`;
  if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`;
  if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`;
  return sql;
}

/** `[CONSTRAINT n] CHECK (expr)`。 */
export function checkClause(driver: string, ck: CheckDef): string {
  return `${constraintPrefix(driver, ck.name)}CHECK (${ck.expression.trim()})`;
}

/** `DROP` 側の句 (`ALTER TABLE t` の後ろに続く)。 */
export function dropForeignKeyClause(driver: string, name: string): string {
  const ident = quoteIdentFor(driver, name);
  return driver === "mysql" ? `DROP FOREIGN KEY ${ident}` : `DROP CONSTRAINT ${ident}`;
}

export function dropCheckClause(driver: string, name: string): string {
  const ident = quoteIdentFor(driver, name);
  return driver === "mysql" ? `DROP CHECK ${ident}` : `DROP CONSTRAINT ${ident}`;
}
