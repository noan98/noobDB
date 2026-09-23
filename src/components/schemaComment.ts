// テーブル / 列コメント (#1002) の表示用の純ロジック。
//
// コメントはバックエンドの `describe_table` (`TableColumnInfo.comment`) と
// `list_table_comments` が返す。MySQL `COLUMN_COMMENT` / `TABLE_COMMENT`、
// PostgreSQL `col_description` / `obj_description`、MSSQL の拡張プロパティ
// `MS_Description`、DuckDB `duckdb_columns().comment` / `duckdb_tables().comment`。
// SQLite はコメント機能を持たないので常に空 (UI は非対応を明示する)。
// 編集 DDL の生成は `alterTable.ts` (`buildAlterPlan` の `comment` 系) が担う。

import type { TableColumnInfo, TableComment } from "../api/tauri";

/** 空白だけ / 未設定のコメントを `null` に正規化する。 */
export function normalizeComment(comment: string | null | undefined): string | null {
  if (comment == null) return null;
  return comment.trim() === "" ? null : comment;
}

/** ツールチップ本文 `base` にコメントを改行区切りで添える (無ければ `base` のまま)。 */
export function withComment(base: string, comment: string | null | undefined): string {
  const c = normalizeComment(comment);
  return c === null ? base : `${base}\n${c}`;
}

/** `list_table_comments` の結果をテーブル名 → コメントの辞書にする。 */
export function tableCommentMap(list: readonly TableComment[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list) {
    const c = normalizeComment(item.comment);
    if (c !== null) out[item.name] = c;
  }
  return out;
}

/**
 * 結果グリッドの列 (名前順) に対応する列コメントを並べる。`meta` に無い列
 * (式・別名など) や、コメントの無い列は `null`。
 */
export function columnCommentsFor(
  columnNames: readonly string[],
  meta: readonly TableColumnInfo[] | null | undefined,
): (string | null)[] {
  const byName = new Map((meta ?? []).map((m) => [m.name, normalizeComment(m.comment)] as const));
  return columnNames.map((name) => byName.get(name) ?? null);
}
