// 接続間データ転送 (#986) の純ロジック。
//
// `DataTransferModal` (副作用・描画) と対になる判定・整形関数を置く。バックエンド
// (`commands::transfer`) が最終防波堤 (read_only 拒否・同一テーブルへの作り直し
// 拒否・読み取り専用ソースの強制) を持つので、ここは UI で無意味/危険な操作を
// 早めに止めるための判定に徹する。

import type { DriverKind, TransferColumnSpec, TransferMode, TransferTypeKind } from "../api/tauri";
import { maskLiterals } from "../dangerousSql";
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

/** 既存テーブルへ書き込む (DDL を発行しない) モードか (#1539)。 */
export function writesExistingTable(mode: TransferMode): boolean {
  return mode === "append" || mode === "upsert";
}

export type TransferValidationError =
  | "tableEmpty"
  | "tableExists"
  | "tableMissing"
  | "sameTable"
  | "queryReadsTarget";

export interface TransferTargetInput {
  tableName: string;
  mode: TransferMode;
  /** 転送先 DB の既存テーブル一覧。未取得 (null) のときは衝突判定をしない。 */
  existingTables: string[] | null;
  /** 転送元と転送先が同じプロファイル・同じ DB か (同一テーブルへの上書き防止)。 */
  sameProfileAndDatabase: boolean;
  /**
   * 転送元と転送先が同じプロファイルか。クエリ元は `shop.users` のように別 DB を修飾して
   * 読めるので DB の一致は見ず、プロファイルの一致だけで判定する。未指定なら
   * `sameProfileAndDatabase` を使う (#1598)。
   */
  sameProfile?: boolean;
  source: TransferSource;
  /**
   * 転送先のドライバ。PostgreSQL は引用符付き識別子で大文字小文字を区別する
   * (`Users` と `users` は別テーブル) ので、同一テーブル判定を厳密比較にする。
   * 未指定・MySQL・SQLite は大文字小文字を無視して比べる (#1598)。
   */
  targetDriver?: DriverKind | null;
}

/**
 * クエリが `table` と同名の識別子を含むか (修飾子は見ない)。置き換え (DROP) で
 * クエリの読み取り元が消えるのを防ぐための保守的な判定で、別スキーマの同名テーブルも
 * 拒否する。コメント・文字列リテラルの中は無視する (#1598)。
 */
export function queryMentionsTable(sql: string, table: string, driver?: DriverKind | null): boolean {
  const target = table.trim().toLowerCase();
  if (!target) return false;
  const masked = maskLiterals(sql, driver ?? undefined, { keepQuotedIdentifiers: true });
  const tokens = masked.match(/[\p{L}\p{N}_$]+/gu) ?? [];
  return tokens.some((tok) => tok.toLowerCase() === target);
}

/**
 * 入力の妥当性。null なら実行可能。
 *
 * - `create` で同名テーブルが既にある → `tableExists` (置き換え/追記をユーザに選ばせる)
 * - `append` / `upsert` で書き込み先が無い → `tableMissing`
 * - 同じ接続・同じ DB の同じテーブルへ `create` / `replace` → `sameTable`
 *   (作り直すとソースそのものを消してしまう。クエリ元も、同名のテーブルを読むなら同様)
 */
export function validateTransferTarget(input: TransferTargetInput): TransferValidationError | null {
  const name = input.tableName.trim();
  if (!name) return "tableEmpty";
  if (!writesExistingTable(input.mode)) {
    const { source } = input;
    if (source.kind === "table") {
      if (input.sameProfileAndDatabase) {
        const a = source.table.trim();
        const same = input.targetDriver === "postgres" ? a === name : a.toLowerCase() === name.toLowerCase();
        if (same) return "sameTable";
      }
    } else if (
      (input.sameProfile ?? input.sameProfileAndDatabase) &&
      queryMentionsTable(source.sql, name, input.targetDriver)
    ) {
      // クエリ元でも、転送先と同名のテーブルを読むなら置き換えでソースが消える。
      return "queryReadsTarget";
    }
  }
  if (input.existingTables) {
    const exists = tableNameCollides(input.existingTables, name);
    if (input.mode === "create" && exists) return "tableExists";
    if (writesExistingTable(input.mode) && !exists) return "tableMissing";
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

// ── 列の選択・改名・型上書き、範囲指定 (#1623) ──

/** 型の選択肢 (UI の並び順)。`auto` は自動判定のまま。 */
export const TRANSFER_TYPE_KINDS: readonly TransferTypeKind[] = [
  "boolean",
  "integer",
  "float",
  "decimal",
  "text",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "binary",
  "json",
  "uuid",
];

/** 転送する列 1 つの下書き (UI の編集対象)。 */
export interface TransferColumnDraft {
  include: boolean;
  /** 転送先での列名。空なら元の名前。 */
  name: string;
  type: TransferTypeKind | "auto";
  /** `type === "decimal"` のときの精度 / 小数桁。 */
  precision: number;
  scale: number;
}

export const DEFAULT_DECIMAL_PRECISION = 38;
export const DEFAULT_DECIMAL_SCALE = 10;

export function defaultColumnDraft(): TransferColumnDraft {
  return {
    include: true,
    name: "",
    type: "auto",
    precision: DEFAULT_DECIMAL_PRECISION,
    scale: DEFAULT_DECIMAL_SCALE,
  };
}

/**
 * 下書きから IPC へ渡す列指定を作る。既定のまま (含める・改名なし・型は自動) の列は
 * 含めない — 指定が空なら従来どおり全列をそのまま転送する。
 */
export function buildTransferColumnSpecs(
  sourceColumns: readonly { name: string }[],
  drafts: Readonly<Record<string, TransferColumnDraft>>,
): TransferColumnSpec[] {
  const out: TransferColumnSpec[] = [];
  for (const { name: source } of sourceColumns) {
    const d = drafts[source];
    if (!d) continue;
    const renamed = d.name.trim();
    const hasName = renamed !== "" && renamed !== source;
    const hasType = d.type !== "auto";
    if (d.include && !hasName && !hasType) continue;
    const spec: TransferColumnSpec = { source };
    if (!d.include) spec.exclude = true;
    if (hasName) spec.name = renamed;
    if (hasType) {
      spec.type =
        d.type === "decimal"
          ? { kind: "decimal", precision: d.precision, scale: d.scale }
          : { kind: d.type as TransferTypeKind };
    }
    out.push(spec);
  }
  return out;
}

/** 少なくとも 1 列は転送する必要がある。ソース列が不明 (プレビュー未取得) のときは問題なし。 */
export function allColumnsExcluded(
  sourceColumns: readonly { name: string }[],
  drafts: Readonly<Record<string, TransferColumnDraft>>,
): boolean {
  return sourceColumns.length > 0 && sourceColumns.every((c) => drafts[c.name]?.include === false);
}

/** 試験転送の行数入力を検証する。正の整数でなければ `null`。 */
export function parseLimitRows(input: string): number | null {
  const t = input.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 試験転送の既定行数。 */
export const DEFAULT_TRIAL_ROWS = 100;

/**
 * DECIMAL に上書きした列のうち、小数桁が精度より大きい (DB が拒否する) ものの元の列名。
 * 含めない列と、型が DECIMAL でない列は対象外 (#1623)。
 */
export function invalidDecimalColumns(
  sourceColumns: readonly { name: string }[],
  drafts: Readonly<Record<string, TransferColumnDraft>>,
): string[] {
  return sourceColumns
    .filter((c) => {
      const d = drafts[c.name];
      return !!d && d.include && d.type === "decimal" && d.scale > d.precision;
    })
    .map((c) => c.name);
}
