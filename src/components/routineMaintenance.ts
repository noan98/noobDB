// ルーチン (プロシージャ / 関数)・トリガーの新規作成・定義編集の SQL 生成 (純ロジック、#1192)。
//
// `viewMaintenance.ts` の対になるモジュール。`get_object_definition` が返す DDL を
// ユーザが編集したテキストから、ドライバ別の「実行すべき文の配列」を組み立てる。
// 戻り値は `run_query_transaction` (文ごとに 1 回 execute するので、MySQL の
// `BEGIN ... END` 本体に含まれる `;` を文分割で壊さない) へそのまま渡せる。
//
// ドライバ別の方針:
// - PostgreSQL: 関数 / プロシージャは `CREATE OR REPLACE` (先頭が `CREATE FUNCTION` なら
//   補う)。トリガーは `DROP TRIGGER IF EXISTS <name> ON <table>` + `CREATE TRIGGER`
//   (PG14+ の `CREATE OR REPLACE TRIGGER` は使わず互換を優先)。DDL もトランザクション
//   内で実行できるので、途中で失敗しても元の定義は残る。ドル引用を含むため文の分割は
//   `sqlScript.ts` (`splitSqlStatements`) に任せる。
// - MySQL: ルーチン / トリガーとも `CREATE OR REPLACE` が無いため `DROP ... IF EXISTS` +
//   `CREATE`。DDL は暗黙コミットされ巻き戻せない。編集全体を「1 つの CREATE 文」として
//   扱い、`;` では分割しない (`DELIMITER` 行は取り除く)。
// - SQLite: トリガーのみ (ルーチンは存在しない)。`DROP TRIGGER IF EXISTS` + `CREATE
//   TRIGGER` を 1 トランザクションで実行する。本体の `BEGIN ... END` は 1 文のまま扱う。

import type { I18nKey } from "../i18n";
import { splitSqlStatements } from "../sqlScript";
import { quoteIdentFor } from "./sqlDialect";

export type EditableObjectKind = "procedure" | "function" | "trigger";

export function isEditableObjectKind(kind: string): kind is EditableObjectKind {
  return kind === "procedure" || kind === "function" || kind === "trigger";
}

/** このドライバで、その種別の作成・編集を提供するか (SQLite はトリガーのみ)。 */
export function supportsRoutineEditing(driver: string, kind: EditableObjectKind): boolean {
  if (driver === "sqlite") return kind === "trigger";
  return driver === "mysql" || driver === "postgres";
}

/** 適用が all-or-nothing で巻き戻せるか。MySQL は DDL が暗黙コミットされ不可。 */
export function routineApplyIsAtomic(driver: string): boolean {
  return driver !== "mysql";
}

/** 修飾名: MySQL `db`.`name`、PostgreSQL "schema"."name"、SQLite は修飾なし。 */
function qualified(driver: string, database: string, name: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, name);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, name)}`;
}

/** 新規作成テンプレート。名前・型・本体はユーザが書き換える前提のプレースホルダ。 */
export function buildRoutineTemplate(
  driver: string,
  kind: EditableObjectKind,
  database: string,
): string {
  const q = (name: string) => qualified(driver, database, name);
  if (driver === "postgres") {
    if (kind === "procedure") {
      return [
        `CREATE OR REPLACE PROCEDURE ${q("new_procedure")}(p_id integer)`,
        "LANGUAGE plpgsql",
        "AS $$",
        "BEGIN",
        "  -- TODO: procedure body",
        "  PERFORM p_id;",
        "END;",
        "$$",
      ].join("\n");
    }
    if (kind === "function") {
      return [
        `CREATE OR REPLACE FUNCTION ${q("new_function")}(p_value integer)`,
        "RETURNS integer",
        "LANGUAGE plpgsql",
        "AS $$",
        "BEGIN",
        "  RETURN p_value;",
        "END;",
        "$$",
      ].join("\n");
    }
    return [
      `CREATE OR REPLACE FUNCTION ${q("new_trigger_fn")}()`,
      "RETURNS trigger",
      "LANGUAGE plpgsql",
      "AS $$",
      "BEGIN",
      "  RETURN NEW;",
      "END;",
      "$$;",
      "",
      `CREATE TRIGGER ${quoteIdentFor(driver, "new_trigger")}`,
      `BEFORE INSERT ON ${q("table_name")}`,
      "FOR EACH ROW",
      `EXECUTE FUNCTION ${q("new_trigger_fn")}()`,
    ].join("\n");
  }
  if (driver === "mysql") {
    if (kind === "procedure") {
      return [
        `CREATE PROCEDURE ${q("new_procedure")}(IN p_id INT)`,
        "BEGIN",
        "  SELECT p_id AS id;",
        "END",
      ].join("\n");
    }
    if (kind === "function") {
      return [
        `CREATE FUNCTION ${q("new_function")}(p_value INT)`,
        "RETURNS INT",
        "DETERMINISTIC",
        "BEGIN",
        "  RETURN p_value;",
        "END",
      ].join("\n");
    }
    return [
      `CREATE TRIGGER ${q("new_trigger")}`,
      `BEFORE INSERT ON ${q("table_name")}`,
      "FOR EACH ROW",
      "BEGIN",
      "  SET @last_insert_marker = 1;",
      "END",
    ].join("\n");
  }
  // sqlite (トリガーのみ)
  return [
    `CREATE TRIGGER ${quoteIdentFor(driver, "new_trigger")}`,
    "AFTER INSERT ON \"table_name\"",
    "FOR EACH ROW",
    "BEGIN",
    "  SELECT 1;",
    "END",
  ].join("\n");
}

/** 先頭の空白・`--` 行コメントとブロックコメントを取り除く (CREATE の判定用)。 */
function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    const next = s
      .replace(/^\s+/, "")
      .replace(/^--[^\n]*(\n|$)/, "")
      .replace(/^\/\*[\s\S]*?\*\//, "");
    if (next === s) return s;
    s = next;
  }
}

/** 末尾の `;` と空白を剥がす。 */
function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/, "");
}

/**
 * `DELIMITER` 行 (mysql クライアントの構文で、サーバは解釈しない) を取り除き、
 * カスタム区切りで閉じられた本体の末尾区切りも落とす。
 */
export function stripDelimiterDirectives(sql: string): string {
  const m = /^[ \t]*DELIMITER[ \t]+(\S+)[ \t]*$/im.exec(sql);
  if (!m) return sql;
  const delimiter = m[1];
  const body = sql.replace(/^[ \t]*DELIMITER[ \t]+\S+[ \t]*$/gim, "").trim();
  if (delimiter !== ";" && body.endsWith(delimiter)) {
    return body.slice(0, body.length - delimiter.length).trim();
  }
  return body;
}

/** PostgreSQL のトリガー定義 (`pg_get_triggerdef`) から `ON <table>` の対象を取り出す。 */
export function extractPgTriggerTable(ddl: string): string | null {
  const ident = String.raw`(?:"(?:[^"]|"")+"|[\w$]+)`;
  const re = new RegExp(
    String.raw`^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+${ident}[\s\S]*?\bON\s+(${ident}(?:\s*\.\s*${ident})?)`,
    "i",
  );
  const m = re.exec(stripLeadingComments(ddl));
  // ドット周りの空白だけ詰める (引用符内の空白は識別子の一部なので触らない)。
  return m ? m[1].replace(/\s*\.\s*(?=["\w$])/g, ".") : null;
}

const KIND_WORD: Record<EditableObjectKind, string> = {
  procedure: "PROCEDURE",
  function: "FUNCTION",
  trigger: "TRIGGER",
};

export interface ApplyRoutineInput {
  driver: string;
  database: string;
  kind: EditableObjectKind;
  /** 編集対象 (既存) の名前。新規作成なら null。 */
  name: string | null;
  /** `get_object_definition` が返した元の DDL。新規作成なら null。 */
  originalDdl: string | null;
  /** ユーザが編集したテキスト。 */
  ddl: string;
}

export type ApplyRoutineResult =
  | { ok: true; statements: string[] }
  | { ok: false; error: I18nKey; vars?: Record<string, string> };

/**
 * 編集テキストから実行すべき文の配列を作る。既存オブジェクトの編集 (`name` あり) では
 * 置換のための DROP (または `CREATE OR REPLACE`) を含み、新規作成では `CREATE` のみ
 * (同名が既にあれば DB がエラーにする)。
 */
export function buildApplyRoutineStatements(input: ApplyRoutineInput): ApplyRoutineResult {
  const { driver, database, kind, name, originalDdl } = input;
  const cleaned = driver === "mysql" ? stripDelimiterDirectives(input.ddl) : input.ddl;
  if (cleaned.trim().length === 0) return { ok: false, error: "routineEditErrEmpty" };

  const isCreate = (sql: string) => /^CREATE\b/i.test(stripLeadingComments(sql));
  const kindWord = KIND_WORD[kind];
  const mentionsKind = (sql: string) =>
    new RegExp(String.raw`^CREATE\b[^;]*?\b${kindWord}\b`, "i").test(stripLeadingComments(sql));

  let creates: string[];
  if (driver === "postgres") {
    creates = splitSqlStatements(cleaned, "postgres");
  } else {
    // MySQL / SQLite の本体は `;` を含むので分割せず、全体を 1 文として送る。
    creates = [stripTrailingSemicolons(cleaned)];
  }
  if (creates.length === 0) return { ok: false, error: "routineEditErrEmpty" };
  if (!isCreate(creates[0]) || !mentionsKind(creates[0])) {
    // PG のトリガーテンプレートは先頭が補助関数 (`CREATE FUNCTION`) になるので、
    // トリガー種別では「どれかの文が CREATE TRIGGER」であれば許す。
    const ok =
      kind === "trigger" &&
      driver === "postgres" &&
      creates.every(isCreate) &&
      creates.some(mentionsKind);
    if (!ok) return { ok: false, error: "routineEditErrNotCreate", vars: { kind: kindWord } };
  }

  const statements: string[] = [];
  if (driver === "postgres" && kind !== "trigger") {
    // 関数 / プロシージャは CREATE OR REPLACE で置換する。
    creates = creates.map((sql, i) =>
      i === 0
        ? sql.replace(
            /^(\s*)CREATE\s+(?!OR\s+REPLACE\b)(FUNCTION|PROCEDURE)\b/i,
            "$1CREATE OR REPLACE $2",
          )
        : sql,
    );
  } else if (name !== null) {
    const ident = quoteIdentFor(driver, name);
    if (driver === "postgres") {
      const table = originalDdl ? extractPgTriggerTable(originalDdl) : null;
      if (!table) return { ok: false, error: "routineEditErrNoTable" };
      statements.push(`DROP TRIGGER IF EXISTS ${ident} ON ${table};`);
    } else if (driver === "mysql") {
      statements.push(`DROP ${kindWord} IF EXISTS ${qualified(driver, database, name)};`);
    } else {
      statements.push(`DROP TRIGGER IF EXISTS ${ident};`);
    }
  }
  for (const sql of creates) {
    const body = driver === "postgres" ? stripTrailingSemicolons(sql) : sql;
    statements.push(`${body};`);
  }
  return { ok: true, statements };
}

/** MySQL の編集失敗時に元の定義へ戻すための文 (元の DDL を 1 文として)。 */
export function buildRestoreStatement(driver: string, originalDdl: string): string {
  const base = driver === "mysql" ? stripDelimiterDirectives(originalDdl) : originalDdl;
  return stripTrailingSemicolons(base);
}
