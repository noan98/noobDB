// ビュー定義編集・作成の SQL 生成 (純ロジック、#851)。
//
// 「現在のクエリをビューとして保存」(CREATE VIEW) と「ビュー定義を編集」
// (CREATE OR REPLACE VIEW / SQLite は DROP+CREATE) の DDL 組み立てを担う。識別子クオートは sqlDialect.ts を流用し、CTAS 対象判定
// (単一 SELECT/WITH か) と名前衝突判定は `resultsToTable.ts` の
// `isCtasEligibleSql` / `tableNameCollides` をそのまま共有する (view/table で
// 判定ロジックは同一のため二重実装しない)。

import { quoteIdentFor } from "./sqlDialect";

/** 完全修飾したビュー名。 */
function qualifiedView(driver: string, database: string | null | undefined, name: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, name);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, name)}`;
}

/** `sourceSql` 末尾のセミコロン/空白を剥がす (呼び出し元の SQL をそのまま連結して
 *  二重セミコロンにならないようにする、`resultsToTable.ts` と同じ方針)。 */
function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

/**
 * 新規ビュー作成 (「現在のクエリをビューとして保存」)。名前が既存ビューと衝突
 * しないことは呼び出し側 (`SaveAsViewModal`) が確認済みの前提 — 衝突する場合は
 * 代わりに `buildReplaceViewSql` を使う。
 */
export function buildCreateViewSql(
  driver: string,
  database: string | null,
  name: string,
  query: string,
): string {
  const qualified = qualifiedView(driver, database, name);
  return `CREATE VIEW ${qualified} AS\n${stripTrailingSemicolon(query)};`;
}

/**
 * 既存ビューの置換 (「ビュー定義を編集」、または「保存」で既存ビューと同名を
 * 指定したとき)。
 *
 * MySQL / PostgreSQL は `CREATE OR REPLACE VIEW` を単一文でサポートする。
 * SQLite にはこれが無いため `DROP VIEW IF EXISTS` + `CREATE VIEW` の 2 文に
 * 分解する。
 *
 * 戻り値は常に「実行すべき文の配列」で統一し (単一文のドライバでも要素数 1 の
 * 配列)、呼び出し側は `run_query_transaction` (all-or-nothing) に渡すだけで
 * ドライバ分岐を持たなくて済む。
 */
export function buildReplaceViewSql(
  driver: string,
  database: string | null,
  name: string,
  query: string,
): string[] {
  const qualified = qualifiedView(driver, database, name);
  const body = stripTrailingSemicolon(query);
  if (driver === "sqlite") {
    return [`DROP VIEW IF EXISTS ${qualified};`, `CREATE VIEW ${qualified} AS\n${body};`];
  }
  return [`CREATE OR REPLACE VIEW ${qualified} AS\n${body};`];
}

/** `DROP VIEW` 文。テーブル保守の削除確認導線 (`App.tsx` の `handleDropTable` と
 *  同じ確認ダイアログ・実行経路) から呼ばれる想定。 */
export function buildDropViewSql(driver: string, database: string | null, name: string): string {
  return `DROP VIEW ${qualifiedView(driver, database, name)};`;
}

/**
 * `get_object_definition` が返す生 DDL からクエリ本文だけを取り出す。
 *
 * ドライバごとに返る文字列のフォーマットが異なる: MySQL の `SHOW CREATE VIEW` は
 * `ALGORITHM=...DEFINER=...VIEW name AS select ...` という完全な文、SQLite は
 * 原文の `CREATE VIEW name AS ...` そのもの、PostgreSQL の `pg_get_viewdef` は
 * 最初からクエリ本文のみ (`CREATE VIEW` の外殻を含まない)。これらに共通するのは
 * 「最初に現れる `AS SELECT` / `AS WITH` (大小無視) の直後がクエリ本文の開始」
 * という点で、`db.mysql`/`db.sqlite` はこのパターンにマッチしてラッパー部分を
 * 剥がし、元から本文のみの PostgreSQL はマッチせず全文がそのまま本文として
 * 返る。`dangerousSql.ts` と
 * 同じベストエフォート判定 (パーサではない) — パターンが見つからない場合は常に
 * 全文をそのまま返すので、想定外のフォーマットでも本文を失うことはない。
 */
export function extractViewBody(ddl: string): string {
  const trimmed = ddl.trim();
  const match = /\bAS\s+(?=SELECT\b|WITH\b)/i.exec(trimmed);
  if (!match) return trimmed;
  return trimmed.slice(match.index + match[0].length).trim();
}
