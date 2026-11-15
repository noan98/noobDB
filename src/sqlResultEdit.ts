// SQL タブの単一テーブル SELECT 結果をインライン編集してよいかの純ロジック (#2355)。
//
// テーブルタブの編集 UI (セル編集・行削除・行追加 → ChangeSetBar → Apply) を SQL タブの結果にも
// 出す。書き込み経路は新設せず、テーブルタブと同じ `applyEditsForTab` (`bulk_update_cells`) を通す
// ので、read_only の拒否・confirm_writes・フライトレコーダー・履歴記録はそのまま効く。ここでは
// 「その SELECT が編集に耐える形か」だけを判定する。副作用がないので Vitest で境界を固定する
// (`__tests__/sqlResultEdit.test.ts`)。
//
// 設計上の決定 (誤った行・列を書き換えないことを最優先する。迷ったら編集不可に倒す):
// - 編集してよいのは「単一テーブル (JOIN・サブクエリ・CTE・DISTINCT・GROUP BY・集計・窓関数・
//   集合演算なし) で、行を一意に識別するキーの列がすべて結果に含まれる」SELECT だけ。
// - 結果の列名でテーブルの列を引くため、別名や式が実テーブルの列名と同名になる
//   (`name AS id` など) と、別の列を主キーとして UPDATE しかねない。式・別名の列名が
//   テーブルの列名と衝突したら全体を編集不可にする。衝突しない式・別名の列は列単位で読み取り専用。
// - 別名の無い式 (`price * 1.1`) は、ドライバごとに結果の列名が決まる規則が違い (PostgreSQL は
//   `id::text` を `id` と名付ける) 衝突を静的に判定できないので、全体を編集不可にして
//   `AS` を付けるよう促す。
// - 行の識別は `resolveRowIdentity` (テーブルタブと同じ) に委ねる。全列一致 (all_columns) は
//   SQL タブでは使わない (表示中の行が結果の一部で、重複を保証できない)。
import { resolveRowIdentity } from "./components/cellEdit";
import { maskLiterals, trimTrailingSeparators } from "./dangerousSql";
import { analyzeShape, splitTopLevelCommas } from "./tableQueryTemplate";
import type { Column, TableColumnInfo, TableRowIdentity } from "./api/tauri";

/** 編集不可の理由。`sqlEditBlock_<reason>` の i18n キーと 1 対 1。 */
export type SqlEditBlockReason =
  | "multiStatement"
  | "cte"
  | "join"
  | "subquery"
  | "distinct"
  | "grouping"
  | "setOperation"
  | "aggregate"
  | "unsupportedFrom"
  | "unaliasedExpression"
  | "nameClash"
  | "duplicateColumn"
  | "noDatabase"
  | "unknownSchema"
  | "tableNotFound"
  | "noKey"
  | "noRowIdentity";

/** 選択リストの 1 項目。 */
export type SqlSelectItem =
  /** `*` / `t.*` */
  | { kind: "star" }
  /** 列そのもの (別名なし、または同名の別名)。 */
  | { kind: "plain" }
  /** 式・別名付きの列。結果の列名が `outputName`。 */
  | { kind: "derived"; outputName: string };

export interface SqlEditShape {
  /** FROM のスキーマ / データベース修飾。無ければ null。 */
  schema: string | null;
  table: string;
  items: SqlSelectItem[];
}

export type SqlEditShapeResult =
  | { ok: true; shape: SqlEditShape }
  /** `reason` が null なら「SELECT ではない」(トグル自体を出さない)。 */
  | { ok: false; reason: SqlEditBlockReason | null };

const NON_COLUMN_WORDS = new Set([
  "null",
  "true",
  "false",
  "current_timestamp",
  "current_date",
  "current_time",
  "localtime",
  "localtimestamp",
  "current_user",
  "session_user",
  "user",
]);

const AGGREGATE_RE =
  /\b(?:count|sum|avg|min|max|total|group_concat|string_agg|array_agg|json_agg|jsonb_agg|json_arrayagg|json_objectagg|bit_and|bit_or|bit_xor|std|stddev|stddev_pop|stddev_samp|variance|var_pop|var_samp|every|bool_and|bool_or|xmlagg|any_value)\s*\(|\bover\s*[(a-z_"`]/i;

/** 識別子のクオート規則。MySQL は `` ` `` のみ、PostgreSQL は `"` のみ、SQLite は両方。 */
function quoteChars(driver: string): string[] {
  if (driver === "mysql") return ["`"];
  if (driver === "sqlite") return ['"', "`"];
  return ['"'];
}

/**
 * `a.b.c` / `"a"."b"` の識別子の並びを分解する。識別子以外 (式・空白・リテラル) が混じれば null。
 * PostgreSQL の引用符なし識別子は小文字に畳む。
 */
export function parseIdentPath(text: string, driver: string): string[] | null {
  const s = text.trim();
  if (!s) return null;
  const quotes = quoteChars(driver);
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    const c = s[i];
    if (c !== undefined && quotes.includes(c)) {
      let j = i + 1;
      let name = "";
      for (;;) {
        if (j >= s.length) return null;
        if (s[j] === c) {
          if (s[j + 1] === c) {
            name += c;
            j += 2;
            continue;
          }
          break;
        }
        name += s[j];
        j++;
      }
      parts.push(name);
      i = j + 1;
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i));
      if (!m) return null;
      parts.push(driver === "postgres" ? m[0].toLowerCase() : m[0]);
      i += m[0].length;
    }
    if (i === s.length) return parts;
    if (s[i] !== ".") return null;
    i++;
  }
}

/** `(select ...)` の括弧グループを空白に置き換える (サブクエリ内の集計を外側のものと混同しない)。 */
function blankSubqueries(masked: string): string {
  let out = masked;
  for (;;) {
    const m = /\(\s*select\b/i.exec(out);
    if (!m) return out;
    let depth = 0;
    let end = out.length;
    for (let i = m.index; i < out.length; i++) {
      if (out[i] === "(") depth++;
      else if (out[i] === ")") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    out = out.slice(0, m.index) + " ".repeat(end - m.index) + out.slice(end);
  }
}

interface FromRef {
  schema: string | null;
  table: string;
  /** 参照名 (別名があれば別名、無ければテーブル名)。 */
  refName: string;
}

/** FROM 直後のテーブル参照 (`t` / `db.t [AS] a`) を解釈する。 */
function parseFromSegment(segment: string, driver: string): FromRef | null {
  const text = segment.trim();
  if (!text) return null;
  // 別名: 末尾の `[AS] ident` (引用符付きも可)。パスの後ろに空白区切りで 1 語だけ許す。
  const m = /^(\S+?)(?:\s+(?:as\s+)?(\S+))?$/i.exec(text);
  if (!m) return null;
  const path = parseIdentPath(m[1], driver);
  if (!path || path.length > 2) return null;
  let alias: string | null = null;
  if (m[2] !== undefined) {
    const a = parseIdentPath(m[2], driver);
    if (!a || a.length !== 1) return null;
    // `FROM t USE` のような修飾語を別名と取り違えない。
    if (NON_ALIAS_WORDS.has(a[0].toLowerCase()) && !/^["`]/.test(m[2])) return null;
    alias = a[0];
  }
  const table = path[path.length - 1];
  return { schema: path.length === 2 ? path[0] : null, table, refName: alias ?? table };
}

const NON_ALIAS_WORDS = new Set([
  "use",
  "force",
  "ignore",
  "partition",
  "tablesample",
  "indexed",
  "not",
  "only",
  "lateral",
  "natural",
  "on",
  "using",
  "straight_join",
]);

function classifyItem(
  item: string,
  maskedItem: string,
  from: FromRef,
  driver: string,
): { item: SqlSelectItem } | { reason: SqlEditBlockReason } {
  const refMatches = (q: string[]): boolean => {
    // `t.col` / `t.*` の修飾子は FROM の参照名 (別名があれば別名) と一致すること。
    // 引用符なしの識別子は大文字小文字を区別しないので小文字で比べる。
    if (q.length === 0) return true;
    if (q.length === 1) return q[0].toLowerCase() === from.refName.toLowerCase();
    if (q.length === 2) {
      return (
        q[1].toLowerCase() === from.table.toLowerCase() &&
        from.refName === from.table &&
        (from.schema === null || q[0].toLowerCase() === from.schema.toLowerCase())
      );
    }
    return false;
  };
  const trimmed = item.trim();
  if (trimmed === "*") return { item: { kind: "star" } };
  if (/\.\s*\*$/.test(trimmed)) {
    const q = parseIdentPath(trimmed.replace(/\.\s*\*$/, ""), driver);
    return q && refMatches(q) ? { item: { kind: "star" } } : { reason: "unsupportedFrom" };
  }
  // 集計・窓関数 (サブクエリの中は除く)。GROUP BY が無くても全体が 1 行に畳まれる。
  if (AGGREGATE_RE.test(blankSubqueries(maskedItem))) return { reason: "aggregate" };

  // 列そのもの: `col` / `t.col` (別名なし)。
  const path = parseIdentPath(trimmed, driver);
  if (path && !(path.length === 1 && NON_COLUMN_WORDS.has(path[0].toLowerCase()) && !/^["`]/.test(trimmed))) {
    return refMatches(path.slice(0, -1)) ? { item: { kind: "plain" } } : { reason: "unsupportedFrom" };
  }

  // `<式または列> AS <別名>`。AS はマスク済みテキストのトップレベル最後の語で探す。
  const asMatch = /\s+as\s+((?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][A-Za-z0-9_$]*))\s*$/i.exec(maskedItem);
  // マスクはリテラルを空白にするが、引用符付き識別子は残らないことがあるので元テキストでも探す。
  const asOrig = /\s+as\s+((?:"(?:[^"]|"")*"|`(?:[^`]|``)*`|[A-Za-z_][A-Za-z0-9_$]*))\s*$/i.exec(trimmed);
  const aliasMatch = asOrig ?? asMatch;
  if (aliasMatch) {
    const alias = parseIdentPath(aliasMatch[1], driver);
    if (!alias || alias.length !== 1) return { reason: "unaliasedExpression" };
    const left = trimmed.slice(0, aliasMatch.index);
    const leftPath = parseIdentPath(left, driver);
    const isPlainLeft =
      leftPath !== null &&
      refMatches(leftPath.slice(0, -1)) &&
      !(leftPath.length === 1 && NON_COLUMN_WORDS.has(leftPath[0].toLowerCase()));
    // `id AS id` は列そのもの。
    if (isPlainLeft && leftPath[leftPath.length - 1] === alias[0]) return { item: { kind: "plain" } };
    return { item: { kind: "derived", outputName: alias[0] } };
  }
  // 暗黙の別名 (`id ident`)。左が列そのものの場合だけ許す (式の暗黙別名は判別が曖昧)。
  const implicit = /^(\S+)\s+(\S+)$/.exec(trimmed);
  if (implicit) {
    const left = parseIdentPath(implicit[1], driver);
    const alias = parseIdentPath(implicit[2], driver);
    if (left && alias && alias.length === 1 && refMatches(left.slice(0, -1))) {
      return { item: { kind: "derived", outputName: alias[0] } };
    }
  }
  return { reason: "unaliasedExpression" };
}

/**
 * SELECT 文の形を解析する (スキーマ不要)。編集できる形でなければ理由を返す。
 * `reason: null` は SELECT でない文 (トグルを出さない)。
 */
export function analyzeSqlEditShape(sql: string, driver: string): SqlEditShapeResult {
  const masked = maskLiterals(sql, driver);
  const body = trimTrailingSeparators(masked);
  const firstWord = /^\s*([A-Za-z_]+)/.exec(body)?.[1]?.toLowerCase();
  if (firstWord === "with") return { ok: false, reason: "cte" };
  if (firstWord !== "select") return { ok: false, reason: null };
  // 複数文 (トップレベルの `;` が末尾以外にある)。括弧の中のセミコロンは SELECT では出ない。
  if (body.includes(";")) return { ok: false, reason: "multiStatement" };
  const code = sql.slice(0, body.length);
  const shape = analyzeShape(code, driver);
  if (!shape) return { ok: false, reason: "unsupportedFrom" };
  if (shape.hasJoin) return { ok: false, reason: "join" };
  if (shape.distinct) return { ok: false, reason: "distinct" };
  for (const k of ["group", "having", "window"]) {
    if (shape.clauses.has(k)) return { ok: false, reason: "grouping" };
  }
  for (const k of ["union", "intersect", "except"]) {
    if (shape.clauses.has(k)) return { ok: false, reason: "setOperation" };
  }
  const fromText = shape.fromSegment.trim();
  if (fromText.startsWith("(")) return { ok: false, reason: "subquery" };
  const from = parseFromSegment(fromText, driver);
  if (!from) return { ok: false, reason: "unsupportedFrom" };

  const rawItems = splitTopLevelCommas(shape.selectList, driver);
  if (rawItems.length === 0) return { ok: false, reason: "unsupportedFrom" };
  const items: SqlSelectItem[] = [];
  for (const raw of rawItems) {
    const r = classifyItem(raw, maskLiterals(raw, driver), from, driver);
    if ("reason" in r) return { ok: false, reason: r.reason };
    items.push(r.item);
  }
  return { ok: true, shape: { schema: from.schema, table: from.table, items } };
}

export type SqlEditResolution =
  | {
      ok: true;
      /** 編集してよい結果の列名 (実テーブルの列そのもの)。 */
      editableColumns: string[];
      /** 行の追加・複製・貼り付け挿入を出してよいか (結果の全列が実テーブルの列)。 */
      insertable: boolean;
    }
  | { ok: false; reason: SqlEditBlockReason };

/**
 * スキーマと実際の結果の列から、編集可否と編集してよい列を決める。
 * `tableColumns` は対象テーブルの列 (`open_table`)、`rowIdentity` はその行識別 (主キーが無いとき)。
 */
export function resolveSqlEdit(args: {
  shape: SqlEditShape;
  resultColumns: Pick<Column, "name">[];
  tableColumns: TableColumnInfo[] | null;
  rowIdentity: (Pick<TableRowIdentity, "strategy" | "hidden_column"> & { key_columns?: string[] }) | null;
}): SqlEditResolution {
  const { shape, resultColumns, tableColumns, rowIdentity } = args;
  if (!tableColumns || tableColumns.length === 0) return { ok: false, reason: "tableNotFound" };

  // 結果の列名が重複すると、名前でテーブルの列を引く編集が曖昧になる。
  const seen = new Set<string>();
  for (const c of resultColumns) {
    if (seen.has(c.name)) return { ok: false, reason: "duplicateColumn" };
    seen.add(c.name);
  }
  // 式・別名の列名が実テーブルの列名と (大文字小文字を無視して) 衝突したら、別の列を主キー等と
  // 取り違える恐れがあるので全体を編集不可にする。
  const tableNames = new Set(tableColumns.map((c) => c.name.toLowerCase()));
  for (const it of shape.items) {
    if (it.kind === "derived" && tableNames.has(it.outputName.toLowerCase())) {
      return { ok: false, reason: "nameClash" };
    }
  }

  const identity = resolveRowIdentity(resultColumns as Column[], tableColumns, rowIdentity);
  if (identity.strategy === "none") return { ok: false, reason: "noKey" };
  if (identity.strategy === "all_columns") return { ok: false, reason: "noRowIdentity" };

  const derivedNames = new Set(shape.items.flatMap((it) => (it.kind === "derived" ? [it.outputName] : [])));
  const byName = new Set(tableColumns.map((c) => c.name));
  const editableColumns = resultColumns
    .map((c) => c.name)
    .filter((name) => byName.has(name) && !derivedNames.has(name));
  const insertable = resultColumns.every((c) => byName.has(c.name) && !derivedNames.has(c.name));
  return { ok: true, editableColumns, insertable };
}

// ---------------------------------------------------------------------------
// タブの状態 (App / PaneView が共有する構造的な型と純関数)
// ---------------------------------------------------------------------------

/** 編集の対象と判定結果。`sql` はこの判定をした実行済み SQL。 */
export type SqlEditState =
  | { status: "checking"; sql: string; executedDatabase: string | null; token: string }
  | { status: "unavailable"; sql: string; executedDatabase: string | null; reason: SqlEditBlockReason }
  | {
      status: "available";
      sql: string;
      /** SELECT を実行したときの `tab.database`。 */
      executedDatabase: string | null;
      database: string;
      table: string;
      tableColumns: TableColumnInfo[];
      rowIdentity: TableRowIdentity | null;
      editableColumns: string[];
      insertable: boolean;
    };

export interface SqlEditTabLike {
  kind: string;
  database?: string;
  table?: string;
  tableColumns: TableColumnInfo[] | null;
  rowIdentity: TableRowIdentity | null;
  lastExecutedSql: string;
  /** 直近の実行が使った `tab.database` (`runQueryInTab` が実行開始時に記録)。 */
  lastExecutedDatabase?: string | null;
  pendingEdits?: object;
  pendingDeletes?: readonly unknown[];
  pendingInserts?: readonly unknown[];
  /** 利用者が編集モードをオンにしたか。 */
  sqlEditOn?: boolean;
  sqlEdit?: SqlEditState;
}

export type SqlEditTabView = Pick<
  SqlEditTabLike,
  | "kind"
  | "sqlEditOn"
  | "sqlEdit"
  | "lastExecutedSql"
  | "lastExecutedDatabase"
  | "pendingEdits"
  | "pendingDeletes"
  | "pendingInserts"
>;

/** 判定が、いま表示している結果 (同じ SQL・同じ実行 DB) に対するものか。 */
function judgmentIsCurrent(tab: SqlEditTabView): boolean {
  const e = tab.sqlEdit;
  return !!e && e.sql === tab.lastExecutedSql && e.executedDatabase === (tab.lastExecutedDatabase ?? null);
}

/** 保留中の変更 (セル編集・削除予定・追加行) があるか。 */
export function hasPendingSqlEditChanges(tab: SqlEditTabView): boolean {
  return (
    Object.keys(tab.pendingEdits ?? {}).length > 0 ||
    (tab.pendingDeletes?.length ?? 0) > 0 ||
    (tab.pendingInserts?.length ?? 0) > 0
  );
}

/** 編集モードが有効 (トグルがオンで、現在の結果に対する判定が編集可)。 */
export function sqlEditActive(tab: SqlEditTabView): boolean {
  return (
    tab.kind === "query" &&
    tab.sqlEditOn === true &&
    tab.sqlEdit?.status === "available" &&
    judgmentIsCurrent(tab)
  );
}

/**
 * 編集モードのとき、タブの `database` / `table` / `tableColumns` / `rowIdentity` を編集対象で
 * 上書きした浅いコピーを返す (Apply・プレビュー・行追加などテーブルタブ向けの処理へ渡す)。
 * それ以外は同じオブジェクトをそのまま返す。
 */
export function withSqlEditTarget<T extends SqlEditTabLike>(tab: T): T {
  if (!sqlEditActive(tab) || tab.sqlEdit?.status !== "available") return tab;
  const e = tab.sqlEdit;
  return {
    ...tab,
    database: e.database,
    table: e.table,
    tableColumns: e.tableColumns,
    rowIdentity: e.rowIdentity,
  };
}

/** ツールバーのトグルの表示。`null` なら出さない (SELECT でない・未判定など)。 */
export type SqlEditToggleView =
  | { state: "off" }
  /** `locked`: 保留中の変更があるのでオフにできない (オフにすると Apply できなくなる)。 */
  | { state: "on"; locked: boolean }
  | { state: "unavailable"; reason: SqlEditBlockReason };

export function sqlEditToggleView(tab: SqlEditTabView): SqlEditToggleView | null {
  if (tab.kind !== "query") return null;
  const e = tab.sqlEdit;
  if (!e || !judgmentIsCurrent(tab)) return null;
  if (e.status === "checking") return null;
  if (e.status === "unavailable") return { state: "unavailable", reason: e.reason };
  return tab.sqlEditOn === true ? { state: "on", locked: hasPendingSqlEditChanges(tab) } : { state: "off" };
}

/** 結果の列のうち、編集モード中にセル編集を許す列か。編集モードでなければ全列 true (従来どおり)。 */
export function sqlEditColumnMask(tab: SqlEditTabView): ReadonlySet<string> | null {
  if (!sqlEditActive(tab) || tab.sqlEdit?.status !== "available") return null;
  return new Set(tab.sqlEdit.editableColumns);
}

/** 編集モード中に行の追加・複製・貼り付け挿入を出してよいか。 */
export function sqlEditInsertable(tab: SqlEditTabView): boolean {
  return sqlEditActive(tab) && tab.sqlEdit?.status === "available" && tab.sqlEdit.insertable;
}

export type EditDatabaseResolution =
  | { ok: true; database: string }
  | { ok: false; reason: "noDatabase" | "unknownSchema" };

/**
 * 書き込み先のデータベース (`open_table` / `bulk_update_cells` の `database` 引数) を、SELECT が
 * **実行されたときの接続状態**と同じに解決する (#2355)。プロファイルの既定へはフォールバックしない
 * (実行は `tab.database ?? null` で流れ、プールの別タブが `USE` 済みなら実行先と食い違うため)。
 *
 * - MySQL: FROM の `db.` 修飾 > 実行時の `tab.database`。どちらも無ければ不可 (`noDatabase`)。
 * - PostgreSQL: `database` 引数はスキーマ。FROM の `schema.` 修飾 > 実行時の `tab.database`。無ければ不可。
 * - SQLite: 修飾なしは `main`。修飾は `main` か設定でアタッチした別名 (バックエンドの `resolve_db` と同じく
 *   大文字小文字を無視し、別名の綴りで返す) のときだけ。`temp` など未アタッチ名は不可 (`unknownSchema`):
 *   バックエンドは未アタッチ名を `main` とみなすので、UPDATE と DELETE/INSERT の対象が食い違う。
 */
export function resolveEditDatabase(args: {
  driver: string;
  schema: string | null;
  /** SELECT を実行した時点の `tab.database` (`runQueryInTab` が記録した値)。 */
  executedDatabase: string | null | undefined;
  /** SQLite の設定済みアタッチ別名。 */
  sqliteAliases?: readonly string[];
}): EditDatabaseResolution {
  const { driver, schema, executedDatabase, sqliteAliases = [] } = args;
  if (driver === "sqlite") {
    if (!schema || schema.toLowerCase() === "main") return { ok: true, database: "main" };
    const alias = sqliteAliases.find((a) => a.toLowerCase() === schema.toLowerCase());
    return alias ? { ok: true, database: alias } : { ok: false, reason: "unknownSchema" };
  }
  const database = schema || executedDatabase;
  return database ? { ok: true, database } : { ok: false, reason: "noDatabase" };
}
