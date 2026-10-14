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
// 保持する。それ以外の付随属性 (文字セット/照合順序・生成列式など。`describeTable`
// がそもそも取得しない) は保持できない — フル対応ではなく最小対応であることに注意。
//
// テーブル / 列コメントの編集 (#1002) もここで方言別に組み立てる:
// MySQL は `ALTER TABLE ... COMMENT = '...'` と列の再定義 (`CHANGE COLUMN ...
// COMMENT '...'`)、PostgreSQL は `COMMENT ON TABLE|COLUMN ... IS ...`。
// SQLite はコメント機能を持たないので生成しない (UI 側で入力欄を無効化する)。
//
// 生成した文言 (未対応の変更の通知など) は理由コードのみを返し、実際の文字列化は
// 呼び出し側 (i18n) に任せる — このモジュールは表示に依存しない。

import { quoteIdentFor } from "./sqlDialect";
import { CURRENT_TIME_FN_RE, formatDefault, matchParen } from "./createTable";
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
  | "dropCheck";

export interface AlterStatement {
  sql: string;
  kind: AlterStatementKind;
  /** true は `DROP COLUMN` — 呼び出し側の危険操作確認のゲートに使う。 */
  destructive: boolean;
}

/**
 * 方言が対応しない変更 (SQLite の型/NOT NULL/DEFAULT インプレース変更) の通知。
 * 文言はプレゼンテーション層 (i18n) に任せるため理由コードのみを返す。
 */
export interface UnsupportedChange {
  /** 対象の列名 (制約の場合は制約名 / 式の要約)。 */
  column: string;
  reason: "sqliteInPlaceModify" | "sqliteConstraintAlter";
}

export interface AlterPlan {
  statements: AlterStatement[];
  unsupported: UnsupportedChange[];
}

/**
 * 既存テーブルへの FK / CHECK の追加・削除を ALTER で行えるドライバか (#1191)。
 * SQLite は `ALTER TABLE` で制約を足せず、テーブル再作成 (rename→create→copy→drop)
 * が要る。データ喪失リスクが高いため本機能では対象外とし、UI は入力欄を無効化して
 * 理由を表示する (新規作成時の指定は `createTable.ts` で SQLite も対応)。
 */
export function supportsConstraintAlter(driver: string): boolean {
  return driver === "mysql" || driver === "postgres";
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
  if (col.notNull) parts.push("NOT NULL");
  const def = formatDefault(driver, col.defaultValue, type);
  if (def !== null) parts.push(`DEFAULT ${def}`);
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
  unsupported: UnsupportedChange[],
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
  const defaultChanged = edit.defaultValue.trim() !== baseline.defaultValue.trim();
  const facetsChanged = typeChanged || nullChanged || defaultChanged;
  // コメント (#1002)。SQLite は非対応なので常に「変更なし」扱い。
  const beforeComment = baseline.comment ?? "";
  const afterComment = supportsComments(driver) ? (edit.comment ?? beforeComment) : beforeComment;
  const commentChanged = afterComment !== beforeComment;

  if (!renamed && !facetsChanged && !commentChanged) return;

  const oldIdent = quoteIdentFor(driver, baseline.name);
  const newIdent = quoteIdentFor(driver, newName);

  if (driver === "mysql") {
    if (renamed && !facetsChanged && !commentChanged) {
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
    const parts = [newIdent, newType];
    if (edit.notNull) parts.push("NOT NULL");
    const def = mysqlDefaultForChange(baseline, edit, newType);
    if (def !== null) parts.push(`DEFAULT ${def}`);
    // `extra` (auto_increment・on update CURRENT_TIMESTAMP 等) は
    // フォーム編集の対象外なので baseline の値を逐語で保持する — 付けないと
    // CHANGE COLUMN で AUTO_INCREMENT 等が黙って消えてしまう
    // (`db/sync.rs::column_def` と同じ方針)。
    // MySQL 8 の EXTRA に出る `DEFAULT_GENERATED` は情報表示用のマーカーで DDL の
    // 構文ではない (そのまま付けると構文エラー) ので取り除く。
    const extra = baseline.extra
      .replace(/\bDEFAULT_GENERATED\b/gi, "")
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
      kind: renamed ? "renameColumn" : facetsChanged ? "modifyColumn" : "comment",
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

  // SQLite: rename/add/drop はネイティブ対応 (3.25+ / 3.35+) だが、型/NOT NULL/
  // DEFAULT のインプレース変更はできない (テーブル再作成が必要)。
  if (renamed) {
    statements.push({
      sql: `ALTER TABLE ${tIdent} RENAME COLUMN ${oldIdent} TO ${newIdent};`,
      kind: "renameColumn",
      destructive: false,
    });
  }
  if (typeChanged || nullChanged || defaultChanged) {
    unsupported.push({ column: baseline.name, reason: "sqliteInPlaceModify" });
  }
  pushColumnComment();
}

/** FK / CHECK の追加・削除文を組み立てる (#1191)。SQLite は文を出さず unsupported へ。 */
function planConstraints(
  driver: string,
  tIdent: string,
  form: AlterTableForm,
  statements: AlterStatement[],
  unsupported: UnsupportedChange[],
): void {
  const dropFks = (form.droppedForeignKeys ?? []).map((n) => n.trim()).filter((n) => n);
  const dropChecks = (form.droppedChecks ?? []).map((n) => n.trim()).filter((n) => n);
  const addFks = (form.addedForeignKeys ?? []).filter(isCompleteForeignKey);
  const addChecks = (form.addedChecks ?? []).filter(isCompleteCheck);

  if (!supportsConstraintAlter(driver)) {
    for (const n of dropFks) unsupported.push({ column: n, reason: "sqliteConstraintAlter" });
    for (const n of dropChecks) unsupported.push({ column: n, reason: "sqliteConstraintAlter" });
    for (const fk of addFks) {
      unsupported.push({
        column: fk.name.trim() || fk.columns.join(", "),
        reason: "sqliteConstraintAlter",
      });
    }
    for (const ck of addChecks) {
      unsupported.push({
        column: ck.name.trim() || ck.expression.trim(),
        reason: "sqliteConstraintAlter",
      });
    }
    return;
  }

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

/**
 * フォーム入力から `ALTER TABLE` / `CREATE INDEX` 文の配列を組み立てる。順序は
 * ADD → RENAME/MODIFY → DROP → CREATE INDEX
 * (`db/sync.rs` の `SyncKind::order()` と同じ「作ってから壊す」安全な適用順)。
 * 列名が未入力の追加列は無視する。不備のあるインデックス行 ({@link indexRowProblems}) も
 * 文にしないが、UI 側が実行を止める。
 */
export function buildAlterPlan(driver: string, form: AlterTableForm): AlterPlan {
  const tIdent = qualifiedName(driver, form.database, form.table);
  const statements: AlterStatement[] = [];
  const unsupported: UnsupportedChange[] = [];

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
    planExistingColumn(driver, tIdent, baseline, edit, statements, unsupported);
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

  planConstraints(driver, tIdent, form, statements, unsupported);

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

  for (const idx of form.indexes) {
    // 不備のある行はここで捨てる。UI は `indexRowProblems` で行ごとにエラーを出し、
    // 不備が残る間は実行を止めるので、黙って作られないまま実行されることはない (#1532)。
    if (indexRowProblems(idx)) continue;
    const name = idx.name.trim();
    const cols = idx.columns.map((c) => c.trim()).filter((c) => c.length > 0);
    const colList = cols.map((c) => quoteIdentFor(driver, c)).join(", ");
    const keyword = idx.unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
    statements.push({
      sql: `${keyword} ${quoteIdentFor(driver, name)} ON ${tIdent} (${colList});`,
      kind: "createIndex",
      destructive: false,
    });
  }

  return { statements, unsupported };
}
