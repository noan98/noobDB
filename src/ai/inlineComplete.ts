// エディタの AI インライン補完 (#1479) の純ロジック: 送信可否の判定・送信範囲の切り出し・
// プロンプト組み立て・応答の整形・結果キャッシュ。副作用 (タイマー・IPC・CodeMirror) は
// `components/inlineCompleteExtension.ts` が持つ。
// 行データは扱わない。送るのはカーソル前後の SQL と、そこに出てくるテーブルのスキーマだけ。

import { maskLiterals } from "../dangerousSql";
import { dialectLabel, needsSendScopeConfirm } from "./errorExplain";

/** 補完に渡すテーブル (名前と列名)。nl2sql の型には依存しない。 */
export interface InlineTable {
  name: string;
  columns: string[];
}

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
  /** エディタ全文 (窓で切る前。字句状態をずらさないため、マスクは文頭から掛ける)。 */
  doc: string;
  /** カーソル位置 (ドキュメントオフセット)。 */
  pos: number;
  driver: string;
  maskLiterals: boolean;
  /** エディタが補完用に持っているスキーマ。 */
  tables: InlineTable[];
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

/** 窓の中に出てくるテーブル名に一致するスキーマだけを選ぶ (大小無視・上限あり。結果は名前順)。 */
export function relevantTables(text: string, tables: InlineTable[]): InlineTable[] {
  const byName = new Map<string, InlineTable>();
  for (const t of tables) {
    const k = t.name.toLowerCase();
    if (!byName.has(k)) byName.set(k, t);
  }
  const seen = new Set<string>();
  const out: InlineTable[] = [];
  for (const m of text.matchAll(IDENT_RE)) {
    const k = m[0].toLowerCase();
    const t = byName.get(k);
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: t.name, columns: t.columns.slice(0, INLINE_MAX_COLUMNS) });
    if (out.length >= INLINE_MAX_TABLES) break;
  }
  // systemCached は先頭一致でキャッシュされるので、出現順ではなく名前順に固定する。
  return out.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
}

/**
 * カーソルが文字列リテラル / コメントの内側か。文書全体のカーソル位置に識別子文字を差し込んでマスクし、
 * それが空白に潰されるかで判定する (マスク設定・カーソル直前の空白に依らない)。
 * 文書全体を見るのは、PostgreSQL のドル引用 (`$$…$$`) が閉じタグが見つかったときだけ
 * 文字列として扱われるため (文頭〜カーソルだけだと閉じタグが見えず「外側」と誤判定する)。
 */
function insideLiteralOrComment(doc: string, pos: number, driver: string): boolean {
  const probe = maskLiterals(`${doc.slice(0, pos)}Z${doc.slice(pos)}`, driver, {
    keepQuotedIdentifiers: true,
    cache: false,
  });
  return probe[pos] === " ";
}

/**
 * 問い合わせの内容を組み立てる。送らないと決めたら null
 * (入力が短い・単語の途中・リテラル / コメントの中)。
 * マスクは文書全体に掛けてから窓で切る (`maskLiterals` は長さを保つ)。
 * 窓で切ってからマスクすると、切り口が複数行リテラル / ブロックコメントの途中に来たときに
 * 字句状態が反転し、リテラルの中身が素で送られてしまう。窓の終わりで切っても、閉じタグが窓の外にある
 * ドル引用 (`$$…$$`) が文字列と認識されず中身が素で送られる。
 */
export function buildInlineRequest(input: InlineContextInput): InlineRequestParts | null {
  const pos = Math.max(0, Math.min(input.pos, input.doc.length));
  const rawBefore = tailWindow(input.doc.slice(0, pos), INLINE_BEFORE_MAX_LINES, INLINE_BEFORE_MAX_CHARS);
  const rawAfter = headWindow(
    input.doc.slice(pos, pos + INLINE_AFTER_MAX_CHARS),
    INLINE_AFTER_MAX_LINES,
    INLINE_AFTER_MAX_CHARS,
  );
  if (rawBefore.replace(/\s/g, "").length < INLINE_MIN_CHARS) return null;
  // 単語の途中 (直後が識別子文字) では続きを出さない。
  if (/^[\w$]/.test(rawAfter)) return null;
  // リテラル / コメントの中身への補完は無意味。マスク設定がオフでも出さない。
  if (insideLiteralOrComment(input.doc, pos, input.driver)) return null;

  let before = rawBefore;
  let after = rawAfter;
  if (input.maskLiterals) {
    const maskedAll = maskLiterals(input.doc, input.driver, {
      keepQuotedIdentifiers: true,
      cache: false,
    });
    before = tailWindow(maskedAll.slice(0, pos), INLINE_BEFORE_MAX_LINES, INLINE_BEFORE_MAX_CHARS);
    after = headWindow(maskedAll.slice(pos), INLINE_AFTER_MAX_LINES, INLINE_AFTER_MAX_CHARS);
  }
  const masked = before + after;

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
    tables.map((t) => `- ${t.name}(${t.columns.join(", ")})`).join("\n"),
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
