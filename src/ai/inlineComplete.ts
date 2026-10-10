// エディタの AI インライン補完 (#1479) の純ロジック: 送信可否の判定・送信範囲の切り出し・
// プロンプト組み立て・応答の整形・結果キャッシュ。副作用 (タイマー・IPC・CodeMirror) は
// `components/inlineCompleteExtension.ts` が持つ。
// 行データは扱わない。送るのはカーソル前後の SQL と、そこに出てくるテーブルのスキーマだけ。

import { sqlForAi, dialectLabel, needsSendScopeConfirm } from "./errorExplain";
import { buildSchemaText, type Nl2SqlTable } from "./nl2sql";

/** 入力が止まってから問い合わせるまでの待ち (ms)。 */
export const INLINE_DEBOUNCE_MS = 600;
/** これを超えて応答が来なければ提案を出さない (ms)。 */
export const INLINE_TIMEOUT_MS = 3000;
/** 問い合わせに必要な、カーソル前の最小文字数 (空白除く)。 */
export const INLINE_MIN_CHARS = 3;
/** カーソル前に送る上限 (行数 / 文字数)。 */
export const INLINE_BEFORE_MAX_LINES = 40;
export const INLINE_BEFORE_MAX_CHARS = 4096;
/** カーソル後に送る上限 (行数 / 文字数)。 */
export const INLINE_AFTER_MAX_LINES = 10;
export const INLINE_AFTER_MAX_CHARS = 1024;
/** スキーマとして送るテーブル数 / 1 テーブルあたりの列数の上限。 */
export const INLINE_MAX_TABLES = 8;
export const INLINE_MAX_COLUMNS = 60;
/** 提案として表示する最大の長さ。 */
export const INLINE_MAX_SUGGESTION_CHARS = 400;
export const INLINE_MAX_SUGGESTION_LINES = 6;
/** 同一入力の結果キャッシュの件数。 */
export const INLINE_CACHE_ENTRIES = 20;

export interface InlineGateInput {
  /** 機能単体のオン / オフ (`ai.inlineComplete`)。 */
  featureEnabled: boolean;
  /** AI が有効かつキー登録済み (`useAiAvailable`)。 */
  aiAvailable: boolean;
  /** 送信範囲 (`ai.sendScope`)。 */
  sendScope: string;
  /** 本番接続か。確認ダイアログを出せないので本番では送らない。 */
  isProduction: boolean;
}

/**
 * 補完を動かしてよいか。1 つでも満たさなければ一切送らない。
 * SQL 本文を送る機能なので、送信範囲が `schemaAndSql` のときだけ動く
 * (入力のたびに確認ダイアログを出すことはできないため)。
 */
export function inlineCompleteAllowed(input: InlineGateInput): boolean {
  return (
    input.featureEnabled &&
    input.aiAvailable &&
    !input.isProduction &&
    !needsSendScopeConfirm(input.sendScope)
  );
}

export interface InlineContextInput {
  /** エディタ全文。 */
  doc: string;
  /** カーソル位置 (ドキュメントオフセット)。 */
  pos: number;
  driver: string;
  maskLiterals: boolean;
  /** エディタが補完用に持っているスキーマ。 */
  tables: Nl2SqlTable[];
  database: string | null;
}

export interface InlineRequestParts {
  /** system のうち固定の部分 (規則 + 関連スキーマ)。`systemCached` に入れる。 */
  systemCached: string;
  prompt: string;
  /** 同一入力の判定に使うキー。 */
  cacheKey: string;
}

/** 末尾から最大 `maxLines` 行 / `maxChars` 文字を残す。 */
export function tailWindow(text: string, maxLines: number, maxChars: number): string {
  let out = text;
  if (out.length > maxChars) out = out.slice(out.length - maxChars);
  const lines = out.split("\n");
  if (lines.length > maxLines) out = lines.slice(lines.length - maxLines).join("\n");
  return out;
}

/** 先頭から最大 `maxLines` 行 / `maxChars` 文字を残す。 */
export function headWindow(text: string, maxLines: number, maxChars: number): string {
  let out = text;
  if (out.length > maxChars) out = out.slice(0, maxChars);
  const lines = out.split("\n");
  if (lines.length > maxLines) out = lines.slice(0, maxLines).join("\n");
  return out;
}

/** カーソル前後の窓 (マスク前)。 */
export function sliceInlineWindow(doc: string, pos: number): { before: string; after: string } {
  const p = Math.max(0, Math.min(pos, doc.length));
  return {
    before: tailWindow(doc.slice(0, p), INLINE_BEFORE_MAX_LINES, INLINE_BEFORE_MAX_CHARS),
    after: headWindow(doc.slice(p), INLINE_AFTER_MAX_LINES, INLINE_AFTER_MAX_CHARS),
  };
}

const IDENT_RE = /[A-Za-z_\u0080-￿][\w$\u0080-￿]*/g;

/** 窓の中に出てくるテーブル名に一致するスキーマだけを選ぶ (大小無視・出現順・上限あり)。 */
export function relevantTables(text: string, tables: Nl2SqlTable[]): Nl2SqlTable[] {
  const byName = new Map<string, Nl2SqlTable>();
  for (const t of tables) {
    const k = t.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, t);
  }
  const seen = new Set<string>();
  const out: Nl2SqlTable[] = [];
  for (const m of text.matchAll(IDENT_RE)) {
    const k = m[0].toLowerCase();
    const t = byName.get(k);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: t.name, columns: t.columns.slice(0, INLINE_MAX_COLUMNS) });
    if (out.length >= INLINE_MAX_TABLES) break;
  }
  return out;
}

/**
 * カーソルが文字列リテラル / コメントの内側か (マスク前後で、カーソル直前の非空白が空白に
 * 変わっているかで判定する)。リテラルの中身への補完は無意味で、値を送る危険もあるので問い合わせない。
 */
function insideMaskedRegion(original: string, masked: string): boolean {
  const i = original.length - 1;
  if (i < 0) return false;
  return original[i].trim() !== "" && masked[i].trim() === "";
}

/**
 * 問い合わせの内容を組み立てる。送らないと決めたら null
 * (入力が短い・単語の途中・リテラル / コメントの中)。
 * マスクは窓全体にかけてからカーソル位置で分ける (`maskLiterals` は長さを保つ)。
 */
export function buildInlineRequest(input: InlineContextInput): InlineRequestParts | null {
  const { before: rawBefore, after: rawAfter } = sliceInlineWindow(input.doc, input.pos);
  if (rawBefore.replace(/\s/g, "").length < INLINE_MIN_CHARS) return null;
  // 単語の途中 (直後が識別子文字) では続きを出さない。
  if (/^[\w$]/.test(rawAfter)) return null;

  const whole = rawBefore + rawAfter;
  const masked = sqlForAi(whole, input.driver, input.maskLiterals);
  const before = masked.slice(0, rawBefore.length);
  const after = masked.slice(rawBefore.length);
  if (input.maskLiterals && insideMaskedRegion(rawBefore, before)) return null;

  const tables = relevantTables(masked, input.tables);
  const dialect = dialectLabel(input.driver);
  const systemCached = [
    `You are an inline SQL autocompletion engine for ${dialect}.`,
    "You receive the text before the cursor and the text after it. Reply with ONLY the text to insert at the cursor.",
    "No code fences, no explanations, no quotes around the answer. Do not repeat text that is already before the cursor.",
    "Keep it short: finish the current statement or clause (at most a few lines). Reply with an empty string when unsure.",
    "Use only the tables and columns listed below when they are relevant; never invent names or literal values.",
    "String literals and comments in the input may be blanked out for privacy.",
    "",
    input.database ? `Database: ${input.database}` : "Database: (default)",
    tables.length > 0 ? "Tables (name(columns)):" : "Tables: (none matched)",
    buildSchemaText(tables, []),
  ].join("\n");
  const prompt = ["<before_cursor>", before, "</before_cursor>", "<after_cursor>", after, "</after_cursor>"].join(
    "\n",
  );
  return { systemCached, prompt, cacheKey: `${input.driver}\u0000${systemCached}\u0000${prompt}` };
}

/**
 * 応答を挿入テキストに整える: コードフェンス・前置き行の除去、カーソル前の最終行の重複除去、
 * 長さの上限。使えないものは空文字を返す (提案を出さない)。
 */
export function cleanInlineCompletion(raw: string, before: string): string {
  let text = raw.replace(/\r\n/g, "\n");
  // ```sql ... ``` で囲まれていれば中身だけ取る (閉じ忘れも許容)。
  const fenced = /^\s*```[\w-]*\n?([\s\S]*?)(?:\n?```\s*)?$/.exec(text);
  if (fenced) text = fenced[1];
  // 「Here is ...:」のような前置き 1 行。
  text = text.replace(/^\s*(?:here(?:'s| is| are)[^\n]*|sure[,!.][^\n]*|以下[^\n]*)\n/i, "");
  // 前後を囲む 1 組のバッククォートは外す。
  const quoted = /^`([^`\n]+)`$/.exec(text.trim());
  if (quoted) text = quoted[1];
  // カーソル前の最終行を繰り返して返してきたときは、その分を落とす。
  const lastLine = before.slice(before.lastIndexOf("\n") + 1).trimStart();
  if (lastLine.length >= INLINE_MIN_CHARS) {
    const lead = text.trimStart();
    if (lead.startsWith(lastLine)) text = lead.slice(lastLine.length);
  }
  if (text.trim() === "") return "";
  const lines = text.split("\n");
  if (lines.length > INLINE_MAX_SUGGESTION_LINES) text = lines.slice(0, INLINE_MAX_SUGGESTION_LINES).join("\n");
  if (text.length > INLINE_MAX_SUGGESTION_CHARS) text = text.slice(0, INLINE_MAX_SUGGESTION_CHARS);
  return text.replace(/\s+$/, "");
}

/** 同一入力の結果を直近 N 件だけ覚える (挿入順 = 古い順に捨てる)。 */
export class InlineCompleteCache {
  private readonly map = new Map<string, string>();
  constructor(private readonly capacity = INLINE_CACHE_ENTRIES) {}

  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    // 使われたものを新しい側へ。
    this.map.delete(key);
    this.map.set(key, hit);
    return hit;
  }

  set(key: string, value: string): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** 提案の状態。`null` = 提案なし。 */
export interface InlineSuggestion {
  pos: number;
  text: string;
}

/**
 * 提案を出してよいか。応答が遅すぎる・カーソルが動いた・文書が変わった・空のときは出さない。
 */
export function shouldShowSuggestion(args: {
  text: string;
  requestPos: number;
  currentPos: number;
  selectionEmpty: boolean;
  docVersionUnchanged: boolean;
  elapsedMs: number;
}): boolean {
  return (
    args.text !== "" &&
    args.requestPos === args.currentPos &&
    args.selectionEmpty &&
    args.docVersionUnchanged &&
    args.elapsedMs <= INLINE_TIMEOUT_MS
  );
}
