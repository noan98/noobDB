// `src-tauri/src/commands/profile.rs` の IPC ラッパー。`../tauri.ts` の `api` に束ねられる。
import { invoke } from "../invoke";
import * as schemas from "../schemas";
import { parseResponse } from "../schemas";
import type { ColumnProfile, TableProfileOverview } from "../tauri";

export const profileCommands = {
  /**
   * 列データプロファイル (#974)。単一 SELECT の集計だけなので read_only セッション
   * でも動く。`approximate` は PostgreSQL (統計情報) で DISTINCT を近似する
   * (他ドライバは正確値に縮退し `notes` に理由が入る)。`samplePercent` (0〜100 の %) を渡すと
   * 標本モード (#1628) で、その割合の行だけを集計する (PostgreSQL は TABLESAMPLE SYSTEM、
   * MySQL / SQLite は乱数による抽出)。100 以上・未指定は全件。
   */
  profileColumn: (
    sessionId: string,
    database: string,
    table: string,
    column: string,
    approximate: boolean,
    topN?: number | null,
    samplePercent?: number | null,
  ) =>
    invoke<ColumnProfile>("profile_column", {
      sessionId,
      database,
      table,
      column,
      approximate,
      topN: topN ?? null,
      samplePercent: samplePercent ?? null,
    }).then((r) => parseResponse(schemas.columnProfile, r, "profile_column")),
  /**
   * 表の全列の概要 (#1539)。件数 / NULL 数 / DISTINCT / MIN・MAX を 1 回の走査で
   * まとめて取る (read_only でも可)。上位値・ヒストグラムは `profileColumn` で遅延取得。
   * `approximate` は PostgreSQL で DISTINCT を統計情報 (`pg_stats`) から近似し、全列の
   * `COUNT(DISTINCT)` を避ける (#1609。他ドライバは正確値)。
   */
  profileTable: (
    sessionId: string,
    database: string,
    table: string,
    includeDistinct: boolean,
    approximate = false,
  ) =>
    invoke<TableProfileOverview>("profile_table", {
      sessionId,
      database,
      table,
      includeDistinct,
      approximate,
    }).then((r) => parseResponse(schemas.tableProfileOverview, r, "profile_table")),
};
