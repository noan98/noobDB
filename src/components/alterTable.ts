// ALTER TABLE (列の追加 / 変更 / 削除 / リネーム) と CREATE INDEX の SQL 生成
// (純ロジック、#794)。
//
// 既存テーブルの列編集フォームから方言別の DDL 文字列配列を組み立てる。
// `createTable.ts` (CREATE TABLE ウィザード) / `tableMaintenance.ts`
// (TRUNCATE/DROP/RENAME) と同じ「純粋関数 + Vitest」のパターンを踏襲する。
// 識別子のクオートは `sqlDialect.ts`、DEFAULT のリテラル整形は `createTable.ts` の
// `formatDefault` を共有する。
//
// バックエンド `db/sync.rs::generate_sync_sql` が持つ方言吸収の方針
// (MySQL は 1 文でまとめて書き換え、PostgreSQL は facet ごとに個別の
// `ALTER COLUMN`、SQLite は列のインプレース変更が不可) を踏襲するが、こちらは
// 2 スキーマの diff ではなく単一テーブルのフォーム入力 (baseline vs 編集後) から
// 直接組み立てる — フォームは型/NOT NULL/DEFAULT については常に列の完全な定義を
// 保持しているため、MySQL の `MODIFY`/`CHANGE COLUMN` が要求するそれらのフル指定を
// 毎回自然に満たせる。ただし MySQL の `extra` (`auto_increment`・
// `on update CURRENT_TIMESTAMP` 等、`information_schema.COLUMNS.EXTRA` 由来) は
// `CHANGE COLUMN` 実行時に baseline の値を逐語で付け足して保持する。列コメント
// (`COMMENT`) も #1002 で `describeTable` が取得するようになったので、`CHANGE
// COLUMN` で列を再定義するときは baseline (または編集後) のコメントを付け足して
// 保持する。生成列の式 (#1893) は `describeTable` が返さないので、呼び出し側が
// `alterTableContext.generated` から `ExistingColumnBaseline.generated` に載せ、MySQL の再定義で
// 付け直す (下記)。文字セット/照合順序などそれ以外の付随属性は保持できない —
// フル対応ではなく最小対応であることに注意。
//
// テーブル / 列コメントの編集 (#1002) もここで方言別に組み立てる:
// MySQL は `ALTER TABLE ... COMMENT = '...'` と列の再定義 (`CHANGE COLUMN ...
// COMMENT '...'`)、PostgreSQL は `COMMENT ON TABLE|COLUMN ... IS ...`。
// SQLite はコメント機能を持たないので生成しない (UI 側で入力欄を無効化する)。
//
// SQLite は列の型 / NOT NULL / DEFAULT の変更と FK / CHECK の追加・削除を `ALTER TABLE` で
// 行えない (#1888)。そのような編集があるときは文を出さず、編集内容を `AlterPlan.rebuild`
// (`SqliteRebuildEdit`) に畳んで返す。呼び出し側 (AlterTableModal) が IPC
// `plan_sqlite_table_rebuild` に渡し、スキーマ同期と同じテーブル再作成 SQL を受け取って
// `rebuildTable` 文として扱う。再作成にはリネーム・列の追加・削除もまとめて含まれるので、
// その場合は ALTER の文を重ねて出さない (インデックスの作成だけは別文として残る)。
//
// 生成した文言 (未対応の変更の通知など) は理由コードのみを返し、実際の文字列化は
// 呼び出し側 (i18n) に任せる — このモジュールは表示に依存しない。

import type { SqliteRebuildEdit } from "../api/tauri";
import { quoteIdentFor } from "./sqlDialect";
import {
  activeGenerated,
  CURRENT_TIME_FN_RE,
  formatDefault,
  generatedClause,
  matchParen,
  type GeneratedSpec,
} from "./createTable";
import { quoteString } from "./cellEdit";
import {
  checkClause,
  dropCheckClause,
  dropForeignKeyClause,
  foreignKeyClause,
  isCompleteCheck,
  isCompleteForeignKey,
  type CheckDef,
  type ForeignKeyDef,
} from "./tableConstraints";

/** DB から読み取った既存列の現状 (`describeTable` の結果をそのまま使う)。 */
export interface ExistingColumnBaseline {
  name: string;
  type: string;
  notNull: boolean;
  /**
   * 生の DEFAULT 式 (無ければ空文字)。ドライバによって表現が異なる — MySQL は
   * クオートなしの生値 (`pending`)、PostgreSQL/SQLite は `'x'::type` のような
   * 式そのもののことがある。
   */
  defaultValue: string;
  /**
   * MySQL の `information_schema.COLUMNS.EXTRA` (`auto_increment` /
   * `on update CURRENT_TIMESTAMP` 等、無ければ空文字)。`CHANGE COLUMN` で列を
   * 再定義する際に逐語で付け足し、AUTO_INCREMENT 等が消えないようにする
   * (`db/sync.rs::column_def` と同じ「MySQL のみ extra を逐語で追加」方針)。
   * MySQL 以外では常に空文字で無視される。
   */
  extra: string;
  /** 列コメント (#1002)。無ければ空文字 / 未指定。SQLite は常に空。 */
  comment?: string;
  /**
   * 生成列の式と STORED / VIRTUAL (#1893)。生成列でなければ未指定。SQLite の生成列は
   * `describeTable` の列に出ない隠れた列なので、呼び出し側が合成した行にこれを載せる。
   */
  generated?: GeneratedSpec;
}

/** MySQL / MariaDB の EXTRA に出る生成列の印 (`STORED GENERATED` など)。`DEFAULT_GENERATED` は含まない。 */
const GENERATED_EXTRA_RE = /\b(STORED|VIRTUAL|PERSISTENT)\s+GENERATED\b/gi;

/** EXTRA が生成列を示しているか。 */
export function extraMarksGenerated(extra: string): boolean {
  return new RegExp(GENERATED_EXTRA_RE.source, "i").test(extra);
}

/**
 * 1 列ぶんの編集内容。フォームは `baseline` の値で初期化される想定で、
 * 未編集ならフィールド値は baseline と一致し「差分なし」と判定される。
 */
export interface ExistingColumnEdit {
  /** 編集対象の元の列名 (`baseline.name` とのジョインキー)。 */
  original: string;
  /** true の場合、他フィールドを無視して `DROP COLUMN` のみ生成する。 */
  drop: boolean;
  /** 新しい列名。baseline と異なればリネームとして扱う。 */
  name: string;
  type: string;
  notNull: boolean;
  /** 生の DEFAULT 入力。空文字は「デフォルトなし」。 */
  defaultValue: string;
  /** 編集後の列コメント (#1002)。未指定なら baseline のまま (変更なし)。 */
  comment?: string;
  /** 編集後の生成列の式 (#1893)。未指定なら baseline のまま。baseline が生成列でなければ無視する。 */
  generated?: GeneratedSpec;
}

/**
 * `ALTER TABLE ADD COLUMN` で追加する新しい列。`createTable.ts` の `ColumnDef` より
 * 属性を絞っている — `PRIMARY KEY` / `UNIQUE` / 自動採番を ALTER 経由の ADD で
 * 安全に方言吸収するのは複雑さに見合わないため対象外とし (必要なら別途
 * インデックス作成や手動 SQL で対応)、型 / NOT NULL / DEFAULT のみを扱う。
 */
export interface NewColumn {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string;
  /**
   * 生成列 (#1893)。式が入っていれば `<型> <生成句> [NOT NULL]` の生成列として追加し、DEFAULT は付けない。
   * PostgreSQL は STORED のみ。SQLite の STORED はテーブル再作成で追加する。
   */
  generated?: GeneratedSpec;
  /**
   * 列の位置 (#1625)。MySQL だけが `FIRST` / `AFTER <列>` を持つ。未指定 (`end`) は末尾。
   * PostgreSQL / SQLite は列の位置を指定できないので、指定があっても無視する
   * (`supportsColumnPosition` が false のドライバでは UI が選択肢を無効にする)。
   */
  position?: ColumnPosition;
}

/** 新規列の位置指定。 */
export type ColumnPosition = { mode: "end" } | { mode: "first" } | { mode: "after"; column: string };

/** 列の位置を指定できるドライバか (MySQL のみ)。 */
export function supportsColumnPosition(driver: string): boolean {
  return driver === "mysql";
}

export interface IndexDef {
  name: string;
  columns: string[];
  unique: boolean;
}

/** インデックス行の不備 (#1532)。`buildAlterPlan` はこれが有る行を文にしない。 */
export interface IndexRowProblems {
  missingName: boolean;
  missingColumns: boolean;
}

/** インデックス行の不備を調べる。不備が無ければ `null`。 */
export function indexRowProblems(idx: IndexDef): IndexRowProblems | null {
  const missingName = idx.name.trim().length === 0;
  const missingColumns = idx.columns.every((c) => c.trim().length === 0);
  return missingName || missingColumns ? { missingName, missingColumns } : null;
}

export interface AlterTableForm {
  database?: string | null;
  table: string;
  baseline: ExistingColumnBaseline[];
  existing: ExistingColumnEdit[];
  added: NewColumn[];
  indexes: IndexDef[];
  /** テーブルコメントの編集 (#1002)。`before` は DB の現状、`after` は入力値。 */
  tableComment?: { before: string; after: string };
  /** 追加する外部キー (#1191)。不完全な行は無視する。 */
  addedForeignKeys?: ForeignKeyDef[];
  /** 追加する CHECK 制約 (#1191)。式が空の行は無視する。 */
  addedChecks?: CheckDef[];
  /** 削除する外部キーの制約名 (#1191)。 */
  droppedForeignKeys?: string[];
  /** 削除する CHECK 制約の制約名 (#1191)。 */
  droppedChecks?: string[];
  /**
   * SQLite (#1888): 現状の外部キー。SQLite の FK は実在の制約名を持たない (合成名 `表:id`) ので、
   * `droppedForeignKeys` の名前から (列, 参照先) を引いて再作成に渡す。
   */
  existingForeignKeys?: { name: string | null; columns: string[]; refTable: string }[];
  /** SQLite (#1888): 削除する CHECK 制約の定義 (`CHECK (...)` 句全体)。名前の無い制約もあるので定義で指す。 */
  droppedCheckDefinitions?: string[];
}

export type AlterStatementKind =
  | "addColumn"
  | "renameColumn"
  | "modifyColumn"
  | "dropColumn"
  | "createIndex"
  | "comment"
  | "addForeignKey"
  | "addCheck"
  | "dropForeignKey"
  | "dropCheck"
  /** SQLite のテーブル再作成 (#1888)。`AlterPlan.rebuild` から呼び出し側が差し込む。 */
  | "rebuildTable";

export interface AlterStatement {
  sql: string;
  kind: AlterStatementKind;
  /** true は `DROP COLUMN` — 呼び出し側の危険操作確認のゲートに使う。 */
  destructive: boolean;
}

/** 文にできなかった編集の理由コード (#1893)。文言は呼び出し側 (i18n) が組み立てる。 */
export type AlterWarningCode =
  /** 生成列の式の変更に対応しないドライバ (PostgreSQL)。 */
  | "generatedExpressionUnsupported"
  /** 既存の生成列の STORED / VIRTUAL の切り替え (MySQL / PostgreSQL は不可)。 */
  | "generatedStorageUnsupported"
  /** 生成列の式を取得できておらず、再定義すると式を失うので文にしなかった (MySQL)。 */
  | "generatedExpressionUnknown";

export interface AlterWarning {
  code: AlterWarningCode;
  /** 対象の列名 (編集前)。 */
  column: string;
}

export interface AlterPlan {
  statements: AlterStatement[];
  /** 文にできなかった編集 (#1893)。呼び出し側は画面に出し、該当の編集が反映されないことを伝える。 */
  warnings: AlterWarning[];
  /**
   * SQLite でテーブル再作成が要る編集 (#1888)。非 null のとき、列の変更 (リネーム・追加・削除を含む)
   * と FK / CHECK の変更は `statements` に含まれず、これを `plan_sqlite_table_rebuild` へ渡して得た
   * 再作成 SQL が代わりを務める。MySQL / PostgreSQL と、再作成が要らない SQLite の編集では null。
   */
  rebuild: SqliteRebuildEdit | null;
}

/**
 * 既存テーブルへの FK / CHECK の追加・削除に対応するドライバか (#1191, #1888)。MySQL / PostgreSQL は
 * `ALTER TABLE` で行い、SQLite はテーブル再作成 (`AlterPlan.rebuild`) で行う。
 */
export function supportsConstraintAlter(driver: string): boolean {
  return driver === "mysql" || driver === "postgres" || driver === "sqlite";
}

/** FK / CHECK の変更を `ALTER TABLE` ではなくテーブル再作成で行うドライバか (#1888)。 */
export function constraintAlterNeedsRebuild(driver: string): boolean {
  return driver === "sqlite";
}

/**
 * テーブル / 列コメントの編集に対応するドライバか (#1002)。SQLite はコメント機能を
 * 持たない (DDL 中の `--` コメントは保持されるが、カタログとして読み書きできない)
 * ため非対応で、UI はコメント欄を無効化して理由を表示する。
 */
export function supportsComments(driver: string): boolean {
  return driver === "mysql" || driver === "postgres";
}

/** `COMMENT ON ... IS ...` の右辺 (空文字はコメント削除 = `NULL`)。 */
function commentOnValue(driver: string, value: string): string {
  return value.trim() === "" ? "NULL" : quoteString(driver, value);
}

/**
 * テーブルコメントの変更文 (#1002)。変更が無い / 非対応ドライバなら null。
 */
function tableCommentSql(driver: string, tIdent: string, before: string, after: string): string | null {
  if (!supportsComments(driver) || before === after) return null;
  if (driver === "mysql") return `ALTER TABLE ${tIdent} COMMENT = ${quoteString(driver, after)};`;
  return `COMMENT ON TABLE ${tIdent} IS ${commentOnValue(driver, after)};`;
}

/**
 * 列コメントの変更文 (PostgreSQL、#1002)。MySQL は列の再定義に含めるので
 * ここでは扱わない。`column` はリネーム後の列名。
 */
function columnCommentSql(
  driver: string,
  tIdent: string,
  column: string,
  before: string,
  after: string,
): string | null {
  if (before === after) return null;
  if (driver === "postgres") {
    return `COMMENT ON COLUMN ${tIdent}.${quoteIdentFor(driver, column)} IS ${commentOnValue(driver, after)};`;
  }
  return null;
}

/** 完全修飾したテーブル名 (SQLite はスキーマ非対応なので table のみ)。`tableMaintenance.ts` /
 * `createTable.ts` と同じ規則。 */
function qualifiedName(driver: string, database: string | null | undefined, table: string): string {
  if (driver === "sqlite" || !database) return quoteIdentFor(driver, table);
  return `${quoteIdentFor(driver, database)}.${quoteIdentFor(driver, table)}`;
}

/** `ADD COLUMN` 1 列ぶんの定義断片 (`<ident> <type> [NOT NULL] [DEFAULT x]`)。 */
function newColumnLine(driver: string, col: NewColumn): string {
  const type = col.type.trim() || "TEXT";
  const parts = [quoteIdentFor(driver, col.name.trim()), type];
  // 生成列は生成句を NOT NULL より前に置く (MySQL の文法)。DEFAULT は付けられない。
  const generated = activeGenerated(col);
  if (generated) parts.push(generatedClause(driver, generated));
  if (col.notNull) parts.push("NOT NULL");
  const def = generated ? null : formatDefault(driver, col.defaultValue, type);
  if (def !== null) parts.push(`DEFAULT ${def}`);
  const pos = col.position;
  if (supportsColumnPosition(driver) && pos) {
    if (pos.mode === "first") parts.push("FIRST");
    else if (pos.mode === "after" && pos.column.trim()) {
      parts.push(`AFTER ${quoteIdentFor(driver, pos.column.trim())}`);
    }
  }
  return parts.join(" ");
}

/**
 * MySQL の DEFAULT は `formatDefault` (createTable.ts と同じヒューリスティック) で
 * 整形する。PostgreSQL/SQLite は `describeTable` が返す式をそのまま入力欄の初期値に
 * 使う想定で、未編集なら baseline と文字列一致するので差分なし判定になる —
 * 再クオートすると `'x'::type` のような既存の式表現を壊すため、変更時も逐語で使う。
 */
function formatDefaultForEdit(driver: string, raw: string, type: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (driver === "mysql") return formatDefault(driver, v, type);
  return v;
}

/**
 * MySQL の CHANGE COLUMN に付ける DEFAULT。既定値を編集していないときは、
 * `describeTable` が返す値がクオート無しの生値なので `db/sync.rs::default_clause` と同じ
 * 方針で扱う: EXTRA に DEFAULT_GENERATED があれば式 (現在時刻系以外は `(expr)` で包む)、
 * なければリテラルとして引用する (文字列既定値 `(none)` を式と誤認しない)。
 * 編集したときはフォーム入力のヒューリスティック (`formatDefault`) に従う。
 */
function mysqlDefaultForChange(
  baseline: ExistingColumnBaseline,
  edit: ExistingColumnEdit,
  type: string,
): string | null {
  const v = edit.defaultValue.trim();
  if (!v) return null;
  if (v !== baseline.defaultValue.trim()) return formatDefault("mysql", v, type);
  if (/\bDEFAULT_GENERATED\b/i.test(baseline.extra)) {
    if (CURRENT_TIME_FN_RE.test(v) || (v.startsWith("(") && matchParen(v, 0) === v.length)) return v;
    return `(${v})`;
  }
  return formatDefault("mysql", v, type, { literal: true });
}

/** 既存 1 列ぶんの ADD 以外の変更を判定し、方言別の文へ変換する。 */
function planExistingColumn(
  driver: string,
  tIdent: string,
  baseline: ExistingColumnBaseline,
  edit: ExistingColumnEdit,
  statements: AlterStatement[],
  warnings: AlterWarning[],
): void {
  if (edit.drop) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} DROP COLUMN ${quoteIdentFor(driver, baseline.name)};`,
      kind: "dropColumn",
      destructive: true,
    });
    return;
  }

  const newName = edit.name.trim() || baseline.name;
  const renamed = newName !== baseline.name;
  // 型欄が空欄のときは baseline の型へフォールバックする (MySQL の
  // CHANGE/MODIFY と同じ規則)。フォールバックせず空文字をそのまま使うと
  // PostgreSQL の `ALTER COLUMN ... TYPE ;` のような不正 SQL を生成してしまう。
  const newType = edit.type.trim() || baseline.type.trim();
  const typeChanged = newType !== baseline.type.trim();
  const nullChanged = edit.notNull !== baseline.notNull;
  // 生成列は DEFAULT を持てない (#1893) ので、DEFAULT の編集は無視する。
  const baseGenerated = baseline.generated;
  const hiddenGenerated = driver === "sqlite" && baseGenerated !== undefined;
  const defaultChanged =
    baseGenerated === undefined && edit.defaultValue.trim() !== baseline.defaultValue.trim();
  const facetsChanged = !hiddenGenerated && (typeChanged || nullChanged || defaultChanged);
  const editGenerated = baseGenerated ? (edit.generated ?? baseGenerated) : undefined;
  const exprChanged =
    baseGenerated !== undefined &&
    editGenerated !== undefined &&
    editGenerated.expression.trim() !== baseGenerated.expression.trim();
  const storageChanged =
    baseGenerated !== undefined &&
    editGenerated !== undefined &&
    editGenerated.virtual !== baseGenerated.virtual;
  // 式を取得できていない生成列 (MySQL の EXTRA に印だけある)。再定義すると式を失う。
  const generatedUnknown = baseGenerated === undefined && extraMarksGenerated(baseline.extra);
  // コメント (#1002)。SQLite は非対応なので常に「変更なし」扱い。
  const beforeComment = baseline.comment ?? "";
  const afterComment = supportsComments(driver) ? (edit.comment ?? beforeComment) : beforeComment;
  const commentChanged = afterComment !== beforeComment;

  // 式・STORED/VIRTUAL の変更に対応しないドライバ (#1893)。SQLite は再作成で行うのでここへは来ない。
  if (driver === "postgres" && exprChanged) {
    warnings.push({ code: "generatedExpressionUnsupported", column: baseline.name });
  }
  if (driver !== "sqlite" && storageChanged) {
    warnings.push({ code: "generatedStorageUnsupported", column: baseline.name });
  }
  const mysqlExprChange = driver === "mysql" && exprChanged && !storageChanged;

  if (!renamed && !facetsChanged && !commentChanged && !mysqlExprChange) return;

  const oldIdent = quoteIdentFor(driver, baseline.name);
  const newIdent = quoteIdentFor(driver, newName);

  if (driver === "mysql") {
    if (renamed && !facetsChanged && !commentChanged && !mysqlExprChange) {
      statements.push({
        sql: `ALTER TABLE ${tIdent} RENAME COLUMN ${oldIdent} TO ${newIdent};`,
        kind: "renameColumn",
        destructive: false,
      });
      return;
    }
    // CHANGE COLUMN は rename + 再定義を 1 文でまかなえる。未変更フィールドも
    // baseline (= edit の初期値) 由来のまま含まれるので、MySQL の
    // 「MODIFY/CHANGE は常にフル定義が必要」という制約を自然に満たす。
    // 式を取得できていない生成列は、再定義すると式を失う。止めて理由を知らせる (#1893)。
    if (generatedUnknown) {
      warnings.push({ code: "generatedExpressionUnknown", column: baseline.name });
      return;
    }
    const parts = [newIdent, newType];
    // 生成列は `AS (式) STORED|VIRTUAL` を付け直して式を保つ。NOT NULL より前、DEFAULT は付けない。
    // STORED/VIRTUAL の切り替えは MySQL では行えないので baseline の方を保つ。
    if (baseGenerated && editGenerated) {
      parts.push(
        generatedClause(driver, { expression: editGenerated.expression, virtual: baseGenerated.virtual }),
      );
    }
    if (edit.notNull) parts.push("NOT NULL");
    const def = baseGenerated ? null : mysqlDefaultForChange(baseline, edit, newType);
    if (def !== null) parts.push(`DEFAULT ${def}`);
    // `extra` (auto_increment・on update CURRENT_TIMESTAMP 等) は
    // フォーム編集の対象外なので baseline の値を逐語で保持する — 付けないと
    // CHANGE COLUMN で AUTO_INCREMENT 等が黙って消えてしまう
    // (`db/sync.rs::column_def` と同じ方針)。
    // MySQL 8 の EXTRA に出る `DEFAULT_GENERATED` は情報表示用のマーカーで DDL の
    // 構文ではない (そのまま付けると構文エラー) ので取り除く。
    const extra = baseline.extra
      .replace(/\bDEFAULT_GENERATED\b/gi, "")
      // 生成列の印は DDL の構文ではない。式は上で `AS (...)` として付け直した (#1893)。
      .replace(GENERATED_EXTRA_RE, "")
      .replace(/\s+/g, " ")
      .trim();
    if (extra) parts.push(extra);
    // 列コメントも CHANGE COLUMN の再定義で消えるので、編集後 (未編集なら
    // baseline) の値を付け足して保持する (#1002)。空へ変更したときだけ明示的に
    // `COMMENT ''` を書いて削除する。
    if (afterComment !== "" || commentChanged) {
      parts.push(`COMMENT ${quoteString(driver, afterComment)}`);
    }
    statements.push({
      sql: `ALTER TABLE ${tIdent} CHANGE COLUMN ${oldIdent} ${parts.join(" ")};`,
      kind: renamed ? "renameColumn" : facetsChanged || mysqlExprChange ? "modifyColumn" : "comment",
      destructive: false,
    });
    return;
  }

  // PostgreSQL の列コメントは独立した文なので、他の変更
  // (リネーム含む) の後にリネーム後の列名で付け替える。
  const pushColumnComment = () => {
    const sql = commentChanged
      ? columnCommentSql(driver, tIdent, newName, beforeComment, afterComment)
      : null;
    if (sql) statements.push({ sql, kind: "comment", destructive: false });
  };

  if (driver === "postgres") {
    if (renamed) {
      statements.push({
        sql: `ALTER TABLE ${tIdent} RENAME COLUMN ${oldIdent} TO ${newIdent};`,
        kind: "renameColumn",
        destructive: false,
      });
    }
    if (typeChanged) {
      statements.push({
        sql: `ALTER TABLE ${tIdent} ALTER COLUMN ${newIdent} TYPE ${newType};`,
        kind: "modifyColumn",
        destructive: false,
      });
    }
    if (nullChanged) {
      const clause = edit.notNull ? "SET NOT NULL" : "DROP NOT NULL";
      statements.push({
        sql: `ALTER TABLE ${tIdent} ALTER COLUMN ${newIdent} ${clause};`,
        kind: "modifyColumn",
        destructive: false,
      });
    }
    if (defaultChanged) {
      const def = formatDefaultForEdit(driver, edit.defaultValue, newType);
      const sql =
        def !== null
          ? `ALTER TABLE ${tIdent} ALTER COLUMN ${newIdent} SET DEFAULT ${def};`
          : `ALTER TABLE ${tIdent} ALTER COLUMN ${newIdent} DROP DEFAULT;`;
      statements.push({ sql, kind: "modifyColumn", destructive: false });
    }
    pushColumnComment();
    return;
  }

  // SQLite: rename/add/drop はネイティブ対応 (3.25+ / 3.35+)。型 / NOT NULL / DEFAULT の変更は
  // `buildAlterPlan` が先にテーブル再作成 (`AlterPlan.rebuild`) へ回すので、ここへは来ない。
  if (renamed) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} RENAME COLUMN ${oldIdent} TO ${newIdent};`,
      kind: "renameColumn",
      destructive: false,
    });
  }
  pushColumnComment();
}

/** FK / CHECK の追加・削除文を組み立てる (#1191)。SQLite は再作成で行うのでここへは来ない。 */
function planConstraints(
  driver: string,
  tIdent: string,
  form: AlterTableForm,
  statements: AlterStatement[],
): void {
  const dropFks = (form.droppedForeignKeys ?? []).map((n) => n.trim()).filter((n) => n);
  const dropChecks = (form.droppedChecks ?? []).map((n) => n.trim()).filter((n) => n);
  const addFks = (form.addedForeignKeys ?? []).filter(isCompleteForeignKey);
  const addChecks = (form.addedChecks ?? []).filter(isCompleteCheck);

  for (const n of dropFks) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} ${dropForeignKeyClause(driver, n)};`,
      kind: "dropForeignKey",
      destructive: true,
    });
  }
  for (const n of dropChecks) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} ${dropCheckClause(driver, n)};`,
      kind: "dropCheck",
      destructive: true,
    });
  }
  for (const fk of addFks) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} ADD ${foreignKeyClause(driver, form.database, fk)};`,
      kind: "addForeignKey",
      destructive: false,
    });
  }
  for (const ck of addChecks) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} ADD ${checkClause(driver, ck)};`,
      kind: "addCheck",
      destructive: false,
    });
  }
}

const STATEMENT_ORDER: Record<AlterStatementKind, number> = {
  // SQLite の再作成 (#1888) はモーダルが先頭に差し込む。他の文と混ざって並べ替えられることは無い。
  rebuildTable: -1,
  addColumn: 0,
  renameColumn: 1,
  modifyColumn: 1,
  // コメントは列のリネーム/変更と同じ段 (安定ソートで生成順 = リネームの後を保つ)。
  comment: 1,
  // 制約の削除は列の削除より前 (列に依存する制約が残ると DROP COLUMN が失敗する)。
  dropForeignKey: 1,
  dropCheck: 1,
  // 制約の追加はリネーム/追加後の列名を参照できるよう列変更の後、列削除の前。
  addForeignKey: 2,
  addCheck: 2,
  dropColumn: 3,
  createIndex: 4,
};

/**
 * 適用後の列名が重複するもの (DROP / リネームで空けた名前の再利用は重複ではない)。
 * 空でない新規列名・リネーム後の名前・変更なしの既存列名を数える。PostgreSQL は大小を区別し、
 * MySQL / SQLite は区別しない。重複した名前を (小文字化せず) 返す。
 */
export function duplicateColumnNames(
  driver: string,
  form: Pick<AlterTableForm, "baseline" | "existing" | "added">,
): string[] {
  const norm = (n: string) => (driver === "postgres" ? n : n.toLowerCase());
  const seen = new Set<string>();
  const dups: string[] = [];
  const add = (name: string) => {
    const k = norm(name);
    if (seen.has(k)) {
      if (!dups.some((d) => norm(d) === k)) dups.push(name);
    } else seen.add(k);
  };
  const edits = new Map(form.existing.map((e) => [e.original, e] as const));
  for (const b of form.baseline) {
    const e = edits.get(b.name);
    if (e?.drop) continue;
    add(e ? e.name.trim() || b.name : b.name);
  }
  for (const c of form.added) {
    const n = c.name.trim();
    if (n) add(n);
  }
  return dups;
}

/**
 * リネーム先が、ほかの (DROP しない) 既存列の現在の名前と同じもの。入れ替え (a↔b) や連鎖 (a→b, b→c) は
 * 安全な実行順を作れないので、UI は実行を止める。DROP する列の名前へのリネームは順序で解決できる
 * ので含めない。
 */
export function renameCollisions(
  driver: string,
  form: Pick<AlterTableForm, "baseline" | "existing">,
): string[] {
  const norm = (n: string) => (driver === "postgres" ? n : n.toLowerCase());
  const edits = new Map(form.existing.map((e) => [e.original, e] as const));
  const keptNames = new Set(form.baseline.filter((b) => !edits.get(b.name)?.drop).map((b) => norm(b.name)));
  const out: string[] = [];
  for (const b of form.baseline) {
    const e = edits.get(b.name);
    if (!e || e.drop) continue;
    const target = e.name.trim() || b.name;
    if (target !== b.name && keptNames.has(norm(target)) && norm(target) !== norm(b.name)) {
      out.push(target);
    }
  }
  return out;
}

/** `CREATE INDEX` 文 (不備のある行は捨てる。UI は `indexRowProblems` で行ごとにエラーを出し、不備が残る間は
 * 実行を止めるので、黙って作られないまま実行されることはない, #1532)。 */
function indexStatements(driver: string, tIdent: string, indexes: IndexDef[]): AlterStatement[] {
  const out: AlterStatement[] = [];
  for (const idx of indexes) {
    if (indexRowProblems(idx)) continue;
    const name = idx.name.trim();
    const cols = idx.columns.map((c) => c.trim()).filter((c) => c.length > 0);
    const colList = cols.map((c) => quoteIdentFor(driver, c)).join(", ");
    const keyword = idx.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
    out.push({
      sql: `${keyword} ${quoteIdentFor(driver, name)} ON ${tIdent} (${colList});`,
      kind: "createIndex",
      destructive: false,
    });
  }
  return out;
}

/**
 * SQLite でテーブル再作成が要る編集か判定し、要るならバックエンドへ渡す入力を組み立てる (#1888)。
 * 要るのは、削除しない既存列の型 / NOT NULL / DEFAULT の変更、または FK / CHECK の追加・削除。
 * 要らなければ (リネーム・列の追加・削除だけなど) `null` で、従来どおりネイティブの `ALTER` で行う。
 * 再作成するときは列のリネーム・追加・削除もまとめて入力に含める。
 */
export function buildSqliteRebuildEdit(form: AlterTableForm): SqliteRebuildEdit | null {
  const baselineByName = new Map(form.baseline.map((b) => [b.name, b] as const));
  // SQLite の生成列は `table_info` に出ない隠れた列 (#1893)。`columns` ではなく専用のリストで渡す。
  const isHidden = (b: ExistingColumnBaseline) => b.generated !== undefined;
  const facetsChanged = form.existing.some((e) => {
    const b = baselineByName.get(e.original);
    if (!b || e.drop || isHidden(b)) return false;
    return (
      (e.type.trim() || b.type.trim()) !== b.type.trim() ||
      e.notNull !== b.notNull ||
      e.defaultValue.trim() !== b.defaultValue.trim()
    );
  });
  const addFks = (form.addedForeignKeys ?? []).filter(isCompleteForeignKey);
  const addChecks = (form.addedChecks ?? []).filter(isCompleteCheck);
  const dropFkNames = new Set((form.droppedForeignKeys ?? []).map((n) => n.trim()).filter((n) => n));
  const dropFks = (form.existingForeignKeys ?? []).filter((f) => f.name !== null && dropFkNames.has(f.name));
  const dropChecks = (form.droppedCheckDefinitions ?? []).filter((d) => d.trim());
  const edits = new Map(form.existing.map((e) => [e.original, e] as const));
  const newGenerated = form.added.flatMap((c) => {
    const g = activeGenerated(c);
    return g && c.name.trim() ? [{ col: c, spec: g }] : [];
  });
  const changedGenerated = form.baseline.flatMap((b) => {
    const e = edits.get(b.name);
    const g = e?.generated;
    if (!b.generated || !e || e.drop || !g) return [];
    const changed =
      g.expression.trim() !== b.generated.expression.trim() || g.virtual !== b.generated.virtual;
    return changed ? [{ column: b.name, spec: g }] : [];
  });
  const droppedGenerated = form.baseline
    .filter((b) => isHidden(b) && edits.get(b.name)?.drop)
    .map((b) => b.name);
  // SQLite は STORED 列を `ADD COLUMN` で足せず、式の変更も列の定義を書き換える。
  const generatedNeedsRebuild = newGenerated.some((g) => !g.spec.virtual) || changedGenerated.length > 0;
  if (
    !facetsChanged &&
    !generatedNeedsRebuild &&
    addFks.length === 0 &&
    addChecks.length === 0 &&
    dropFks.length === 0 &&
    dropChecks.length === 0
  ) {
    return null;
  }
  const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
  const trimmedList = (cols: string[]) => cols.map((c) => c.trim()).filter((c) => c);
  return {
    columns: form.baseline
      .filter((b) => !isHidden(b))
      .map((b) => {
        const e = edits.get(b.name);
        if (!e) {
          return {
            original: b.name,
            name: b.name,
            data_type: b.type,
            not_null: b.notNull,
            default: orNull(b.defaultValue),
            drop: false,
          };
        }
        return {
          original: b.name,
          name: e.name.trim() || b.name,
          data_type: e.type.trim() || b.type.trim(),
          not_null: e.notNull,
          // 既存列の DEFAULT は式そのものを逐語で使う (`describeTable` の表記を壊さない)。
          default: formatDefaultForEdit("sqlite", e.defaultValue, e.type.trim() || b.type.trim()),
          drop: e.drop,
        };
      }),
    added_columns: form.added
      .filter((c) => c.name.trim() && !activeGenerated(c))
      .map((c) => {
        const type = c.type.trim() || "TEXT";
        return {
          name: c.name.trim(),
          data_type: type,
          not_null: c.notNull,
          default: formatDefault("sqlite", c.defaultValue, type),
        };
      }),
    added_foreign_keys: addFks.map((fk) => ({
      name: orNull(fk.name),
      columns: trimmedList(fk.columns),
      ref_table: fk.refTable.trim(),
      ref_columns: trimmedList(fk.refColumns),
      on_delete: orNull(fk.onDelete),
      on_update: orNull(fk.onUpdate),
    })),
    dropped_foreign_keys: dropFks.map((f) => ({ columns: f.columns, ref_table: f.refTable })),
    added_checks: addChecks.map((ck) => ({ name: orNull(ck.name), expression: ck.expression.trim() })),
    dropped_checks: dropChecks,
    added_generated: newGenerated.map(({ col, spec }) => ({
      name: col.name.trim(),
      data_type: col.type.trim(),
      not_null: col.notNull,
      expression: spec.expression.trim(),
      is_virtual: spec.virtual,
    })),
    changed_generated: changedGenerated.map(({ column, spec }) => ({
      column,
      expression: spec.expression.trim(),
      is_virtual: spec.virtual,
    })),
    dropped_generated: droppedGenerated,
  };
}

/**
 * フォーム入力から `ALTER TABLE` / `CREATE INDEX` 文の配列を組み立てる。順序は
 * ADD → RENAME/MODIFY → DROP → CREATE INDEX
 * (`db/sync.rs` の `SyncKind::order()` と同じ「作ってから壊す」安全な適用順)。
 * 列名が未入力の追加列は無視する。不備のあるインデックス行 ({@link indexRowProblems}) も
 * 文にしないが、UI 側が実行を止める。SQLite でテーブル再作成が要る編集は `rebuild` に畳む
 * ({@link buildSqliteRebuildEdit})。
 */
export function buildAlterPlan(driver: string, form: AlterTableForm): AlterPlan {
  const tIdent = qualifiedName(driver, form.database, form.table);
  const statements: AlterStatement[] = [];
  const warnings: AlterWarning[] = [];
  // SQLite の型 / NOT NULL / DEFAULT 変更・FK / CHECK の変更はテーブル再作成で行う (#1888)。
  // リネーム・列の追加・削除もその再作成に含まれるので、ここでは ALTER を出さない。
  if (driver === "sqlite") {
    const rebuild = buildSqliteRebuildEdit(form);
    if (rebuild) {
      return { statements: indexStatements(driver, tIdent, form.indexes), warnings, rebuild };
    }
  }
  // 同じ ALTER の中で DROP / リネームして空けた列名を、新規列が再利用するときは、
  // ADD を先に出すと「列が重複」で失敗する。そのような ADD だけ、名前を空ける文の後ろへ送る。
  // 「DROP する別の列の名前へのリネーム」(a→b かつ b を DROP) も、DROP の後ろへ回す。
  const lowerOf = (n: string) => n.toLowerCase();
  const droppedNames = new Set<string>();
  for (const e of form.existing) {
    const b = form.baseline.find((x) => x.name === e.original);
    if (b && e.drop) droppedNames.add(lowerOf(b.name));
  }
  const lateOrder = new Map<AlterStatement, number>();
  // 名前を空ける文の段 (列名 → order)。DROP は 3、リネームは 1 (DROP 先の名前へなら 3.25)。
  const freedAt = new Map<string, number>();
  for (const name of droppedNames) freedAt.set(name, STATEMENT_ORDER.dropColumn);

  const baselineByName = new Map(form.baseline.map((b) => [b.name, b] as const));
  for (const edit of form.existing) {
    const baseline = baselineByName.get(edit.original);
    if (!baseline) continue;
    const before = statements.length;
    planExistingColumn(driver, tIdent, baseline, edit, statements, warnings);
    if (edit.drop) continue;
    const target = edit.name.trim() || baseline.name;
    if (target === baseline.name) continue;
    const renameOrder = droppedNames.has(lowerOf(target))
      ? STATEMENT_ORDER.dropColumn + 0.25
      : STATEMENT_ORDER.renameColumn;
    if (renameOrder !== STATEMENT_ORDER.renameColumn) {
      for (const st of statements.slice(before)) lateOrder.set(st, renameOrder);
    }
    freedAt.set(lowerOf(baseline.name), renameOrder);
  }

  for (const col of form.added) {
    const name = col.name.trim();
    if (!name) continue;
    const stmt: AlterStatement = {
      sql: `ALTER TABLE ${tIdent} ADD COLUMN ${newColumnLine(driver, col)};`,
      kind: "addColumn",
      destructive: false,
    };
    statements.push(stmt);
    const freed = freedAt.get(lowerOf(name));
    if (freed !== undefined) lateOrder.set(stmt, freed + 0.5);
  }
  // 後ろへ送った ADD を参照しうる FK / CHECK は、DROP より後ろの ADD の後に出す。
  const maxLate = Math.max(0, ...lateOrder.values());

  if (form.tableComment) {
    const sql = tableCommentSql(driver, tIdent, form.tableComment.before, form.tableComment.after);
    if (sql) statements.push({ sql, kind: "comment", destructive: false });
  }

  planConstraints(driver, tIdent, form, statements);

  const orderOf = (st: AlterStatement) => {
    const late = lateOrder.get(st);
    if (late !== undefined) return late;
    // DROP の後ろへ送った ADD がある場合、制約の追加はさらにその後ろ (新しい列を参照できるように)。
    if ((st.kind === "addForeignKey" || st.kind === "addCheck") && maxLate > STATEMENT_ORDER.dropColumn) {
      return maxLate + 0.25;
    }
    return STATEMENT_ORDER[st.kind];
  };
  statements.sort((a, b) => orderOf(a) - orderOf(b));

  statements.push(...indexStatements(driver, tIdent, form.indexes));

  return { statements, warnings, rebuild: null };
}
