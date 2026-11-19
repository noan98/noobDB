// 破壊的操作 (DROP TABLE / TRUNCATE / WHERE なし DELETE) の前に作る「退避コピー」(#2448) の純ロジック。
//
// フライトレコーダの Undo は INSERT / UPDATE / DELETE の行だけで、DDL (DROP / TRUNCATE) と行数上限を超える
// 文は戻せない。確認ダイアログから退避テーブル `<table>_bak_<YYYYMMDDHHmm>` を作り、成功したときだけ本操作に進む。
//
// 退避の文は複製 (`tableClone.ts`、#1398) の組み立てをそのまま使う (`backup: true` で退避先の外部キーを外す)。
//   - MySQL: `CREATE TABLE bak LIKE t` → `INSERT INTO bak (列…) SELECT 列… FROM t`。DDL が暗黙コミットするので
//     「退避 → 本操作」は非原子。LIKE は FK を写さない。
//   - PostgreSQL: `CREATE TABLE bak (LIKE t INCLUDING ALL)` → `INSERT ... SELECT` (serial は専用シーケンス)。
//   - SQLite: sqlite_master の DDL を書き換えて `CREATE` → `INSERT ... SELECT`。
// 生成列は列リストから除く (`insertableColumns`)。このモジュールは文を組み立てるだけで実行しない。

import { maskLiterals } from "./dangerousSql";
import { qualifiedTableName } from "./components/sqlDialect";
import {
  buildCloneStatements,
  buildCopyRowsSql,
  fitIdent,
  type PgColumnFlags,
} from "./tableClone";

/** 退避の対象になる破壊的操作。 */
export type BackupKind = "drop" | "truncate" | "deleteNoWhere";

/** 退避の既定。本番接続ではオン、それ以外はオフ (オプトイン)。 */
export function backupDefaultEnabled(isProduction: boolean): boolean {
  return isProduction;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYYMMDDHHmm` (ローカル時刻、分まで)。 */
export function backupTimestamp(now: Date): string {
  return `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * 退避テーブル名 `<table>_bak_<YYYYMMDDHHmm>`。識別子の上限 (MySQL 64 文字 / PostgreSQL 63 バイト) に、
 * 元の名前の末尾側を文字境界で切って収める (接尾辞のタイムスタンプは必ず残す)。同じ分に既存の名前と
 * 衝突したら `_2`, `_3` ... を付ける (大小無視)。
 */
export function backupTableName(
  driver: string,
  table: string,
  now: Date,
  existingTables: readonly string[] = [],
): string {
  const used = new Set(existingTables.map((t) => t.toLowerCase()));
  const base = `_bak_${backupTimestamp(now)}`;
  let candidate = fitIdent(driver, table, base);
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = fitIdent(driver, table, `${base}_${n}`);
  return candidate;
}

export interface BackupPlanInput {
  driver: string;
  /** MySQL = データベース / PostgreSQL = スキーマ。SQLite は `main` など。 */
  database: string | null;
  table: string;
  kind: BackupKind;
  now: Date;
  /** 既存のテーブル名 (退避先の名前の衝突回避)。 */
  existingTables?: readonly string[];
  /** `get_object_definition(kind="table")` の DDL。 */
  ddl: string;
  /** INSERT ... SELECT の列 (`insertableColumns`)。取れなければ null = `SELECT *`。 */
  columns: string[] | null;
  /** PostgreSQL: 列の種別 (serial 専用シーケンスの作成に使う)。 */
  pgColumns?: PgColumnFlags | null;
}

export interface BackupPlan {
  backupName: string;
  /** 実行順の文 (末尾に `;` なし)。空ならテーブルとして退避できない (ビューなど) / 組み立て失敗。 */
  statements: string[];
  /** 本操作のあとに戻すための SQL (`;` 付き、複数文は空行区切り)。 */
  restoreSql: string;
  errors: string[];
}

/** 復元用 SQL。DROP は退避テーブルを元の名前へ `RENAME`、TRUNCATE / DELETE は `INSERT ... SELECT` で行を戻す。 */
export function buildRestoreSql(
  driver: string,
  database: string | null,
  table: string,
  backupName: string,
  kind: BackupKind,
  columns: readonly string[] | null,
): string {
  const bak = qualifiedTableName(driver, database, backupName);
  const orig = qualifiedTableName(driver, database, table);
  if (kind === "drop") {
    // 新しい名前は MySQL だけ DB 修飾できる (PostgreSQL / SQLite は同じスキーマに限られ、修飾すると構文エラー)。
    const newName = driver === "mysql" ? orig : qualifiedTableName(driver, null, table);
    return `ALTER TABLE ${bak} RENAME TO ${newName};`;
  }
  return `${buildCopyRowsSql(driver, columns, orig, bak)};`;
}

/** 退避の文と復元 SQL を組み立てる。 */
export function buildBackupPlan(i: BackupPlanInput): BackupPlan {
  const backupName = backupTableName(i.driver, i.table, i.now, i.existingTables);
  const clone = buildCloneStatements({
    driver: i.driver,
    database: i.database,
    sourceTable: i.table,
    newTable: backupName,
    ddl: i.ddl,
    includeData: true,
    columns: i.columns,
    pgColumns: i.pgColumns ?? null,
    pgForeignKeys: null,
    existingNames: [...(i.existingTables ?? [])],
    backup: true,
  });
  // PostgreSQL: 行レベルセキュリティ (FORCE ROW LEVEL SECURITY など) が効いていると、INSERT ... SELECT は
  // 見える行だけをコピーして成功し、DROP / TRUNCATE は全行を消してしまう。退避のトランザクション内だけ
  // row_security を切る (RLS で絞られる場合は「query would be affected by row-level security policy」で
  // 退避が失敗し、本操作は実行されない)。
  const statements =
    i.driver === "postgres" && clone.statements.length > 0
      ? ["SET LOCAL row_security = off", ...clone.statements]
      : clone.statements;
  return {
    backupName,
    statements,
    restoreSql: buildRestoreSql(i.driver, i.database, i.table, backupName, i.kind, i.columns),
    errors: clone.errors,
  };
}

/** エディタの文から、退避できる単一テーブルの破壊的操作を読み取った結果。 */
export interface BackupTarget {
  kind: BackupKind;
  /** データベース (MySQL) / スキーマ (PostgreSQL) / `main` 等 (SQLite)。文に書かれていなければ null。 */
  database: string | null;
  /** テーブル名。クオートを外して `""` / ` `` ` のエスケープを戻した実体。PostgreSQL の引用符なしは小文字に畳んである。 */
  table: string;
  /** `DROP TABLE IF EXISTS` か。表が実在しなくてもエラーにならない文なので、退避の対象が無いことを許す。 */
  ifExists: boolean;
}

const IDENT = '(?:[\\w$]+|"\\s*"|`\\s*`)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;
const DROP_RE = new RegExp(
  `^drop\\s+table\\s+(?<ie>if\\s+exists\\s+)?(?<name>${QUALIFIED})(?:\\s+(?:cascade|restrict))?$`,
  "di",
);
const TRUNCATE_RE = new RegExp(`^truncate(?:\\s+table)?\\s+(?<name>${QUALIFIED})$`, "di");
const DELETE_RE = new RegExp(`^delete\\s+from\\s+(?<name>${QUALIFIED})$`, "di");

/**
 * `a.b` / `"a"."b"` / `` `a`.`b` `` の生の文字列を、クオートを外した部品の配列にする。
 * 引用符なしの PostgreSQL 識別子は小文字に畳む (`DROP TABLE Users` は `users`)。`""` / ` `` ` のエスケープは戻す。
 * MySQL の `"..."` は文字列 (識別子ではない) なので解釈しない。解釈できなければ null。
 */
export function parseQualifiedName(raw: string, driver?: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const n = raw.length;
  const ws = () => {
    while (i < n && /\s/.test(raw[i])) i++;
  };
  for (;;) {
    ws();
    const c = raw[i];
    if (c === '"' || c === "`") {
      if (c === '"' && driver === "mysql") return null;
      if (c === "`" && driver === "postgres") return null;
      let out = "";
      i++;
      for (;;) {
        if (i >= n) return null;
        if (raw[i] === c) {
          if (raw[i + 1] === c) {
            out += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += raw[i++];
      }
      if (out.length === 0) return null;
      parts.push(out);
    } else {
      const m = /^[\w$]+/.exec(raw.slice(i));
      if (!m) return null;
      i += m[0].length;
      parts.push(driver === "postgres" ? m[0].toLowerCase() : m[0]);
    }
    ws();
    if (i >= n) break;
    if (raw[i] !== ".") return null;
    i++;
  }
  return parts.length >= 1 && parts.length <= 2 ? parts : null;
}

/**
 * 確認ダイアログが出た文が「退避できる単一テーブルの破壊的操作」か。次の形だけを対象にする
 * (複数文・別名・JOIN / USING / RETURNING / LIMIT 付きの DELETE・`TRUNCATE ... CASCADE`・複数テーブルの
 * DROP は退避だけでは戻しきれないので出さない)。
 *   - `DROP TABLE [IF EXISTS] t [CASCADE | RESTRICT]`
 *   - `TRUNCATE [TABLE] t`
 *   - `DELETE FROM t` (WHERE なし)
 * PostgreSQL の `ONLY` 付き (`DELETE FROM ONLY t` / `TRUNCATE ONLY t`) は対象外: 継承の子表を除く操作だが、退避の
 * `SELECT ... FROM t` は子表の行まで含み、復元で親に重複して入るため。
 * テーブル名は、リテラル・コメントをマスクした文で構造を確かめたうえで、**元の文の同じ位置**から字句として読む
 * (`analyzeDangerousSql` の対象名はクオートの有無を失うので使わない)。パーサではなく、迷ったら null (= 出さない)。
 */
export function backupTargetFor(sql: string, driver?: string): BackupTarget | null {
  const masked = maskLiterals(sql, driver);
  const lead = masked.length - masked.replace(/^[\s\u0085\uFEFF]+/, "").length;
  const end = masked.replace(/[\s;\u0085\uFEFF]+$/, "").length;
  if (end <= lead) return null;
  const body = masked.slice(lead, end);
  let kind: BackupKind | null = null;
  let m: RegExpExecArray | null = null;
  for (const [k, re] of [
    ["drop", DROP_RE],
    ["truncate", TRUNCATE_RE],
    ["deleteNoWhere", DELETE_RE],
  ] as const) {
    m = re.exec(body);
    if (m) {
      kind = k;
      break;
    }
  }
  const span = m?.indices?.groups?.name;
  if (!m || !kind || !span) return null;
  const parts = parseQualifiedName(sql.slice(lead + span[0], lead + span[1]), driver);
  if (!parts) return null;
  return {
    kind,
    database: parts.length === 2 ? parts[0] : null,
    table: parts[parts.length - 1],
    ifExists: !!m.groups?.ie,
  };
}
