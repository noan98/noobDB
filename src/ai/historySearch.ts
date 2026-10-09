// クエリ履歴の自然言語検索と作業サマリ (#699) の純ロジック:
// 候補の整形 (マスク・文字数上限)・プロンプト・応答パース・ランク付け。
// 副作用 (IPC・状態管理) は `components/AiHistorySearch.tsx` が持つ。

import { z } from "zod";
import { dialectLabel, sqlForAi } from "./errorExplain";

/** モデルへ渡す候補の最大件数。超える分は送らず、期間で絞るよう案内する。 */
export const HISTORY_SEARCH_MAX_CANDIDATES = 300;
/** 1 件あたりの SQL 文字数上限 (超過分は `…` で切り詰める)。 */
export const HISTORY_SEARCH_MAX_SQL_CHARS = 1000;
/** 全候補の SQL 文字数の合計上限。超えたら新しい候補を優先して打ち切る。 */
export const HISTORY_SEARCH_MAX_TOTAL_CHARS = 100_000;
/** 結果として表示する最大件数。 */
export const HISTORY_SEARCH_MAX_RESULTS = 30;

/** 構造化出力で受け取る応答の形 (`run_ai_request` の `format` にそのまま渡す)。 */
export const HISTORY_SEARCH_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        items: {
          type: "object",
          properties: {
            history_id: { type: "string" },
            relevance: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["history_id", "relevance", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["matches"],
    additionalProperties: false,
  },
} as const;

/** 整形前の候補 1 件 (SQL 全文は呼び出し側が `get_history_sql` で取得済み)。 */
export interface HistoryCandidate {
  id: number;
  sql: string;
  /** RFC3339。 */
  executedAt: string;
  /** `ok` / `error`。 */
  status: string;
  /** 接続名 (不明なら空文字)。 */
  connection: string;
  /** `mysql` / `postgres` / `sqlite`。マスクと方言表示に使う。 */
  driver: string;
  database: string | null;
}

export interface FormattedCandidates {
  /** プロンプトに載せた候補 (id の集合が「候補に有る id」)。 */
  included: HistoryCandidate[];
  /** プロンプトに載せる本文 (候補ブロックの連結)。 */
  text: string;
  /** 件数上限・文字数上限のどちらかで候補を落としたか。 */
  truncated: boolean;
}

/** 候補を上限 (件数) で切る。入力は新しい順を想定し、先頭から残す。 */
export function limitCandidates<T>(items: readonly T[]): { items: T[]; overflow: boolean } {
  return {
    items: items.slice(0, HISTORY_SEARCH_MAX_CANDIDATES),
    overflow: items.length > HISTORY_SEARCH_MAX_CANDIDATES,
  };
}

/** SQL の空白を畳み、マスクを適用し、1 件あたりの上限で切り詰める。 */
export function candidateSql(c: Pick<HistoryCandidate, "sql" | "driver">, mask: boolean): string {
  const masked = sqlForAi(c.sql, c.driver, mask).replace(/\s+/g, " ").trim();
  return masked.length > HISTORY_SEARCH_MAX_SQL_CHARS
    ? `${masked.slice(0, HISTORY_SEARCH_MAX_SQL_CHARS)}…`
    : masked;
}

/**
 * 候補をプロンプト用に整形する。件数上限 → マスク → 1 件の文字数上限 → 合計文字数上限の順。
 * 合計上限を超えた時点で以降 (より古い候補) を打ち切る。
 */
export function formatCandidates(
  candidates: readonly HistoryCandidate[],
  mask: boolean,
): FormattedCandidates {
  const { items, overflow } = limitCandidates(candidates);
  const included: HistoryCandidate[] = [];
  const blocks: string[] = [];
  let total = 0;
  let truncated = overflow;
  for (const c of items) {
    const sql = candidateSql(c, mask);
    if (total + sql.length > HISTORY_SEARCH_MAX_TOTAL_CHARS) {
      truncated = true;
      break;
    }
    total += sql.length;
    included.push(c);
    const meta = [
      c.executedAt,
      c.status,
      c.connection ? `conn=${c.connection}` : "",
      c.database ? `db=${c.database}` : "",
      dialectLabel(c.driver),
    ].filter(Boolean);
    blocks.push(`[id=${c.id}] ${meta.join(" | ")}\n${sql}`);
  }
  return { included, text: blocks.join("\n\n"), truncated };
}

export function buildHistorySearchSystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You search a user's SQL query history for the entries that best match a natural-language request.",
    "Each candidate is given as `[id=N] <time> | <status> | <connection> | <db> | <dialect>` followed by its SQL.",
    "Return only candidates that really match the request, ranked by relevance (0-100, higher is better).",
    "history_id MUST be one of the given ids, as a string. Never invent ids. Return at most " +
      `${HISTORY_SEARCH_MAX_RESULTS} matches; return an empty array when nothing matches.`,
    `reason: one short sentence in ${lang} explaining why it matches.`,
    "Literal values in the SQL may be blanked out for privacy; never guess data values.",
    "Answer only with the JSON object described by the schema.",
  ].join("\n");
}

export function buildHistorySearchPrompt(input: {
  query: string;
  candidates: FormattedCandidates;
  now?: Date;
}): string {
  return [
    `Current time: ${(input.now ?? new Date()).toISOString()}`,
    `Request: ${input.query.trim()}`,
    "",
    "Candidates:",
    input.candidates.text,
  ].join("\n");
}

export function buildHistorySummarySystem(locale: "ja" | "en"): string {
  const lang = locale === "ja" ? "Japanese" : "English";
  return [
    "You write a work summary from a user's SQL query history, for a daily report or a handover note.",
    `Write in ${lang} as a concise bulleted list (one line per bullet, starting with "- ").`,
    "Group related queries into activities (what was investigated, changed, or fixed), mention the tables and connections involved, and note failed attempts only when meaningful.",
    "Do not paste SQL verbatim. Literal values in the SQL may be blanked out for privacy; never guess data values.",
    "Output plain text only, with no preamble.",
  ].join("\n");
}

export function buildHistorySummaryPrompt(input: {
  periodLabel: string;
  candidates: FormattedCandidates;
  now?: Date;
}): string {
  return [
    `Current time: ${(input.now ?? new Date()).toISOString()}`,
    `Period: ${input.periodLabel}`,
    "",
    "Queries (newest first):",
    input.candidates.text,
  ].join("\n");
}

const responseSchema = z.object({
  matches: z.array(
    z.object({
      history_id: z.union([z.string(), z.number()]),
      relevance: z.number(),
      reason: z.string(),
    }),
  ),
});

export interface HistorySearchMatch {
  historyId: number;
  relevance: number;
  reason: string;
}

export type ParsedHistorySearch =
  | { ok: true; matches: HistorySearchMatch[] }
  | { ok: false; raw: string };

/**
 * ストリームで結合した本文を検証してランク付けする。`allowedIds` (プロンプトに載せた候補)
 * に無い id・重複 id は捨て、relevance を 0-100 に丸めて降順 (同点は応答順) に並べる。
 */
export function parseHistorySearchResponse(
  text: string,
  allowedIds: ReadonlySet<number>,
): ParsedHistorySearch {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(body);
  if (fenced) body = fenced[1];
  try {
    const parsed = responseSchema.safeParse(JSON.parse(body));
    if (parsed.success) {
      const seen = new Set<number>();
      const matches: HistorySearchMatch[] = [];
      for (const m of parsed.data.matches) {
        const idStr = String(m.history_id).trim();
        if (!/^\d+$/.test(idStr)) continue;
        const id = Number(idStr);
        if (!allowedIds.has(id) || seen.has(id)) continue;
        seen.add(id);
        matches.push({
          historyId: id,
          relevance: Math.min(100, Math.max(0, Math.round(m.relevance))),
          reason: m.reason.trim(),
        });
      }
      const ranked = matches
        .map((m, i) => ({ m, i }))
        .sort((a, b) => b.m.relevance - a.m.relevance || a.i - b.i)
        .map((x) => x.m)
        .slice(0, HISTORY_SEARCH_MAX_RESULTS);
      return { ok: true, matches: ranked };
    }
  } catch {
    /* JSON でない */
  }
  return { ok: false, raw: text };
}

export interface CandidateScope {
  count: number;
  /** 候補に含まれる接続名 (重複なし、不明は除く)。 */
  connections: string[];
  /** 最古 / 最新の実行日時 (RFC3339)。候補 0 件なら null。 */
  from: string | null;
  to: string | null;
  /** `is_production` な接続の履歴を含むか。 */
  includesProduction: boolean;
}

/** 送信前の確認文に出す、対象件数・期間・接続の要約。 */
export function describeCandidateScope(
  candidates: readonly Pick<HistoryCandidate, "executedAt" | "connection">[],
  productionConnections: ReadonlySet<string>,
): CandidateScope {
  const conns = new Set<string>();
  let from: string | null = null;
  let to: string | null = null;
  let prod = false;
  for (const c of candidates) {
    if (c.connection) {
      conns.add(c.connection);
      if (productionConnections.has(c.connection)) prod = true;
    }
    const ms = Date.parse(c.executedAt);
    if (Number.isNaN(ms)) continue;
    if (from === null || ms < Date.parse(from)) from = c.executedAt;
    if (to === null || ms > Date.parse(to)) to = c.executedAt;
  }
  return { count: candidates.length, connections: [...conns], from, to, includesProduction: prod };
}
