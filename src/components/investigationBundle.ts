import type { CellValue, Column, QueryResult, TableColumnInfo } from "../api/tauri";
import { MASK_PLACEHOLDER } from "./columnMask";

/**
 * 調査バンドル (#745) の純ロジック。
 *
 * 「どのクエリを・どの接続で・いつ実行した結果か」という文脈ごと、DB アクセス権の
 * 無い相手へ共有できる**自己完結した単一 HTML** を組み立てる。外部サービスへは
 * 何も上げず、保存はエクスポートモーダルから既存の `write_binary_file` で行う
 * (バックエンド変更・capabilities 追加なし)。
 *
 * 安全面の方針 — 共有ファイルは受け手のブラウザで開かれるため、ここを厳密にする:
 *   - **埋め込む値はすべて `escapeHtml` を通す** (SQL・セル値・列名・メタ情報・
 *     スキーマ・実行計画・ラベル)。値を生のまま HTML に連結する経路は作らない。
 *   - `<meta http-equiv="Content-Security-Policy">` で `default-src 'none'` を
 *     宣言し、外部リソース (画像・スクリプト・スタイル・通信) の読み込みを
 *     ブラウザ側でも禁止する。インラインのソート用スクリプトは固定文字列で、
 *     データを一切補間しない (値は DOM の textContent から読むだけ)。
 *   - 接続の**秘密情報は受け取らない**型にしている (`BundleMeta` にパスワード・
 *     接続文字列のフィールドが存在しない)。ホスト名は呼び出し側がユーザの選択に
 *     従って渡す/渡さないを決める。
 *   - 機微カラムマスク (#1069) の対象列は、グリッドでの一時 reveal に関係なく
 *     常に伏せ字 (`MASK_PLACEHOLDER`) で出力する (漏らさない側に倒す)。
 *
 * 出力 HTML の配色はアプリのテーマ (CSS 変数) を参照できない独立ファイルのため、
 * `BUNDLE_CSS` に固定で持つ (UI のスタイル指定ではない)。
 */

/** HTML の本文・属性値の両方で安全になるようエスケープする。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// SQL の字句分割 (シンタックスハイライトと参照テーブル抽出で共有)
// ---------------------------------------------------------------------------

export type SqlTokenKind =
  | "comment"
  | "string"
  | "ident"
  | "number"
  | "word"
  | "space"
  | "punct";

export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}

/**
 * SQL をハイライト用のトークン列に分割する。表示用の軽量な分割で、どの入力でも
 * 例外を投げず、連結すると必ず元の文字列に戻る (取りこぼし無し)。
 */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const n = sql.length;
  let i = 0;
  const push = (kind: SqlTokenKind, end: number) => {
    out.push({ kind, text: sql.slice(i, end) });
    i = end;
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "-" && c2 === "-") {
      let j = i + 2;
      while (j < n && sql[j] !== "\n") j++;
      push("comment", j);
      continue;
    }
    if (c === "/" && c2 === "*") {
      const close = sql.indexOf("*/", i + 2);
      push("comment", close === -1 ? n : close + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const closeCh = c === "[" ? "]" : c;
      let j = i + 1;
      while (j < n) {
        if (c === "'" && sql[j] === "\\" && j + 1 < n) {
          j += 2;
          continue;
        }
        if (sql[j] === closeCh) {
          // 二重化による埋め込み ('' / "" / `` / ]]) は閉じとみなさない。
          if (sql[j + 1] === closeCh) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      push(c === "'" ? "string" : "ident", Math.min(n, j + 1));
      continue;
    }
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      push("space", j);
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(sql.slice(i));
      push("number", i + (m ? m[0].length : 1));
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$\u0080-\uffff]/.test(sql[j])) j++;
      push("word", j);
      continue;
    }
    push("punct", i + 1);
  }
  return out;
}

const SQL_KEYWORDS = new Set(
  (
    "select from where and or not in is null as join inner left right full outer cross on " +
    "group by order having limit offset union all distinct insert into values update set " +
    "delete create table view index drop alter add column with recursive case when then " +
    "else end asc desc between like ilike exists top fetch first next rows only over " +
    "partition window returning using natural true false explain analyze primary key " +
    "foreign references default unique check constraint begin commit rollback"
  ).split(" "),
);

/** SQL をハイライト済みの HTML 断片にする (各トークンはエスケープ済み)。 */
export function highlightSqlHtml(sql: string): string {
  return tokenizeSql(sql)
    .map((tok) => {
      const text = escapeHtml(tok.text);
      switch (tok.kind) {
        case "comment":
          return `<span class="c">${text}</span>`;
        case "string":
          return `<span class="s">${text}</span>`;
        case "number":
          return `<span class="n">${text}</span>`;
        case "word":
          return SQL_KEYWORDS.has(tok.text.toLowerCase()) ? `<span class="k">${text}</span>` : text;
        default:
          return text;
      }
    })
    .join("");
}

/** 参照テーブル (スキーマ同梱の対象)。`database` は修飾されていたときだけ入る。 */
export interface TableReference {
  database: string | null;
  table: string;
}

function unquoteIdent(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "`" && last === "`")) {
      return text.slice(1, -1).split(first + first).join(first);
    }
    if (first === "[" && last === "]") return text.slice(1, -1).split("]]").join("]");
  }
  return text;
}

/**
 * SQL の `FROM` / `JOIN` 句から参照テーブルをベストエフォートで抽出する
 * (関連テーブルのスキーマ定義を同梱するため)。コメント・文字列リテラル内の語は
 * 無視し、サブクエリ `FROM (…)` は読み飛ばす。`schema.table` / `db.schema.table`
 * は最後の要素をテーブル名、その 1 つ前を database として返す。重複は除き、
 * 最大 `limit` 件。
 */
export function extractReferencedTables(sql: string, limit = 5): TableReference[] {
  const toks = tokenizeSql(sql).filter((t) => t.kind !== "space" && t.kind !== "comment");
  const out: TableReference[] = [];
  const seen = new Set<string>();
  const isName = (t: SqlToken | undefined) => !!t && (t.kind === "word" || t.kind === "ident");
  let i = 0;
  while (i < toks.length && out.length < limit) {
    const w = toks[i].kind === "word" ? toks[i].text.toLowerCase() : "";
    if (w !== "from" && w !== "join") {
      i++;
      continue;
    }
    i++;
    // FROM a, b, c のカンマ区切りも拾う (JOIN は 1 つだけ)。
    for (;;) {
      if (!isName(toks[i]) || (toks[i].kind === "word" && SQL_KEYWORDS.has(toks[i].text.toLowerCase()))) {
        break;
      }
      const parts: string[] = [unquoteIdent(toks[i].text)];
      i++;
      while (toks[i]?.text === "." && isName(toks[i + 1])) {
        parts.push(unquoteIdent(toks[i + 1].text));
        i += 2;
      }
      // 関数呼び出し (`FROM generate_series(…)`) はテーブルではない。
      if (toks[i]?.text === "(") break;
      const table = parts[parts.length - 1];
      const database = parts.length >= 2 ? parts[parts.length - 2] : null;
      const key = `${database ?? ""}\u0000${table}`;
      if (table && !seen.has(key)) {
        seen.add(key);
        out.push({ database, table });
        if (out.length >= limit) break;
      }
      if (w !== "from") break;
      // エイリアス (`AS x` / `x`) を読み飛ばしてからカンマを探す。
      if (toks[i]?.kind === "word" && toks[i].text.toLowerCase() === "as") i++;
      if (isName(toks[i]) && !(toks[i].kind === "word" && SQL_KEYWORDS.has(toks[i].text.toLowerCase()))) {
        i++;
      }
      if (toks[i]?.text !== ",") break;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 実行計画の取得可否
// ---------------------------------------------------------------------------

/**
 * EXPLAIN の同梱に対応するドライバ。アプリの EXPLAIN タブと同じ JSON / 行ベースの
 * プランが取れるものに限る (MSSQL の SHOWPLAN はセッション設定が要り、DuckDB は
 * 別構文のため対象外)。
 */
export function bundlePlanSupported(driver: string | null | undefined): boolean {
  return driver === "mysql" || driver === "postgres" || driver === "sqlite";
}

/** アプリの EXPLAIN タブと同じ方言別プレフィックス。 */
export function bundleExplainPrefix(driver: string | null | undefined): string {
  if (driver === "postgres") return "EXPLAIN (FORMAT JSON) ";
  if (driver === "sqlite") return "EXPLAIN QUERY PLAN ";
  return "EXPLAIN FORMAT=JSON ";
}

/**
 * スキーマ同梱の対象テーブル。結果の元テーブルが分かっている (テーブルタブ) ならそれ
 * だけ、分からなければ SQL の FROM / JOIN から抽出する。
 */
export function bundleSchemaTargets(
  sql: string | null,
  database: string | null,
  table: string | null,
): TableReference[] {
  if (table) return [{ database, table }];
  return sql ? extractReferencedTables(sql) : [];
}

/**
 * 参照テーブルごとに列定義を取得する。1 テーブルの失敗でバンドル全体を落とさない
 * よう、失敗はそのテーブルの `error` として記録する。database 修飾が無いテーブルは
 * `fallbackDatabase` (タブ/プロファイルの既定 DB) で引く。
 */
export async function loadBundleSchema(
  refs: readonly TableReference[],
  fallbackDatabase: string | null,
  describe: (database: string, table: string) => Promise<TableColumnInfo[]>,
): Promise<BundleSchemaTable[]> {
  return Promise.all(
    refs.map(async (r) => {
      const database = r.database ?? fallbackDatabase;
      try {
        const columns = await describe(database ?? "", r.table);
        return { database, table: r.table, columns };
      } catch (e) {
        return { database, table: r.table, columns: null, error: String(e) };
      }
    }),
  );
}

/**
 * 結果グリッド → エクスポートモーダルへ渡す、バンドル生成用の文脈。接続の秘密情報は
 * 型として持たない。`host` はユーザが「ホスト名を含める」を選んだときだけ出力される。
 */
export interface BundleContext {
  /** 実行した SQL。 */
  sql: string | null;
  profileName: string | null;
  host: string | null;
  /** 実行完了日時 (epoch ms)。 */
  executedAt: number | null;
  /** 列定義の取得 (未接続なら undefined でスキーマ同梱を出さない)。 */
  describe?: (database: string, table: string) => Promise<TableColumnInfo[]>;
  /** EXPLAIN の取得 (対応ドライバかつ読み取り SQL のときだけ)。 */
  loadPlan?: () => Promise<QueryResult>;
}

// ---------------------------------------------------------------------------
// HTML 組み立て
// ---------------------------------------------------------------------------

/** 接続・実行の**非秘密**メタ情報。秘密情報のフィールドは意図的に持たない。 */
export interface BundleMeta {
  generatedAt: Date;
  /** クエリの実行 (完了) 日時。不明なら null。 */
  executedAt: Date | null;
  profileName: string | null;
  driver: string | null;
  database: string | null;
  /** 同梱を選んだときだけ渡す。null なら出力しない。 */
  host: string | null;
  elapsedMs: number | null;
  /** グリッドが結果の一部しか持っていない (自動 LIMIT・未取得ページ・中断)。 */
  partial: boolean;
}

export interface BundleSchemaTable {
  database: string | null;
  table: string;
  columns: TableColumnInfo[] | null;
  /** 取得に失敗したときの理由 (columns は null)。 */
  error?: string;
}

export interface BundlePlan {
  result: QueryResult | null;
  error?: string;
}

/** HTML に出す見出し・注記の文言 (i18n はモーダル側で解決して渡す)。 */
export interface BundleLabels {
  title: string;
  notice: string;
  sectionMeta: string;
  sectionSql: string;
  sectionResult: string;
  sectionSchema: string;
  sectionPlan: string;
  generatedAt: string;
  executedAt: string;
  profile: string;
  driver: string;
  database: string;
  host: string;
  rows: string;
  elapsed: string;
  partial: string;
  masked: string;
  sortHint: string;
  noSql: string;
  noRows: string;
  unavailable: string;
  colName: string;
  colType: string;
  colNullable: string;
  colKey: string;
  colDefault: string;
  colExtra: string;
  yes: string;
  no: string;
}

export interface BundleInput {
  sql: string | null;
  columns: Column[];
  rows: CellValue[][];
  /** 列インデックス順のマスクフラグ (`resolveMaskedColumns` の戻り値)。 */
  maskedColumns: readonly boolean[] | null;
  meta: BundleMeta;
  schema?: BundleSchemaTable[] | null;
  plan?: BundlePlan | null;
  labels: BundleLabels;
  /** `<html lang>`。既定は "ja"。 */
  lang?: string;
}

/** セル値の表示テキスト (エスケープ前)。 */
export function bundleCellText(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/** `YYYY-MM-DD HH:MM:SS (UTC±HH:MM)` — 受け手のタイムゾーンと混同しないよう offset 付き。 */
export function formatBundleDate(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ` +
    `(UTC${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)})`
  );
}

function metaRow(label: string, value: string): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function renderResultTable(
  columns: Column[],
  rows: CellValue[][],
  masked: readonly boolean[] | null,
  labels: BundleLabels,
  sortable: boolean,
): string {
  if (columns.length === 0) return `<p class="muted">${escapeHtml(labels.noRows)}</p>`;
  const head = columns
    .map((c, ci) => {
      const m = masked?.[ci] ? ` <span class="badge">${escapeHtml(labels.masked)}</span>` : "";
      const type = c.type_name ? `<span class="type">${escapeHtml(c.type_name)}</span>` : "";
      return `<th scope="col">${escapeHtml(c.name)}${m}${type}</th>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const cells = columns
        .map((_, ci) => {
          if (masked?.[ci]) return `<td class="mask">${escapeHtml(MASK_PLACEHOLDER)}</td>`;
          const v = r[ci];
          if (v === null || v === undefined) return `<td class="null">NULL</td>`;
          const cls = typeof v === "number" ? ` class="num"` : "";
          return `<td${cls}>${escapeHtml(bundleCellText(v))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");
  const attr = sortable ? ` class="grid sortable"` : ` class="grid"`;
  return `<div class="scroll"><table${attr}><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table></div>`;
}

function renderSchema(schema: BundleSchemaTable[], labels: BundleLabels): string {
  return schema
    .map((s) => {
      const name = s.database ? `${s.database}.${s.table}` : s.table;
      const title = `<h3>${escapeHtml(name)}</h3>`;
      if (!s.columns) {
        return `${title}<p class="muted">${escapeHtml(labels.unavailable)}${
          s.error ? `: ${escapeHtml(s.error)}` : ""
        }</p>`;
      }
      const rows = s.columns
        .map(
          (c) =>
            `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.data_type)}</td><td>${escapeHtml(
              c.nullable ? labels.yes : labels.no,
            )}</td><td>${escapeHtml(c.key)}</td><td>${
              c.default === null ? `<span class="null">NULL</span>` : escapeHtml(c.default)
            }</td><td>${escapeHtml(c.extra)}</td></tr>`,
        )
        .join("");
      return (
        `${title}<div class="scroll"><table class="grid"><thead><tr>` +
        [labels.colName, labels.colType, labels.colNullable, labels.colKey, labels.colDefault, labels.colExtra]
          .map((h) => `<th scope="col">${escapeHtml(h)}</th>`)
          .join("") +
        `</tr></thead><tbody>${rows}</tbody></table></div>`
      );
    })
    .join("\n");
}

/** JSON として解釈できれば 2 スペースで整形、できなければそのまま。 */
function prettyMaybeJson(s: string): string {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

function renderPlan(plan: BundlePlan, labels: BundleLabels): string {
  const r = plan.result;
  if (!r) {
    return `<p class="muted">${escapeHtml(labels.unavailable)}${
      plan.error ? `: ${escapeHtml(plan.error)}` : ""
    }</p>`;
  }
  // MySQL / PostgreSQL の JSON プランは 1 行 1 列で返る — 表ではなく整形テキストで出す。
  if (r.columns.length === 1 && r.rows.length === 1) {
    return `<pre class="plan">${escapeHtml(prettyMaybeJson(bundleCellText(r.rows[0][0])))}</pre>`;
  }
  return renderResultTable(r.columns, r.rows, null, labels, false);
}

/**
 * 出力 HTML のスタイル。独立ファイルなのでアプリのテーマ変数は参照できず、
 * 値を固定で持つ。受け手の OS 設定に合わせてダークにも切り替える。
 */
const BUNDLE_CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#656d76;--border:#d0d7de;--head:#f6f8fa;--k:#8250df;--s:#0a3069;--n:#0550ae;--c:#6e7781;--warn-bg:#fff8c5;--warn-bd:#d4a72c}
@media (prefers-color-scheme: dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--border:#30363d;--head:#161b22;--k:#d2a8ff;--s:#a5d6ff;--n:#79c0ff;--c:#8b949e;--warn-bg:#3b2e00;--warn-bd:#9e6a03}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{font-size:20px;margin:0 0 8px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px}h3{font-size:14px;margin:16px 0 6px;font-family:ui-monospace,monospace}
.notice{padding:8px 12px;border:1px solid var(--warn-bd);background:var(--warn-bg);border-radius:6px;margin:8px 0 16px}
.muted{color:var(--muted)}
.scroll{overflow:auto;max-height:70vh;border:1px solid var(--border);border-radius:6px}
table{border-collapse:collapse}
table.meta th{text-align:left;padding:2px 16px 2px 0;color:var(--muted);font-weight:normal}table.meta td{padding:2px 0}
table.grid{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;width:max-content;min-width:100%}
table.grid th,table.grid td{border-bottom:1px solid var(--border);border-right:1px solid var(--border);padding:4px 8px;text-align:left;vertical-align:top;white-space:pre-wrap;max-width:480px;overflow-wrap:anywhere}
table.grid thead th{position:sticky;top:0;background:var(--head)}
table.sortable thead th{cursor:pointer;user-select:none}
table.sortable thead th[aria-sort=ascending]::after{content:" \\25B2"}table.sortable thead th[aria-sort=descending]::after{content:" \\25BC"}
td.num{text-align:right}td.null,span.null{color:var(--muted);font-style:italic}td.mask{color:var(--muted);letter-spacing:.1em}
.type{display:block;color:var(--muted);font-weight:normal;font-size:11px}
.badge{font-size:10px;border:1px solid var(--border);border-radius:999px;padding:0 6px;color:var(--muted);font-weight:normal}
pre{margin:0;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--head);overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
pre .k{color:var(--k);font-weight:600}pre .s{color:var(--s)}pre .n{color:var(--n)}pre .c{color:var(--c);font-style:italic}
footer{margin-top:32px;color:var(--muted);font-size:12px}
`;

/**
 * 結果テーブルのソート (ヘッダクリックで昇順/降順)。**固定文字列**で、データを
 * 補間しない。値は各セルの textContent から読む (伏せ字・NULL もそのまま文字列比較)。
 */
const BUNDLE_SORT_SCRIPT = `
(function(){
  var cmp=function(a,b){
    var na=parseFloat(a),nb=parseFloat(b);
    if(a!==""&&b!==""&&!isNaN(na)&&!isNaN(nb)&&isFinite(a)&&isFinite(b))return na-nb;
    return a.localeCompare(b,undefined,{numeric:true});
  };
  document.querySelectorAll("table.sortable").forEach(function(t){
    var ths=t.tHead.rows[0].cells;
    Array.prototype.forEach.call(ths,function(th,i){
      th.tabIndex=0;
      var run=function(){
        var dir=th.getAttribute("aria-sort")==="ascending"?-1:1;
        Array.prototype.forEach.call(ths,function(o){o.removeAttribute("aria-sort");});
        th.setAttribute("aria-sort",dir===1?"ascending":"descending");
        var body=t.tBodies[0];
        var rows=Array.prototype.slice.call(body.rows);
        rows.sort(function(x,y){return dir*cmp(x.cells[i].textContent,y.cells[i].textContent);});
        rows.forEach(function(r){body.appendChild(r);});
      };
      th.addEventListener("click",run);
      th.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();run();}});
    });
  });
})();
`;

/**
 * 外部リソースを一切読み込ませない CSP。インラインのスタイル/スクリプト (上の固定
 * 文字列) だけを許可する。値はすべてエスケープ済みなので、データ由来のスクリプトは
 * そもそも生成されない — CSP はその上での二重の防御。
 */
export const BUNDLE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

/** 調査バンドルの HTML 全体を組み立てる。 */
export function buildInvestigationBundleHtml(input: BundleInput): string {
  const { sql, columns, rows, maskedColumns, meta, schema, plan, labels } = input;
  const lang = /^[A-Za-z-]{1,16}$/.test(input.lang ?? "") ? (input.lang as string) : "ja";
  const metaRows: string[] = [metaRow(labels.generatedAt, formatBundleDate(meta.generatedAt))];
  if (meta.executedAt) metaRows.push(metaRow(labels.executedAt, formatBundleDate(meta.executedAt)));
  if (meta.profileName) metaRows.push(metaRow(labels.profile, meta.profileName));
  if (meta.driver) metaRows.push(metaRow(labels.driver, meta.driver));
  if (meta.database) metaRows.push(metaRow(labels.database, meta.database));
  if (meta.host) metaRows.push(metaRow(labels.host, meta.host));
  metaRows.push(metaRow(labels.rows, `${rows.length} × ${columns.length}`));
  if (meta.elapsedMs !== null && Number.isFinite(meta.elapsedMs)) {
    metaRows.push(metaRow(labels.elapsed, `${meta.elapsedMs} ms`));
  }

  const maskedNames = columns.filter((_, i) => maskedColumns?.[i]).map((c) => c.name);

  const sections: string[] = [];
  sections.push(
    `<section><h2>${escapeHtml(labels.sectionMeta)}</h2><table class="meta"><tbody>${metaRows.join(
      "",
    )}</tbody></table>${
      meta.partial ? `<p class="notice">${escapeHtml(labels.partial)}</p>` : ""
    }${
      maskedNames.length > 0
        ? `<p class="muted">${escapeHtml(labels.masked)}: ${maskedNames.map(escapeHtml).join(", ")}</p>`
        : ""
    }</section>`,
  );
  sections.push(
    `<section><h2>${escapeHtml(labels.sectionSql)}</h2>${
      sql && sql.trim()
        ? `<pre class="sql"><code>${highlightSqlHtml(sql)}</code></pre>`
        : `<p class="muted">${escapeHtml(labels.noSql)}</p>`
    }</section>`,
  );
  sections.push(
    `<section><h2>${escapeHtml(labels.sectionResult)}</h2><p class="muted">${escapeHtml(
      labels.sortHint,
    )}</p>${renderResultTable(columns, rows, maskedColumns, labels, true)}</section>`,
  );
  if (schema && schema.length > 0) {
    sections.push(`<section><h2>${escapeHtml(labels.sectionSchema)}</h2>${renderSchema(schema, labels)}</section>`);
  }
  if (plan) {
    sections.push(`<section><h2>${escapeHtml(labels.sectionPlan)}</h2>${renderPlan(plan, labels)}</section>`);
  }

  return [
    "<!DOCTYPE html>",
    `<html lang="${escapeHtml(lang)}">`,
    "<head>",
    `<meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(BUNDLE_CSP)}">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="generator" content="noobDB">`,
    `<title>${escapeHtml(labels.title)}</title>`,
    `<style>${BUNDLE_CSS}</style>`,
    "</head>",
    "<body>",
    `<header><h1>${escapeHtml(labels.title)}</h1><p class="notice">${escapeHtml(labels.notice)}</p></header>`,
    `<main>`,
    sections.join("\n"),
    `</main>`,
    `<footer>${escapeHtml(labels.notice)}</footer>`,
    `<script>${BUNDLE_SORT_SCRIPT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
