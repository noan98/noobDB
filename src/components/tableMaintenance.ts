// スキーマツリーからのテーブル保守操作の SQL 生成 (純ロジック)。
//
// TRUNCATE / DROP / RENAME のドライバ別 DDL を組み立てる。識別子クオートは
// sqlDialect.ts を流用。副作用が無いので Vitest でユニットテストする。

import { quoteIdentFor } from "./sqlDialect";

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。 */
function qualified(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/**
 * TRUNCATE 文。SQLite には TRUNCATE が無いので、等価な `DELETE FROM`
 * (WHERE なし全削除) を生成する。
 */
export function buildTruncateSql(driver: string, database: string | null, table: string): string {
  const name = qualified(driver, database, table);
  if (driver === "sqlite") return `DELETE FROM ${name};`;
  return `TRUNCATE TABLE ${name};`;
}

/** DROP TABLE 文。 */
export function buildDropTableSql(driver: string, database: string | null, table: string): string {
  return `DROP TABLE ${qualified(driver, database, table)};`;
}

/**
 * 複数テーブルの DROP (#1399)。MySQL / PostgreSQL は 1 文 (`DROP TABLE a, b`) にまとめる —
 * 選んだテーブル同士が外部キーで参照し合っていても順序を気にせず落とせ、PostgreSQL では
 * 1 文なので全件成功か全件失敗になる。SQLite には複数形が無いのでテーブルごとの文を返す。
 */
export function buildDropTablesSql(driver: string, database: string | null, tables: readonly string[]): string[] {
  if (tables.length === 0) return [];
  if (driver === "sqlite") return tables.map((t) => buildDropTableSql(driver, database, t));
  return [`DROP TABLE ${tables.map((t) => qualified(driver, database, t)).join(", ")};`];
}

/**
 * RENAME 文。`ALTER TABLE ... RENAME TO ...` は MySQL 8 / PostgreSQL / SQLite の
 * すべてで使える。新しい名前はスキーマ非修飾 (同じスキーマ内での改名)。
 */
export function buildRenameTableSql(
  driver: string,
  database: string | null,
  table: string,
  newName: string,
): string {
  const from = qualified(driver, database, table);
  const to = quoteIdentFor(driver, newName);
  return `ALTER TABLE ${from} RENAME TO ${to};`;
}

/**
 * インデックス名候補から、識別子として扱いづらい文字を `_` に畳む。クオートは
 * 呼び出し側が行うので、ここでは可読性のための正規化のみ。バックエンドの
 * `db/advisor.rs::sanitize_index_name` (アドバイザの自動修正 DDL が使う) と同じ規則。
 */
function sanitizeIndexName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * `CREATE [UNIQUE] INDEX` 文を生成する (#850)。方言差は `db/advisor.rs::create_index_ddl`
 * の移植。インデックス名を指定しなければ `idx_<table>_<col1>_<col2>...` を自動生成する。
 * 空の列名は無視する。
 */
export function buildCreateIndexSql(
  driver: string,
  database: string | null,
  table: string,
  columns: string[],
  opts: { name?: string; unique?: boolean } = {},
): string {
  const cols = columns.map((c) => c.trim()).filter((c) => c.length > 0);
  const rawName = opts.name?.trim() || `idx_${table}_${cols.join("_")}`;
  const idxName = sanitizeIndexName(rawName);
  const colList = cols.map((c) => quoteIdentFor(driver, c)).join(", ");
  const keyword = opts.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  return `${keyword} ${quoteIdentFor(driver, idxName)} ON ${qualified(driver, database, table)} (${colList});`;
}

/**
 * 方言別の `DROP INDEX` (#850)。MySQL は `DROP INDEX <name> ON <table>`
 * (テーブル修飾が必須)、PostgreSQL / SQLite は `DROP INDEX <name>`
 * (テーブル指定不可)。`db/advisor.rs::drop_index_ddl` と同じ方言分岐の移植。
 */
export function buildDropIndexSql(
  driver: string,
  database: string | null,
  table: string,
  indexName: string,
): string {
  if (driver === "mysql") {
    return `DROP INDEX ${quoteIdentFor(driver, indexName)} ON ${qualified(driver, database, table)};`;
  }
  return `DROP INDEX ${quoteIdentFor(driver, indexName)};`;
}

/**
 * SQLite の一括 DROP 用に、選択内の外部キーで「参照する側 (子) → 参照される側 (親)」の順へ並べる (#1399)。
 * SQLite は複数形の DROP が無く、明示トランザクションも使えないため、親を先に落とすと子の行が
 * 残っていて失敗する。選択外のテーブルへの参照と自己参照は無視し、循環は元の順序で末尾に回す。
 */
export function orderTablesChildrenFirst(
  tables: readonly string[],
  fks: readonly { table: string; referenced_table: string }[],
): string[] {
  const inSel = new Set(tables);
  // parents[t] = t が参照している (選択内の) 親テーブル
  const referencedBy = new Map<string, Set<string>>(); // 親 -> それを参照する子
  const pending = new Map<string, number>(); // 子 -> 未処理の「自分を参照する子」の数
  for (const t of tables) {
    referencedBy.set(t, new Set());
    pending.set(t, 0);
  }
  for (const fk of fks) {
    if (fk.table === fk.referenced_table || !inSel.has(fk.table) || !inSel.has(fk.referenced_table)) continue;
    const children = referencedBy.get(fk.referenced_table);
    if (!children || children.has(fk.table)) continue;
    children.add(fk.table);
    pending.set(fk.referenced_table, (pending.get(fk.referenced_table) ?? 0) + 1);
  }
  // 「自分を参照する子がもう残っていない」テーブルから落としていく。
  const out: string[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (out.length < tables.length && progressed) {
    progressed = false;
    for (const t of tables) {
      if (done.has(t) || (pending.get(t) ?? 0) > 0) continue;
      done.add(t);
      out.push(t);
      progressed = true;
      // t が消えたので、t が参照していた親の待ち数を減らす。
      for (const [parent, children] of referencedBy) {
        if (children.has(t)) pending.set(parent, (pending.get(parent) ?? 1) - 1);
      }
    }
  }
  for (const t of tables) if (!done.has(t)) out.push(t);
  return out;
}
