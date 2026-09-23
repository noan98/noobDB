// ストアドプロシージャ / 関数の呼び出し SQL 生成 (#1003)。
//
// `get_routine_signature` が返したシグネチャとフォームの入力値から、方言別の
// 呼び出し SQL (MySQL `CALL` / `SELECT fn(...)`、PostgreSQL `CALL` /
// `SELECT * FROM fn(...)`、MSSQL `EXEC` / `SELECT`) を組み立てる副作用なしの
// 純モジュール (`queryParams.ts` と同型)。
//
// エスケープは新規実装しない: 値のリテラル化は `cellEdit.ts` の
// `literalFromInput` (= `quoteString` / 数値・真偽値の判定。共有ゴールデン
// `sqlQuotingVectors.json` が固定する規約)、識別子は `sqlDialect.ts` の
// `quoteIdentFor` をそのまま使う。入力値の検証も `validateCellInput` を共有する
// (インラインセル編集と同じ「NULL キーワード / 空文字は '' / 数値・日付の形式」)。
//
// 生成した SQL は独自経路ではなく通常のクエリ実行経路 (危険クエリ確認・
// confirm_writes ゲート → `run_query_stream` → バックエンドの
// `ensure_allowed_for_session`) に渡す。ここは文字列を作るだけ。

import type { RoutineParameter, RoutineSignature } from "../api/tauri";
import type { I18nKey } from "../i18n";
import { literalFromInput, validateCellInput } from "./cellEdit";
import { quoteIdentFor } from "./sqlDialect";

/** ルーチンの実行 UI に対応するドライバ。SQLite / DuckDB はルーチンを持たない。 */
const ROUTINE_DRIVERS = new Set(["mysql", "postgres", "mssql"]);

/** このドライバでルーチンの「実行…」を提供するか。 */
export function supportsRoutineExecution(driver: string): boolean {
  return ROUTINE_DRIVERS.has(driver);
}

/** ルーチンとして実行できるスキーマオブジェクト種別か。 */
export function isRoutineKind(kind: string): kind is "procedure" | "function" {
  return kind === "procedure" || kind === "function";
}

/**
 * パラメータがユーザの入力値を取るか。OUT と RETURNS TABLE の出力列は値を
 * 取らない (呼び出し側で変数 / NULL を割り当てる)。
 */
export function routineParamTakesInput(p: RoutineParameter): boolean {
  return p.mode !== "out" && p.mode !== "table";
}

/**
 * フォームに並べるパラメータか。PostgreSQL の RETURNS TABLE の出力列は引数では
 * なく結果の列なので出さない。
 */
export function routineParamIsArgument(p: RoutineParameter): boolean {
  return p.mode !== "table";
}

/**
 * `literalFromInput` / `validateCellInput` が判定に使う基底型名へ正規化する。
 * `numeric(10,2)` → `NUMERIC`、`varchar(20)` → `VARCHAR`。配列 (`integer[]`)
 * は数値として扱わないよう、そのまま (大文字化のみ) 返す。
 */
export function routineBaseType(dataType: string): string {
  return dataType.replace(/\(.*?\)/g, "").trim().toUpperCase();
}

/**
 * 1 パラメータ分の入力値を検証する。問題があれば i18n キー、無ければ null。
 * ルーチン引数は NULL を渡せる前提 (nullable 扱い) — 実際に許すかは DB が決める。
 */
export function validateRoutineInput(p: RoutineParameter, raw: string): I18nKey | null {
  if (!routineParamTakesInput(p)) return null;
  return validateCellInput(raw, routineBaseType(p.data_type), true);
}

/** 1 パラメータ分の SQL リテラル (PostgreSQL は型キャスト付き)。 */
export function routineArgLiteral(driver: string, p: RoutineParameter, raw: string): string {
  const lit = literalFromInput(driver, raw, { name: p.name, type_name: routineBaseType(p.data_type) });
  if (driver === "postgres") {
    // 型を明示してオーバーロード解決を確定させる (未知型リテラルのままだと
    // 同名関数の候補が複数あるときに曖昧エラーになる)。`data_type` は
    // `format_type` の出力なので、そのまま型名として書ける。
    const cast = p.data_type.trim() ? `CAST(${lit} AS ${p.data_type})` : lit;
    return p.mode === "variadic" ? `VARIADIC ${cast}` : cast;
  }
  return lit;
}

/** MySQL の OUT / INOUT 受け皿にするユーザ変数名 (`@\`name\``)。 */
function mysqlOutVar(p: RoutineParameter, index: number): string {
  return "@" + quoteIdentFor("mysql", p.name || `p${index + 1}`);
}

export interface RoutineCallInput {
  driver: string;
  /** ツリー上のデータベース (PostgreSQL はスキーマ)。 */
  database: string;
  signature: RoutineSignature;
  /** `signature.parameters` と同じ添字の入力値 (値を取らないパラメータは無視)。 */
  values: readonly string[];
}

export interface RoutineCall {
  /** 実行する SQL (複数文のときは `;` 区切りのスクリプト)。 */
  sql: string;
  /**
   * 複数文をまたいでセッション変数を共有する必要があるか (MySQL の OUT / INOUT)。
   * 通常の実行はプールから文ごとに接続を取るため、明示的トランザクション
   * (固定接続) 中でなければ OUT 値を正しく読めない。
   */
  needsSameConnection: boolean;
  /**
   * OUT / INOUT の値が結果として返るか。MSSQL の OUTPUT 引数は第 1 段階では
   * 値を渡すだけで返却値は表示しない (false)。OUT / INOUT が無ければ true。
   */
  outputsReturned: boolean;
}

/** 修飾名: MySQL `db`.`name`、PostgreSQL "schema"."name"、MSSQL [db].[dbo].[name]。 */
export function routineQualifiedName(driver: string, database: string, name: string): string {
  const q = (s: string) => quoteIdentFor(driver, s);
  if (driver === "mssql") return `${q(database)}.${q("dbo")}.${q(name)}`;
  return `${q(database)}.${q(name)}`;
}

/**
 * シグネチャと入力値から呼び出し SQL を組み立てる。
 *
 * - MySQL: プロシージャは `CALL`。OUT / INOUT があれば `SET @v = ...;` →
 *   `CALL ...(@v)` → `SELECT @v AS v` のスクリプトにする。関数は
 *   `SELECT fn(...) AS fn`。
 * - PostgreSQL: プロシージャは `CALL` (OUT 引数には型付き NULL を渡すと、OUT /
 *   INOUT の値が 1 行の結果として返る)。関数は `SELECT * FROM fn(...)` (OUT
 *   引数・RETURNS TABLE・集合返却も列として展開される)。
 * - MSSQL: プロシージャは `EXEC` (位置指定)。関数はテーブル値なら
 *   `SELECT * FROM fn(...)`、スカラーなら `SELECT fn(...) AS fn`。
 */
export function buildRoutineCall(input: RoutineCallInput): RoutineCall {
  const { driver, database, signature, values } = input;
  const params = signature.parameters;
  const name = routineQualifiedName(driver, database, signature.name);
  const alias = quoteIdentFor(driver, signature.name);
  const valueAt = (i: number) => values[i] ?? "";
  const hasOutputs = params.some((p) => p.mode === "out" || p.mode === "inout");

  if (driver === "postgres") {
    if (signature.kind === "procedure") {
      const args = params
        .filter(routineParamIsArgument)
        .map((p) => {
          const i = params.indexOf(p);
          return p.mode === "out"
            ? p.data_type.trim()
              ? `CAST(NULL AS ${p.data_type})`
              : "NULL"
            : routineArgLiteral(driver, p, valueAt(i));
        });
      return { sql: `CALL ${name}(${args.join(", ")})`, needsSameConnection: false, outputsReturned: true };
    }
    const args = params
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => routineParamTakesInput(p))
      .map(({ p, i }) => routineArgLiteral(driver, p, valueAt(i)));
    return {
      sql: `SELECT * FROM ${name}(${args.join(", ")})`,
      needsSameConnection: false,
      outputsReturned: true,
    };
  }

  if (driver === "mssql") {
    const args = params
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => routineParamTakesInput(p))
      .map(({ p, i }) => routineArgLiteral(driver, p, valueAt(i)));
    if (signature.kind === "procedure") {
      const sql = args.length > 0 ? `EXEC ${name} ${args.join(", ")}` : `EXEC ${name}`;
      return { sql, needsSameConnection: false, outputsReturned: !hasOutputs };
    }
    const call = `${name}(${args.join(", ")})`;
    const sql = signature.returns_set ? `SELECT * FROM ${call}` : `SELECT ${call} AS ${alias}`;
    return { sql, needsSameConnection: false, outputsReturned: true };
  }

  // MySQL (未知ドライバも quoteIdentFor の規約どおり MySQL 扱い)。
  if (signature.kind === "function") {
    const args = params.map((p, i) => routineArgLiteral(driver, p, valueAt(i)));
    return {
      sql: `SELECT ${name}(${args.join(", ")}) AS ${alias}`,
      needsSameConnection: false,
      outputsReturned: true,
    };
  }
  const sets: string[] = [];
  const outs: string[] = [];
  const args = params.map((p, i) => {
    if (p.mode === "out" || p.mode === "inout") {
      const v = mysqlOutVar(p, i);
      if (p.mode === "inout") sets.push(`SET ${v} = ${routineArgLiteral(driver, p, valueAt(i))}`);
      outs.push(`${v} AS ${quoteIdentFor(driver, p.name || `p${i + 1}`)}`);
      return v;
    }
    return routineArgLiteral(driver, p, valueAt(i));
  });
  const call = `CALL ${name}(${args.join(", ")})`;
  if (!hasOutputs) return { sql: call, needsSameConnection: false, outputsReturned: true };
  const script = [...sets, call, `SELECT ${outs.join(", ")}`].map((s) => `${s};`).join("\n");
  return { sql: script, needsSameConnection: true, outputsReturned: true };
}
