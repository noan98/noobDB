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
 * 1 文なので全件成功か全件失敗になる。SQLite には複数形が無いのでテーブルごとの文を返す
 * (呼び出し側が `PRAGMA defer_foreign_keys=ON` と合わせて 1 トランザクションで流す)。
 */
export function buildDropTablesSql(
  driver: string,
  database: string | null,
  tables: readonly string[],
): string[] {
  if (tables.length === 0) return [];
  if (driver === "sqlite") return tables.map((t) => buildDropTableSql(driver, database, t));
  return [`DROP TABLE ${tables.map((t) => qualified(driver, database, t)).join(", ")};`];
}

/** パーティション操作の対象 (子パーティション)。PostgreSQL の子は別スキーマにも置ける。 */
export interface PartitionRef {
  name: string;
  schema?: string | null;
  /** サブパーティションのとき、直上のパーティションの名前とスキーマ (DETACH の対象表)。 */
  parent?: string | null;
  parentSchema?: string | null;
}

/** PostgreSQL の子パーティションの完全修飾名 (親と別スキーマなら子のスキーマを優先する)。 */
function qualifiedPartition(driver: string, database: string | null, p: PartitionRef): string {
  return qualified(driver, p.schema ?? database, p.name);
}

/**
 * パーティション単位の TRUNCATE (#1868)。PostgreSQL は子パーティションを単独のテーブルとして
 * `TRUNCATE TABLE <child>`、MySQL は `ALTER TABLE <t> TRUNCATE PARTITION <p>`。SQLite は
 * パーティション非対応なので空文字を返す。
 */
export function buildPartitionTruncateSql(
  driver: string,
  database: string | null,
  table: string,
  p: PartitionRef,
): string {
  if (driver === "sqlite") return "";
  if (driver === "postgres") return `TRUNCATE TABLE ${qualifiedPartition(driver, database, p)};`;
  return `ALTER TABLE ${qualified(driver, database, table)} TRUNCATE PARTITION ${quoteIdentFor(driver, p.name)};`;
}

/**
 * パーティションの削除 (#1868)。PostgreSQL は子テーブルごと `DROP TABLE` (サブパーティションも道連れ)、
 * MySQL は `ALTER TABLE <t> DROP PARTITION <p>` (RANGE / LIST のみ。HASH / KEY は呼び出し側が出さない)。
 */
export function buildPartitionDropSql(
  driver: string,
  database: string | null,
  table: string,
  p: PartitionRef,
): string {
  if (driver === "sqlite") return "";
  if (driver === "postgres") return `DROP TABLE ${qualifiedPartition(driver, database, p)};`;
  return `ALTER TABLE ${qualified(driver, database, table)} DROP PARTITION ${quoteIdentFor(driver, p.name)};`;
}

/** PostgreSQL の `ALTER TABLE <parent> DETACH PARTITION <child>` (#1868)。他ドライバは空文字。 */
export function buildDetachPartitionSql(
  driver: string,
  database: string | null,
  table: string,
  p: PartitionRef,
): string {
  if (driver !== "postgres") return "";
  // サブパーティションは直上のパーティション (中間表) から外す。直下の子は開いている親表から。
  const parent = p.parent
    ? qualified(driver, p.parentSchema ?? database, p.parent)
    : qualified(driver, database, table);
  return `ALTER TABLE ${parent} DETACH PARTITION ${qualifiedPartition(driver, database, p)};`;
}

/** 複数テーブルの TRUNCATE の実行方式 (#1629)。 */
export type TruncateBatchMode = "single" | "transaction" | "sequential";

/**
 * 複数テーブルの TRUNCATE (#1629)。方言で原子性が違うため、文の組み立てと流し方を揃えて返す。
 *
 * - PostgreSQL: `TRUNCATE TABLE a, b` の 1 文 (選んだテーブル同士が外部キーで参照し合っていても
 *   通り、1 文なので全件成功か全件失敗)。`single`。
 * - SQLite: TRUNCATE が無いのでテーブルごとの `DELETE FROM`。呼び出し側が `PRAGMA
 *   defer_foreign_keys=ON` と合わせて 1 トランザクションで流す (一括 DROP と同じ)。`transaction`。
 * - MySQL: `TRUNCATE` は暗黙コミットで、他テーブルから FK で参照されていると失敗する。テーブルごとの
 *   文を順に流し、失敗したらそこで止める (途中までは戻せない)。`sequential`。
 */
export function buildTruncateTablesSql(
  driver: string,
  database: string | null,
  tables: readonly string[],
): { mode: TruncateBatchMode; statements: string[] } {
  if (tables.length === 0) return { mode: "sequential", statements: [] };
  if (driver === "postgres") {
    return {
      mode: "single",
      statements: [`TRUNCATE TABLE ${tables.map((t) => qualified(driver, database, t)).join(", ")};`],
    };
  }
  return {
    mode: driver === "sqlite" ? "transaction" : "sequential",
    statements: tables.map((t) => buildTruncateSql(driver, database, t)),
  };
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

export type IndexMethod = "btree" | "hash" | "gist" | "spgist" | "gin" | "brin" | "fulltext" | "spatial";

/** ドライバごとに選べるインデックスメソッド (空配列なら USING 指定不可 = SQLite)。 */
export function indexMethodsFor(driver: string): IndexMethod[] {
  if (driver === "postgres") return ["btree", "hash", "gist", "spgist", "gin", "brin"];
  if (driver === "mysql") return ["btree", "hash", "fulltext", "spatial"];
  return [];
}

/** 無効化されたオプションごとの理由キー (i18n の `createIndexReason*` に対応)。 */
export type IndexOptionReason =
  | "noMethod"
  | "noWhereMysql"
  | "includePgOnly"
  | "includeMethod"
  | "uniqueMethod"
  | "exprFulltext"
  | "singleColumn";

export interface IndexOptionSupport {
  methods: IndexMethod[];
  where: boolean;
  include: boolean;
  unique: boolean;
  expression: boolean;
  /** キーが 1 つ (列または式) しか持てないメソッド (PostgreSQL hash / MySQL SPATIAL)。 */
  singleColumn: boolean;
  /** 無効なオプション → 理由。UI が短い説明として表示する。 */
  reasons: Partial<
    Record<"method" | "where" | "include" | "unique" | "expression" | "columns", IndexOptionReason>
  >;
}

/** 現在のメソッドを前提に、ドライバごとに使えるオプションを返す (SQL 生成と UI で共有)。 */
export function indexOptionSupport(driver: string, method?: IndexMethod): IndexOptionSupport {
  const methods = indexMethodsFor(driver);
  const m = method && methods.includes(method) ? method : undefined;
  const reasons: IndexOptionSupport["reasons"] = {};
  if (methods.length === 0) reasons.method = "noMethod";
  const where = driver !== "mysql";
  if (!where) reasons.where = "noWhereMysql";
  let include = driver === "postgres";
  if (driver !== "postgres") reasons.include = "includePgOnly";
  else if (m && !["btree", "gist", "spgist"].includes(m)) {
    include = false;
    reasons.include = "includeMethod";
  }
  let unique = true;
  if (m === "fulltext" || m === "spatial" || (driver === "postgres" && m && m !== "btree")) {
    unique = false;
    reasons.unique = "uniqueMethod";
  }
  let expression = true;
  if (m === "fulltext" || m === "spatial") {
    expression = false;
    reasons.expression = "exprFulltext";
  }
  const singleColumn = (driver === "postgres" && m === "hash") || (driver === "mysql" && m === "spatial");
  if (singleColumn) reasons.columns = "singleColumn";
  return { methods, where, include, unique, expression, singleColumn, reasons };
}

/**
 * WHERE / 式のようなユーザ入力の SQL 断片の検査。末尾の `;` は取り除き、途中の `;`
 * (文の連結) は拒否する。空なら null。戻り値は整形済み断片、`error` は不正なとき true。
 */
export function normalizeIndexFragment(raw: string | undefined): { sql: string | null; error: boolean } {
  const sql = (raw ?? "")
    .trim()
    .replace(/;+\s*$/, "")
    .trim();
  if (sql.length === 0) return { sql: null, error: false };
  return { sql, error: sql.includes(";") };
}

/** 式キーの自動名用サフィックス: 英数字化して切り詰め + 短いハッシュ (式違いで名前が衝突しない)。 */
function exprNamePart(expr: string): string {
  let h = 0;
  for (const ch of expr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const slug = expr
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 12);
  return `${slug ? `${slug}_` : ""}${h.toString(16).slice(0, 4)}`;
}

export interface CreateIndexOptions {
  name?: string;
  unique?: boolean;
  /** 列の後ろに並べる式 / 関数キー (例 `LOWER(email)`)。各項目は `(...)` で包んで出力する。 */
  expressions?: string[];
  method?: IndexMethod;
  /** 部分インデックスの条件 (PostgreSQL / SQLite)。 */
  where?: string;
  /** カバリング列 (PostgreSQL のみ)。 */
  include?: string[];
}

/**
 * `CREATE [UNIQUE|FULLTEXT|SPATIAL] INDEX` 文を生成する (#850, #1892)。方言差は
 * `db/advisor.rs::create_index_ddl` の移植 + 拡張。インデックス名を指定しなければ
 * `idx_<table>_<col1>_<col2>...` を自動生成する。空の列名は無視する。
 * ドライバが対応しないオプション (SQLite の USING / INCLUDE、MySQL の WHERE など) は
 * 不正な SQL を作らないよう無視する (UI 側は `indexOptionSupport` で無効化する)。
 * 式キーが無い・列が空のときも式だけで作れる。
 */
export function buildCreateIndexSql(
  driver: string,
  database: string | null,
  table: string,
  columns: string[],
  opts: CreateIndexOptions = {},
): string {
  const cols = columns.map((c) => c.trim()).filter((c) => c.length > 0);
  const support = indexOptionSupport(driver, opts.method);
  const exprs = support.expression
    ? (opts.expressions ?? [])
        .map((e) => normalizeIndexFragment(e).sql)
        .filter((e): e is string => e !== null)
    : [];
  const rawName = opts.name?.trim() || `idx_${table}_${[...cols, ...exprs.map(exprNamePart)].join("_")}`;
  const idxName = sanitizeIndexName(rawName);
  const keyList = [...cols.map((c) => quoteIdentFor(driver, c)), ...exprs.map((e) => `(${e})`)].join(", ");
  const method = opts.method && support.methods.includes(opts.method) ? opts.method : undefined;
  const special = driver === "mysql" && (method === "fulltext" || method === "spatial");
  const keyword = special
    ? `CREATE ${method === "fulltext" ? "FULLTEXT" : "SPATIAL"} INDEX`
    : opts.unique && support.unique
      ? "CREATE UNIQUE INDEX"
      : "CREATE INDEX";
  let sql = `${keyword} ${quoteIdentFor(driver, idxName)} ON ${qualified(driver, database, table)}`;
  if (driver === "postgres" && method) sql += ` USING ${method}`;
  sql += ` (${keyList})`;
  if (driver === "mysql" && (method === "btree" || method === "hash"))
    sql += ` USING ${method.toUpperCase()}`;
  const inc = support.include
    ? (opts.include ?? []).map((c) => c.trim()).filter((c) => c.length > 0 && !cols.includes(c))
    : [];
  if (inc.length > 0) sql += ` INCLUDE (${inc.map((c) => quoteIdentFor(driver, c)).join(", ")})`;
  const where = support.where ? normalizeIndexFragment(opts.where).sql : null;
  if (where) sql += ` WHERE ${where}`;
  return `${sql};`;
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
