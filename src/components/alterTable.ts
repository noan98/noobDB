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
// COMMENT '...'`)、PostgreSQL / DuckDB は `COMMENT ON TABLE|COLUMN ... IS ...`、
// MSSQL は拡張プロパティ `MS_Description` (`sp_add/update/dropextendedproperty`)。
// SQLite はコメント機能を持たないので生成しない (UI 側で入力欄を無効化する)。
//
// 生成した文言 (未対応の変更の通知など) は理由コードのみを返し、実際の文字列化は
// 呼び出し側 (i18n) に任せる — このモジュールは表示に依存しない。

import { quoteIdentFor } from "./sqlDialect";
import { formatDefault } from "./createTable";
import { quoteString } from "./cellEdit";

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

export interface AlterTableForm {
  database?: string | null;
  table: string;
  baseline: ExistingColumnBaseline[];
  existing: ExistingColumnEdit[];
  added: NewColumn[];
  indexes: IndexDef[];
  /** テーブルコメントの編集 (#1002)。`before` は DB の現状、`after` は入力値。 */
  tableComment?: { before: string; after: string };
}

export type AlterStatementKind =
  | "addColumn"
  | "renameColumn"
  | "modifyColumn"
  | "dropColumn"
  | "createIndex"
  | "comment";

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
  column: string;
  reason: "sqliteInPlaceModify";
}

export interface AlterPlan {
  statements: AlterStatement[];
  unsupported: UnsupportedChange[];
}

/**
 * テーブル / 列コメントの編集に対応するドライバか (#1002)。SQLite はコメント機能を
 * 持たない (DDL 中の `--` コメントは保持されるが、カタログとして読み書きできない)
 * ため非対応で、UI はコメント欄を無効化して理由を表示する。
 */
export function supportsComments(driver: string): boolean {
  return driver === "mysql" || driver === "postgres" || driver === "duckdb" || driver === "mssql";
}

/** MSSQL の拡張プロパティ `MS_Description` を付け替える `EXEC` 文 (#1002)。
 *  既存値の有無で add / update / drop を選ぶ。スキーマは introspection と同じ `dbo`。 */
function mssqlDescriptionSql(table: string, column: string | null, before: string, after: string): string | null {
  const hadBefore = before.trim() !== "";
  const hasAfter = after.trim() !== "";
  if (!hadBefore && !hasAfter) return null;
  const proc = !hasAfter
    ? "sp_dropextendedproperty"
    : hadBefore
      ? "sp_updateextendedproperty"
      : "sp_addextendedproperty";
  const args = [`@name = N'MS_Description'`];
  if (hasAfter) args.push(`@value = ${quoteString("mssql", after)}`);
  args.push(
    `@level0type = N'SCHEMA'`,
    `@level0name = N'dbo'`,
    `@level1type = N'TABLE'`,
    `@level1name = ${quoteString("mssql", table)}`,
  );
  if (column !== null) {
    args.push(`@level2type = N'COLUMN'`, `@level2name = ${quoteString("mssql", column)}`);
  }
  return `EXEC ${proc} ${args.join(", ")};`;
}

/** `COMMENT ON ... IS ...` の右辺 (空文字はコメント削除 = `NULL`)。 */
function commentOnValue(driver: string, value: string): string {
  return value.trim() === "" ? "NULL" : quoteString(driver, value);
}

/**
 * テーブルコメントの変更文 (#1002)。変更が無い / 非対応ドライバなら null。
 * `table` はクオート前のテーブル名 (MSSQL の拡張プロパティ用)。
 */
function tableCommentSql(
  driver: string,
  tIdent: string,
  table: string,
  before: string,
  after: string,
): string | null {
  if (!supportsComments(driver) || before === after) return null;
  if (driver === "mysql") return `ALTER TABLE ${tIdent} COMMENT = ${quoteString(driver, after)};`;
  if (driver === "mssql") return mssqlDescriptionSql(table, null, before, after);
  return `COMMENT ON TABLE ${tIdent} IS ${commentOnValue(driver, after)};`;
}

/**
 * 列コメントの変更文 (PostgreSQL / DuckDB / MSSQL、#1002)。MySQL は列の再定義に
 * 含めるのでここでは扱わない。`column` はリネーム後の列名。
 */
function columnCommentSql(
  driver: string,
  tIdent: string,
  table: string,
  column: string,
  before: string,
  after: string,
): string | null {
  if (before === after) return null;
  if (driver === "mssql") return mssqlDescriptionSql(table, column, before, after);
  if (driver === "postgres" || driver === "duckdb") {
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
  const parts = [quoteIdentFor(driver, col.name), col.type.trim() || "TEXT"];
  if (col.notNull) parts.push("NOT NULL");
  const def = formatDefault(driver, col.defaultValue);
  if (def !== null) parts.push(`DEFAULT ${def}`);
  return parts.join(" ");
}

/**
 * MySQL の DEFAULT は `formatDefault` (createTable.ts と同じヒューリスティック) で
 * 整形する。PostgreSQL/SQLite は `describeTable` が返す式をそのまま入力欄の初期値に
 * 使う想定で、未編集なら baseline と文字列一致するので差分なし判定になる —
 * 再クオートすると `'x'::type` のような既存の式表現を壊すため、変更時も逐語で使う。
 */
function formatDefaultForEdit(driver: string, raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (driver === "mysql") return formatDefault(driver, v);
  return v;
}

/** 既存 1 列ぶんの ADD 以外の変更を判定し、方言別の文へ変換する。 */
function planExistingColumn(
  driver: string,
  tIdent: string,
  table: string,
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
    const def = formatDefaultForEdit(driver, edit.defaultValue);
    if (def !== null) parts.push(`DEFAULT ${def}`);
    // `extra` (auto_increment・on update CURRENT_TIMESTAMP 等) は
    // フォーム編集の対象外なので baseline の値を逐語で保持する — 付けないと
    // CHANGE COLUMN で AUTO_INCREMENT 等が黙って消えてしまう
    // (`db/sync.rs::column_def` と同じ方針)。
    if (baseline.extra.trim()) parts.push(baseline.extra.trim());
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

  // PostgreSQL / DuckDB / MSSQL の列コメントは独立した文なので、他の変更
  // (リネーム含む) の後にリネーム後の列名で付け替える。
  const pushColumnComment = () => {
    const sql = commentChanged
      ? columnCommentSql(driver, tIdent, table, newName, beforeComment, afterComment)
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
      const def = formatDefaultForEdit(driver, edit.defaultValue);
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

const STATEMENT_ORDER: Record<AlterStatementKind, number> = {
  addColumn: 0,
  renameColumn: 1,
  modifyColumn: 1,
  // コメントは列のリネーム/変更と同じ段 (安定ソートで生成順 = リネームの後を保つ)。
  comment: 1,
  dropColumn: 2,
  createIndex: 3,
};

/**
 * フォーム入力から `ALTER TABLE` / `CREATE INDEX` 文の配列を組み立てる。順序は
 * ADD → RENAME/MODIFY → DROP → CREATE INDEX
 * (`db/sync.rs` の `SyncKind::order()` と同じ「作ってから壊す」安全な適用順)。
 * 列名 / 索引名が未入力の行は無視する。
 */
export function buildAlterPlan(driver: string, form: AlterTableForm): AlterPlan {
  const tIdent = qualifiedName(driver, form.database, form.table);
  const statements: AlterStatement[] = [];
  const unsupported: UnsupportedChange[] = [];

  for (const col of form.added) {
    if (!col.name.trim()) continue;
    statements.push({
      sql: `ALTER TABLE ${tIdent} ADD COLUMN ${newColumnLine(driver, col)};`,
      kind: "addColumn",
      destructive: false,
    });
  }

  const baselineByName = new Map(form.baseline.map((b) => [b.name, b] as const));
  for (const edit of form.existing) {
    const baseline = baselineByName.get(edit.original);
    if (!baseline) continue;
    planExistingColumn(driver, tIdent, form.table, baseline, edit, statements, unsupported);
  }

  if (form.tableComment) {
    const sql = tableCommentSql(
      driver,
      tIdent,
      form.table,
      form.tableComment.before,
      form.tableComment.after,
    );
    if (sql) statements.push({ sql, kind: "comment", destructive: false });
  }

  statements.sort((a, b) => STATEMENT_ORDER[a.kind] - STATEMENT_ORDER[b.kind]);

  for (const idx of form.indexes) {
    const name = idx.name.trim();
    const cols = idx.columns.map((c) => c.trim()).filter((c) => c.length > 0);
    if (!name || cols.length === 0) continue;
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
