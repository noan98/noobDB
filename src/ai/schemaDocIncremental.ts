// スキーマドキュメントの差分再生成 (#1620) の純ロジック。
//
// 全体を作ったあと、テーブルごとの指紋 (`buildSchemaDocContextText` の 1 テーブル分のハッシュ) を
// 本文と一緒に保存しておく。次回は指紋が変わった表と、その外部キーの参照先 (親) だけを AI に
// 作り直させ、変わっていない表の節 (`### 表名`) は前回の本文をそのまま使って結合する。
// 送るのは「作り直す表」のスキーマだけなので、大きな DB ほど時間と送信量が減る。
//
// 割り切り: 作り直すのは表ごとの詳細の節だけで、概要・表一覧・関係の節は前回のまま
// (冒頭の注記で明示する)。ビュー / ルーチンの定義が変わった・言語やドライバが変わった・
// 作り直す表が多い、のいずれかなら全体を再生成する (取り違えるより安全側に倒す)。

import { fingerprint } from "./aiCache";
import { dialectLabel } from "./errorExplain";
import {
  buildSchemaDocContextText,
  type SchemaDocContext,
  type SchemaDocForeignKey,
  type SchemaDocObject,
  type SchemaDocTable,
} from "./schemaDoc";

/** 作り直す表がスコープの表数のこの割合を超えたら、差分にせず全体を再生成する。 */
export const SCHEMA_DOC_INCREMENTAL_MAX_RATIO = 0.6;
/** 差分用のプロンプトに「他の表の名前」として載せる最大件数。 */
const OTHER_TABLES_MAX = 200;
/** 保存形式のバージョン。節の書式やプロンプトを変えたら上げる (古い保存分は使われなくなる)。 */
const SCHEMA_DOC_CACHE_VERSION = 1;

/** 保存するドキュメント (#1620)。本文は冒頭の注記を含まない、モデルの出力そのもの。 */
export interface CachedSchemaDoc {
  v: number;
  locale: "ja" | "en";
  driver: string;
  maskLiterals: boolean;
  /** ビュー / ルーチンの定義の指紋。変わったら全体を作り直す。 */
  objectsFp: string;
  /** 表名 → その表のスキーマ断片の指紋。 */
  hashes: Record<string, string>;
  body: string;
  generatedAt: number;
}

export function isCachedSchemaDoc(v: unknown): v is CachedSchemaDoc {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.v === SCHEMA_DOC_CACHE_VERSION &&
    (o.locale === "ja" || o.locale === "en") &&
    typeof o.driver === "string" &&
    typeof o.maskLiterals === "boolean" &&
    typeof o.objectsFp === "string" &&
    typeof o.body === "string" &&
    typeof o.generatedAt === "number" &&
    !!o.hashes &&
    typeof o.hashes === "object" &&
    Object.values(o.hashes as Record<string, unknown>).every((h) => typeof h === "string")
  );
}

export function buildCachedSchemaDoc(input: {
  locale: "ja" | "en";
  driver: string;
  maskLiterals: boolean;
  objectsFp: string;
  hashes: Record<string, string>;
  body: string;
  generatedAt: number;
}): CachedSchemaDoc {
  return { v: SCHEMA_DOC_CACHE_VERSION, ...input };
}

/** 表ごとの指紋。その表の本文 (列・インデックス) と、その表が持つ外部キーが対象。 */
export function tableFingerprints(
  tables: readonly SchemaDocTable[],
  foreignKeys: readonly SchemaDocForeignKey[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tables) {
    const text = buildSchemaDocContextText({
      tables: [t],
      foreignKeys: foreignKeys.filter((fk) => fk.table === t.name),
      objects: [],
    });
    out[t.name] = fingerprint(text);
  }
  return out;
}

/** ビュー / ルーチンの定義の指紋 (マスク前の定義で比べる。定義が無いものは名前だけ)。 */
export function objectsFingerprint(objects: readonly SchemaDocObject[]): string {
  return fingerprint(JSON.stringify(objects.map((o) => [o.kind, o.name, o.definition ?? ""])));
}

/** 本文中の `### 表名` の節 (行番号は半開区間 `[start, end)`)。 */
export interface TableSection {
  name: string;
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

/** 見出しテキストから表名を取り出す (バッククォート・`(view)` 付記・括弧の別表記を外す)。 */
function headingTableName(text: string): string {
  return text
    .replace(/\s*[（(](?:view|ビュー)[)）]\s*$/i, "")
    .replace(/^`(.*)`$/, "$1")
    .trim();
}

/**
 * 本文から、`names` に含まれる表の `### 表名` の節を探す。節は次の見出し (レベル 1〜3) まで。
 * コードフェンス内の `#` は見出しとして扱わない。
 */
export function splitTableSections(body: string, names: readonly string[]): TableSection[] {
  const known = new Set(names);
  const lines = body.split("\n");
  const sections: TableSection[] = [];
  let open: { name: string; start: number } | null = null;
  let fence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = HEADING.exec(line);
    if (!m) return;
    const level = m[1].length;
    if (level > 3) return;
    if (open) {
      sections.push({ name: open.name, start: open.start, end: i });
      open = null;
    }
    if (level === 3) {
      const name = headingTableName(m[2]);
      if (known.has(name)) open = { name, start: i };
    }
  });
  if (open) {
    const o: { name: string; start: number } = open;
    sections.push({ name: o.name, start: o.start, end: lines.length });
  }
  return sections;
}

export type IncrementalPlan =
  | {
      mode: "full";
      reason: "noCache" | "incompatible" | "objectsChanged" | "tooMany" | "noSections";
    }
  | { mode: "none"; reused: number }
  | {
      mode: "incremental";
      /** 指紋が変わった / 新しい表。 */
      changed: string[];
      /** 実際に AI に作り直させる表 (変更 + その外部キーの参照先 + 前回の節が無い表)。 */
      regenerate: string[];
      /** 前回にあって今回のスコープに無い表 (節を取り除く)。 */
      removed: string[];
      /** 前回の節をそのまま使う表の数。 */
      reused: number;
    };

export interface IncrementalPlanInput {
  cached: CachedSchemaDoc | null;
  locale: "ja" | "en";
  driver: string;
  maskLiterals: boolean;
  objectsFp: string;
  /** 今回のスコープの表 (並び順どおり)。 */
  tableNames: readonly string[];
  hashes: Record<string, string>;
  /** 今回のスコープ内の外部キー。 */
  foreignKeys: readonly SchemaDocForeignKey[];
}

/** 差分で作れるかを決め、作り直す表 / 取り除く表 / 再利用する表を割り出す。 */
export function planIncremental(input: IncrementalPlanInput): IncrementalPlan {
  const { cached } = input;
  if (cached === null) return { mode: "full", reason: "noCache" };
  if (
    cached.locale !== input.locale ||
    cached.driver !== input.driver ||
    cached.maskLiterals !== input.maskLiterals
  ) {
    return { mode: "full", reason: "incompatible" };
  }
  if (cached.objectsFp !== input.objectsFp) return { mode: "full", reason: "objectsChanged" };
  const prevNames = Object.keys(cached.hashes);
  const withSection = new Set(splitTableSections(cached.body, prevNames).map((s) => s.name));
  if (withSection.size === 0) return { mode: "full", reason: "noSections" };

  const current = new Set(input.tableNames);
  const changed = input.tableNames.filter((n) => cached.hashes[n] !== input.hashes[n]);
  const removed = prevNames.filter((n) => !current.has(n));
  const regenerate = new Set(changed);
  // 変わった表の外部キーの参照先 (親) も、関係の説明が変わりうるので作り直す。
  for (const fk of input.foreignKeys) {
    if (regenerate.has(fk.table) && current.has(fk.referenced_table)) regenerate.add(fk.referenced_table);
  }
  // 指紋は同じでも前回の本文に節が見つからない表は、再利用できないので作り直す。
  for (const n of input.tableNames) if (!withSection.has(n)) regenerate.add(n);

  if (regenerate.size === 0 && removed.length === 0) {
    return { mode: "none", reused: input.tableNames.length };
  }
  if (regenerate.size > input.tableNames.length * SCHEMA_DOC_INCREMENTAL_MAX_RATIO) {
    return { mode: "full", reason: "tooMany" };
  }
  const ordered = input.tableNames.filter((n) => regenerate.has(n));
  return {
    mode: "incremental",
    changed,
    regenerate: ordered,
    removed,
    reused: input.tableNames.length - ordered.length,
  };
}

/** 差分用の system プロンプト。作り直す表のスキーマだけを載せ、節だけを返させる。 */
export function buildSchemaDocIncrementalSystem(input: {
  driver: string;
  database: string | null;
  locale: "ja" | "en";
  /** 作り直す表 (インデックス込み)。 */
  context: SchemaDocContext;
  /** それ以外の表の名前 (関係の説明の参照用)。 */
  otherTables: readonly string[];
  mask: { driver: string; maskLiterals: boolean };
}): string {
  const lang = input.locale === "ja" ? "Japanese" : "English";
  const dialect = dialectLabel(input.driver);
  const names = input.context.tables.map((t) => t.name);
  const others = input.otherTables.slice(0, OTHER_TABLES_MAX);
  const lines = [
    `You are a senior ${dialect} database engineer updating one part of an existing schema document. Target dialect: ${dialect}. Write in ${lang}.`,
    "Answer with Markdown only: no preamble, no closing remarks, and do not wrap the answer in a code fence.",
    "Write exactly one level-3 section per table listed below, in the given order. Each section starts with a heading line `### <table name>` using the exact table name (append ` (view)` for views), then its estimated role, a column table (name, type, nullable, key, estimated meaning), and its indexes when given.",
    "Do not write any other heading, an overview, a table list or a relationships chapter.",
    "Rules:",
    "- Use only the tables, columns, indexes and foreign keys listed below. Never invent names.",
    "- Meanings are inferred from names, types, keys and comments. Mark inferred statements as such and use the given comments verbatim where they exist.",
    "- You are given only the schema. Never claim anything about row contents, row counts or actual values.",
    "",
    input.database ? `Database: ${input.database}` : "Database: (default)",
    `Tables to document (${names.length}): ${names.join(", ")}`,
  ];
  if (others.length > 0) {
    lines.push(
      `Other tables in the database (names only, for reference when describing relations${
        input.otherTables.length > others.length ? "; list truncated" : ""
      }): ${others.join(", ")}`,
    );
  }
  lines.push(buildSchemaDocContextText(input.context, input.mask));
  return lines.join("\n");
}

/** 差分用のユーザプロンプト。 */
export function buildSchemaDocIncrementalPrompt(locale: "ja" | "en", names: readonly string[]): string {
  return locale === "ja"
    ? `上記の ${names.length} 表について、表ごとの詳細の節 (### 表名) だけを Markdown で書いてください。`
    : `Write only the per-table detail sections (### table name) for the ${names.length} tables above, as Markdown.`;
}

export interface MergeInput {
  /** 前回の本文。 */
  prevBody: string;
  /** 差分で得た本文 (`### 表名` の節だけのはず)。 */
  newBody: string;
  /** 今回のスコープの表 (並び順どおり)。 */
  order: readonly string[];
  /** 今回の差分で作り直しを依頼した表。 */
  regenerate: readonly string[];
  /** 取り除く表。 */
  removed: readonly string[];
}

export interface MergeResult {
  body: string;
  /** 新しい節に差し替えた (または追加した) 表。 */
  updated: string[];
  /** AI が節を返さなかったため前回のまま残した表 (前回にも無ければ載らない)。 */
  missing: string[];
}

/** 前回の本文の `### 表名` の節を、差分で得た節で差し替える。取り除く表の節は消す。 */
export function mergeTableSections(input: MergeInput): MergeResult {
  const prevLines = input.prevBody.split("\n");
  const prevSections = splitTableSections(input.prevBody, [...new Set([...input.order, ...input.removed])]);
  const fresh = new Map<string, string[]>();
  const newLines = input.newBody.split("\n");
  for (const s of splitTableSections(input.newBody, input.regenerate)) {
    if (!fresh.has(s.name)) fresh.set(s.name, trimBlank(newLines.slice(s.start, s.end)));
  }
  const removed = new Set(input.removed);
  const prevByName = new Map(prevSections.map((s) => [s.name, s]));
  const updated: string[] = [];
  const missing: string[] = [];
  for (const n of input.regenerate) {
    if (fresh.has(n)) updated.push(n);
    else missing.push(n);
  }

  // 前回の本文を走査しながら、節ごとに「そのまま / 差し替え / 削除」する。
  const out: string[] = [];
  const emitted = new Set<string>();
  const insertAfter = new Map<string, string[]>();
  // 前回に無い新しい表は、並び順で直前にある表の節の後ろへ入れる (直前が無ければ最初の節の前)。
  const pending = input.order.filter((n) => fresh.has(n) && !prevByName.has(n));
  const firstSection = prevSections[0];
  const beforeFirst: string[] = [];
  for (const n of pending) {
    let anchor: string | null = null;
    for (const m of input.order) {
      if (m === n) break;
      if (prevByName.has(m) && !removed.has(m)) anchor = m;
    }
    if (anchor === null) beforeFirst.push(n);
    else insertAfter.set(anchor, [...(insertAfter.get(anchor) ?? []), n]);
  }
  const pushSection = (name: string) => {
    const lines = fresh.get(name);
    if (!lines || emitted.has(name)) return;
    emitted.add(name);
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    out.push(...lines, "");
  };
  const flushAfter = (name: string) => {
    for (const n of insertAfter.get(name) ?? []) pushSection(n);
    // 追加した節が連鎖して別の節の「直前」になる場合のため、追加分の後ろも見る。
    for (const n of insertAfter.get(name) ?? []) flushAfter(n);
  };

  let i = 0;
  const byStart = new Map(prevSections.map((s) => [s.start, s]));
  while (i < prevLines.length) {
    if (firstSection && i === firstSection.start) for (const n of beforeFirst) pushSection(n);
    const sec = byStart.get(i);
    if (!sec) {
      out.push(prevLines[i]);
      i++;
      continue;
    }
    if (removed.has(sec.name)) {
      // 取り除く: 節の行を出さない。
    } else if (fresh.has(sec.name)) {
      pushSection(sec.name);
    } else {
      out.push(...prevLines.slice(sec.start, sec.end));
      emitted.add(sec.name);
    }
    flushAfter(sec.name);
    i = sec.end;
  }
  // 節が 1 つも無かった本文なら、末尾へ追記する。
  if (prevSections.length === 0) for (const n of pending) pushSection(n);
  return {
    body: out
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    updated,
    missing,
  };
}

function trimBlank(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].trim() === "") a++;
  while (b > a && lines[b - 1].trim() === "") b--;
  return lines.slice(a, b);
}
