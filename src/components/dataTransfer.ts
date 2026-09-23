// 接続間データ転送 (#986) の純ロジック。
//
// `DataTransferModal` (副作用・描画) と対になる判定・整形関数を置く。バックエンド
// (`commands::transfer`) が最終防波堤 (read_only 拒否・同一テーブルへの作り直し
// 拒否・読み取り専用ソースの強制) を持つので、ここは UI で無意味/危険な操作を
// 早めに止めるための判定に徹する。

import type { DriverKind, TransferMode } from "../api/tauri";
import { tableNameCollides } from "./resultsToTable";

/** 転送元。テーブル全件か、単一の読み取り専用クエリの結果セット。 */
export type TransferSource =
  | { kind: "table"; database: string | null; table: string }
  | { kind: "query"; database: string | null; sql: string };

/** 転送先テーブル名の既定値。テーブル転送は同名、クエリ結果は `query_result`。 */
export function defaultTransferTableName(source: TransferSource): string {
  return source.kind === "table" ? source.table : "query_result";
}

/** ドライバ文字列 (プロファイルの `driver`) を `DriverKind` に絞る。未知は null。 */
export function toDriverKind(driver: string): DriverKind | null {
  switch (driver) {
    case "mysql":
    case "postgres":
    case "sqlite":
    case "duckdb":
    case "mssql":
      return driver;
    default:
      return null;
  }
}

/** 接続後に既定で選ぶデータベース。プロファイルの既定 DB が一覧にあればそれ、無ければ先頭。 */
export function pickDefaultDatabase(
  databases: string[],
  profileDatabase: string | null | undefined,
): string | null {
  if (profileDatabase && databases.includes(profileDatabase)) return profileDatabase;
  return databases[0] ?? null;
}

export type TransferValidationError =
  | "tableEmpty"
  | "tableExists"
  | "tableMissing"
  | "sameTable";

export interface TransferTargetInput {
  tableName: string;
  mode: TransferMode;
  /** 転送先 DB の既存テーブル一覧。未取得 (null) のときは衝突判定をしない。 */
  existingTables: string[] | null;
  /** 転送元と転送先が同じプロファイル・同じ DB か (同一テーブルへの上書き防止)。 */
  sameProfileAndDatabase: boolean;
  source: TransferSource;
}

/**
 * 入力の妥当性。null なら実行可能。
 *
 * - `create` で同名テーブルが既にある → `tableExists` (置き換え/追記をユーザに選ばせる)
 * - `append` で追記先が無い → `tableMissing`
 * - 同じ接続・同じ DB の同じテーブルへ `create` / `replace` → `sameTable`
 *   (作り直すとソースそのものを消してしまう)
 */
export function validateTransferTarget(input: TransferTargetInput): TransferValidationError | null {
  const name = input.tableName.trim();
  if (!name) return "tableEmpty";
  if (
    input.sameProfileAndDatabase &&
    input.mode !== "append" &&
    input.source.kind === "table" &&
    input.source.table.trim().toLowerCase() === name.toLowerCase()
  ) {
    return "sameTable";
  }
  if (input.existingTables) {
    const exists = tableNameCollides(input.existingTables, name);
    if (input.mode === "create" && exists) return "tableExists";
    if (input.mode === "append" && !exists) return "tableMissing";
  }
  return null;
}

/** 実行前に挟む確認ステップ (上から順に出す)。 */
export type TransferConfirmStep =
  /** 既存テーブルを DROP して作り直す (破壊的)。 */
  | "replace"
  /** 本番接続への書き込みの確認 (warning)。 */
  | "production"
  /** 本番接続で既存テーブルを DROP する — 接続名のタイプ入力を要求する強確認。 */
  | "productionTyped";

/**
 * ターゲットの安全網設定と操作内容から、必要な確認ステップを返す。
 * `is_production` / `confirm_writes` は UI レベルの誤操作防止なので、既存画面
 * (スキーマ比較の適用・サンドボックス書き戻し) と同じ段階付けにする:
 *
 * - 置き換え (既存テーブルの DROP を伴う) は常に確認する。本番接続なら接続名の
 *   タイプ入力を要求する強確認 (#675) に格上げする。
 * - それ以外でも本番接続への書き込みは warning で確認する。`confirm_writes` は
 *   「本番接続で書き込みのたびに承認を求める」設定 (`is_production` 前提) なので、
 *   本番の確認ステップに包含される。
 */
export function transferConfirmSteps(opts: {
  mode: TransferMode;
  tableExists: boolean;
  isProduction: boolean;
}): TransferConfirmStep[] {
  const destructive = opts.mode === "replace" && opts.tableExists;
  if (destructive) return [opts.isProduction ? "productionTyped" : "replace"];
  return opts.isProduction ? ["production"] : [];
}

let transferStreamSeq = 0;
/** 転送 1 回ごとの一意な stream id (進捗イベントとキャンセルの宛先)。 */
export function makeTransferStreamId(): string {
  transferStreamSeq += 1;
  return `transfer_${Date.now().toString(36)}_${transferStreamSeq.toString(36)}`;
}
