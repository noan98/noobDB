// スキーマドキュメントの AI 自動生成 (#696) の純ロジック: スコープ解決・コンテキストのテキスト化・
// プロンプト組み立て・送信サイズの見積もり・生成物の冒頭注記。副作用 (IPC・状態管理) は
// `components/AiSchemaDocModal.tsx` が持つ。
// 送るのはテーブル / 列の名前・型・NULL 可・キー・コメント、インデックス、外部キー、ビュー / ルーチンの
// 定義だけ。行データ・サンプル値・列のデフォルト値は送らない。

import { dialectLabel } from "./errorExplain";

/** この件数を超えるスキーマでは、インデックス / 定義取得の並列度を `LARGE_CONCURRENCY` に抑える。 */
export const SCHEMA_DOC_THROTTLE_TABLES = 100;
/** この件数を超えるスキーマでは、送信前に警告を出して「選択テーブルとその参照先」を促す。 */
export const SCHEMA_DOC_WARN_TABLES = 300;
/** 通常時の並列度。 */
const NORMAL_CONCURRENCY = 8;
/** 大きいスキーマでの並列度。 */
const LARGE_CONCURRENCY = 4;
/** ビュー / ルーチン 1 件の定義を送る最大文字数。超えた分は切り詰める。 */
export const SCHEMA_DOC_DEFINITION_MAX_CHARS = 4000;
/** 定義を取得して送るビュー / ルーチンの最大件数。 */
export const SCHEMA_DOC_MAX_OBJECTS = 40;

export interface SchemaDocColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string;
  /** 列コメント。デフォルト値は意図的に持たない (送らない)。 */
  comment: string | null;
}

export interface SchemaDocIndex {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  method: string | null;
}

export interface SchemaDocTable {
  name: string;
  isView: boolean;
  comment: string | null;
  columns: SchemaDocColumn[];
  indexes: SchemaDocIndex[];
}

export interface SchemaDocForeignKey {
  table: string;
  column: string;
  referenced_table: string;
  referenced_column: string | null;
}

/** ビュー / ルーチンなどテーブル以外のオブジェクト (定義が取れなければ `definition` は null)。 */
export interface SchemaDocObject {
  kind: string;
  name: string;
  definition: string | null;
}

export interface SchemaDocContext {
  tables: SchemaDocTable[];
  foreignKeys: SchemaDocForeignKey[];
  objects: SchemaDocObject[];
}

export type SchemaDocScopeMode = "all" | "selected";

/**
 * 生成対象のテーブル名を決める。`all` は全テーブル、`selected` は選択したテーブルと、
 * そこから外部キーの参照先 (親側) を推移的にたどって到達できるテーブル。
 * 戻り値は `allTables` の並び順で、存在しない選択名は除く。
 */
export function resolveSchemaDocScope(input: {
  allTables: readonly string[];
  selected: readonly string[];
  foreignKeys: readonly SchemaDocForeignKey[];
  mode: SchemaDocScopeMode;
}): string[] {
  if (input.mode === "all") return [...input.allTables];
  const parents = new Map<string, string[]>();
  for (const fk of input.foreignKeys) {
    const list = parents.get(fk.table);
    if (list) list.push(fk.referenced_table);
    else parents.set(fk.table, [fk.referenced_table]);
  }
  const seen = new Set(input.selected);
  const queue = [...seen];
  for (let i = 0; i < queue.length; i++) {
    for (const next of parents.get(queue[i]) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return input.allTables.filter((n) => seen.has(n));
}

/** スコープ内のテーブル同士を結ぶ外部キーだけに絞る。 */
export function filterForeignKeysInScope<T extends SchemaDocForeignKey>(
  foreignKeys: readonly T[],
  names: readonly string[],
): T[] {
  const set = new Set(names);
  return foreignKeys.filter((fk) => set.has(fk.table) && set.has(fk.referenced_table));
}

/**
 * 定義を取得して送るビュー / ルーチンを選ぶ。`scopeNames` が null (DB 全体) ならビューとルーチン、
 * 配列 (選択スコープ) ならスコープ内のビューだけ。トリガーは対象外。上限件数で打ち切る。
 */
export function selectDocObjects<T extends { kind: string; name: string }>(
  objects: readonly T[],
  scopeNames: readonly string[] | null,
): T[] {
  const set = scopeNames ? new Set(scopeNames) : null;
  const picked = objects.filter((o) => {
    if (o.kind === "view" || o.kind === "materialized_view") return !set || set.has(o.name);
    if (o.kind === "procedure" || o.kind === "function") return set === null;
    return false;
  });
  return picked.slice(0, SCHEMA_DOC_MAX_OBJECTS);
}

/** 並列度。テーブル数が多いときは DB への同時リクエストを抑える。 */
export function schemaDocConcurrency(tableCount: number): number {
  return tableCount > SCHEMA_DOC_THROTTLE_TABLES ? LARGE_CONCURRENCY : NORMAL_CONCURRENCY;
}

/** 非同期関数を最大 `limit` 件ずつ並列に適用する。結果は入力と同じ順序で返る。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** 定義が長すぎる場合に切り詰める (切り詰めた印を末尾に付ける)。 */
export function truncateDefinition(def: string): string {
  const trimmed = def.trim();
  if (trimmed.length <= SCHEMA_DOC_DEFINITION_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SCHEMA_DOC_DEFINITION_MAX_CHARS)}\n-- (truncated)`;
}

/** コメントを 1 行に畳む (改行・連続空白を 1 つの空白へ)。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** AI へ渡すスキーマ本文。デフォルト値・行データは含めない。 */
export function buildSchemaDocContextText(ctx: SchemaDocContext): string {
  const lines: string[] = ["## Tables"];
  for (const t of ctx.tables) {
    lines.push("");
    lines.push(`### ${t.name}${t.isView ? " (view)" : ""}`);
    if (t.comment && t.comment.trim() !== "") lines.push(`Comment: ${oneLine(t.comment)}`);
    lines.push("Columns (name | type | nullability | key | comment):");
    for (const c of t.columns) {
      const parts = [c.name, c.data_type, c.nullable ? "NULL" : "NOT NULL", c.key || "-"];
      if (c.comment && c.comment.trim() !== "") parts.push(oneLine(c.comment));
      lines.push(`- ${parts.join(" | ")}`);
    }
    if (t.indexes.length > 0) {
      lines.push("Indexes:");
      for (const ix of t.indexes) {
        const flags = [ix.primary ? "PRIMARY" : null, ix.unique ? "UNIQUE" : null, ix.method]
          .filter((x): x is string => !!x)
          .join(" ");
        lines.push(`- ${ix.name} (${ix.columns.join(", ")})${flags ? ` ${flags}` : ""}`);
      }
    }
  }
  if (ctx.foreignKeys.length > 0) {
    lines.push("");
    lines.push("## Foreign keys");
    for (const fk of ctx.foreignKeys) {
      lines.push(`- ${fk.table}.${fk.column} -> ${fk.referenced_table}.${fk.referenced_column ?? "?"}`);
    }
  }
  const withDef = ctx.objects.filter((o) => o.definition && o.definition.trim() !== "");
  if (withDef.length > 0) {
    lines.push("");
    lines.push("## Views and routines (definitions)");
    for (const o of withDef) {
      lines.push("");
      lines.push(`### ${o.kind} ${o.name}`);
      lines.push("```sql");
      lines.push(truncateDefinition(o.definition ?? ""));
      lines.push("```");
    }
  }
  return lines.join("\n");
}

export interface SchemaDocSystemInput {
  /** `mysql` / `postgres` / `sqlite`。 */
  driver: string;
  database: string | null;
  locale: "ja" | "en";
  context: SchemaDocContext;
}

/** system プロンプト。方言・出力仕様・スキーマ本文を含める。 */
export function buildSchemaDocSystem(input: SchemaDocSystemInput): string {
  const lang = input.locale === "ja" ? "Japanese" : "English";
  const dialect = dialectLabel(input.driver);
  const hasObjects = input.context.objects.some((o) => o.definition && o.definition.trim() !== "");
  const lines = [
    `You are a senior ${dialect} database engineer who writes schema documentation for hand-over and onboarding.`,
    `Target dialect: ${dialect}. Write the whole document in ${lang}.`,
    "Answer with the Markdown document body only: no preamble, no closing remarks, and do not wrap the whole answer in a code fence.",
    "Start with a single level-1 heading (the document title), then use level-2 sections in this order:",
    "1. Overview: what this database seems to be used for and how its tables group into domains.",
    "2. Table list: a Markdown table of every table with a one-line estimated purpose.",
    "3. Table details: one level-3 section per table with its estimated role, a column table (name, type, nullable, key, estimated meaning), and its indexes when given.",
    "4. Relationships: explain the primary keys and foreign keys in prose (which table references which and what the relation means), grouped by domain.",
  ];
  if (hasObjects) {
    lines.push(
      "5. Views and routines: explain what each view / routine given below does, based on its definition.",
    );
  }
  lines.push(
    "Rules:",
    "- Use only the tables, columns, indexes and foreign keys listed below. Never invent names.",
    "- Meanings and purposes are inferred from names, types, keys and comments. Mark inferred statements as such and use the given comments verbatim where they exist; say so when something is unclear instead of guessing.",
    "- You are given only the schema. Never claim anything about row contents, row counts or actual values.",
    "- Do not write the generation date or connection details; the application adds them.",
  );
  lines.push("");
  lines.push(input.database ? `Database: ${input.database}` : "Database: (default)");
  lines.push(buildSchemaDocContextText(input.context));
  return lines.join("\n");
}

/** ユーザプロンプト (固定の依頼文)。スキーマは system に入れてあるため、行データは含まない。 */
export function buildSchemaDocPrompt(locale: "ja" | "en"): string {
  return locale === "ja"
    ? "上記のスキーマから、引き継ぎ・オンボーディング用のスキーマドキュメントを Markdown で作成してください。"
    : "Write the schema documentation for hand-over and onboarding as Markdown, based on the schema above.";
}

export type SchemaDocSendLevel = "ok" | "large" | "tooLarge";

export interface SchemaDocSendSummary {
  tableCount: number;
  columnCount: number;
  fkCount: number;
  /** 送る本文の概算サイズ (文字数)。 */
  approxChars: number;
  /** `large` は並列度を抑える領域、`tooLarge` は警告を出して絞り込みを促す領域。 */
  level: SchemaDocSendLevel;
}

/** 送信前にモーダルへ見せる、件数と送信サイズの目安。 */
export function summarizeSchemaDocSend(ctx: SchemaDocContext): SchemaDocSendSummary {
  const tableCount = ctx.tables.length;
  return {
    tableCount,
    columnCount: ctx.tables.reduce((n, t) => n + t.columns.length, 0),
    fkCount: ctx.foreignKeys.length,
    approxChars: buildSchemaDocContextText(ctx).length,
    level:
      tableCount > SCHEMA_DOC_WARN_TABLES
        ? "tooLarge"
        : tableCount > SCHEMA_DOC_THROTTLE_TABLES
          ? "large"
          : "ok",
  };
}

const DISCLAIMER = {
  ja: "このドキュメントには AI による推定を含みます。内容は実際のスキーマと照合してください。",
  en: "This document contains AI-generated inferences. Verify it against the actual schema.",
} as const;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ローカル時刻の `YYYY-MM-DD HH:mm`。 */
export function formatDocTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface SchemaDocHeaderInput {
  generatedAt: Date;
  /** 接続プロファイル名 (ホスト名・パスは含めない)。 */
  profileName: string;
  database: string | null;
  driver: string;
  locale: "ja" | "en";
}

/** 生成物の冒頭注記 (モデルに書かせず、フロントで必ず付ける)。 */
export function buildSchemaDocHeader(input: SchemaDocHeaderInput): string {
  const ja = input.locale === "ja";
  const target = [input.profileName, input.database].filter((x): x is string => !!x).join(" / ");
  return [
    `> - ${ja ? "生成日時" : "Generated at"}: ${formatDocTimestamp(input.generatedAt)}`,
    `> - ${ja ? "対象接続" : "Connection"}: ${target} (${dialectLabel(input.driver)})`,
    `> - ${ja ? "注意" : "Note"}: ${DISCLAIMER[input.locale]}`,
  ].join("\n");
}

/** 冒頭注記 + モデルの本文。 */
export function assembleSchemaDoc(header: string, body: string): string {
  return `${header}\n\n${body.trim()}\n`;
}

/** 保存ダイアログの既定ファイル名。 */
export function defaultSchemaDocFilename(database: string | null, now: Date = new Date()): string {
  const db = (database ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "database";
  const ts = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  return `schema_doc_${db}_${ts}.md`;
}
