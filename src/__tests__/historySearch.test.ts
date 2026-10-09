import { describe, expect, it } from "vitest";
import {
  buildHistorySearchPrompt,
  buildHistorySearchSystem,
  buildHistorySummaryPrompt,
  candidateSql,
  describeCandidateScope,
  formatCandidates,
  HISTORY_SEARCH_FORMAT,
  HISTORY_SEARCH_MAX_CANDIDATES,
  HISTORY_SEARCH_MAX_SQL_CHARS,
  HISTORY_SEARCH_MAX_TOTAL_CHARS,
  limitCandidates,
  parseHistorySearchResponse,
  type HistoryCandidate,
} from "../ai/historySearch";

function cand(id: number, sql = "SELECT 1", over: Partial<HistoryCandidate> = {}): HistoryCandidate {
  return {
    id,
    sql,
    executedAt: "2026-01-01T00:00:00Z",
    status: "ok",
    connection: "Prod",
    driver: "mysql",
    database: "app",
    ...over,
  };
}

describe("candidateSql / formatCandidates (#699)", () => {
  it("マスク有効なら文字列リテラルの中身を送らない", () => {
    const sql = "SELECT * FROM users WHERE email = 'secret@example.com'";
    expect(candidateSql({ sql, driver: "mysql" }, true)).not.toContain("secret@example.com");
    expect(candidateSql({ sql, driver: "mysql" }, false)).toContain("secret@example.com");
    const f = formatCandidates([cand(1, sql)], true);
    expect(f.text).not.toContain("secret@example.com");
    expect(f.text).toContain("[id=1]");
    expect(f.text).toContain("conn=Prod");
  });

  it("1 件あたりの文字数上限で切り詰める", () => {
    const long = `SELECT ${"a, ".repeat(2000)} FROM t`;
    const out = candidateSql({ sql: long, driver: "mysql" }, false);
    expect(out.length).toBe(HISTORY_SEARCH_MAX_SQL_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("件数上限を超えると先頭 (新しい側) を残して overflow を立てる", () => {
    const many = Array.from({ length: HISTORY_SEARCH_MAX_CANDIDATES + 5 }, (_, i) => i);
    const r = limitCandidates(many);
    expect(r.items).toHaveLength(HISTORY_SEARCH_MAX_CANDIDATES);
    expect(r.items[0]).toBe(0);
    expect(r.overflow).toBe(true);
    expect(limitCandidates([1, 2]).overflow).toBe(false);
  });

  it("合計文字数上限で古い候補を打ち切る", () => {
    const sql = `SELECT ${"x".repeat(900)}`;
    const n = Math.ceil(HISTORY_SEARCH_MAX_TOTAL_CHARS / sql.length) + 5;
    const f = formatCandidates(
      Array.from({ length: n }, (_, i) => cand(i + 1, sql)),
      false,
    );
    expect(f.truncated).toBe(true);
    expect(f.included.length).toBeLessThan(n);
    expect(f.included[0].id).toBe(1);
  });

  it("上限内なら truncated は false", () => {
    expect(formatCandidates([cand(1), cand(2)], false).truncated).toBe(false);
  });
});

describe("プロンプト (#699)", () => {
  it("検索プロンプトに依頼文と候補を含み、システムは言語を切り替える", () => {
    const f = formatCandidates([cand(7, "SELECT sum(x) FROM sales")], false);
    const p = buildHistorySearchPrompt({ query: " 先週の売上集計 ", candidates: f, now: new Date("2026-02-01T00:00:00Z") });
    expect(p).toContain("Request: 先週の売上集計");
    expect(p).toContain("[id=7]");
    expect(p).toContain("2026-02-01T00:00:00.000Z");
    expect(buildHistorySearchSystem("ja")).toContain("Japanese");
    expect(buildHistorySearchSystem("en")).toContain("English");
  });

  it("サマリのプロンプトに期間ラベルを含む", () => {
    const f = formatCandidates([cand(1)], false);
    expect(buildHistorySummaryPrompt({ periodLabel: "Today", candidates: f })).toContain("Period: Today");
  });

  it("構造化スキーマは additionalProperties:false で history_id が文字列", () => {
    const item = HISTORY_SEARCH_FORMAT.schema.properties.matches.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.history_id.type).toBe("string");
    expect(item.properties.relevance.type).toBe("integer");
  });
});

describe("parseHistorySearchResponse (#699)", () => {
  const allowed = new Set([1, 2, 3]);
  const body = (matches: unknown[]) => JSON.stringify({ matches });

  it("候補に無い id を捨て、relevance 降順に並べる", () => {
    const r = parseHistorySearchResponse(
      body([
        { history_id: "1", relevance: 40, reason: "a" },
        { history_id: "999", relevance: 100, reason: "unknown" },
        { history_id: "3", relevance: 90, reason: "c" },
      ]),
      allowed,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.matches.map((m) => m.historyId)).toEqual([3, 1]);
  });

  it("重複 id は先頭のみ・数値でない id は捨て・relevance は 0-100 に丸める・同点は応答順", () => {
    const r = parseHistorySearchResponse(
      body([
        { history_id: "2", relevance: 150, reason: " x " },
        { history_id: "2", relevance: 10, reason: "dup" },
        { history_id: "abc", relevance: 50, reason: "bad" },
        { history_id: "1", relevance: 100, reason: "y" },
        { history_id: "3", relevance: -5, reason: "z" },
      ]),
      allowed,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.matches.map((m) => [m.historyId, m.relevance])).toEqual([
        [2, 100],
        [1, 100],
        [3, 0],
      ]);
      expect(r.matches[0].reason).toBe("x");
    }
  });

  it("コードフェンスを許容し、壊れた JSON / 形違いは raw を返す", () => {
    const fenced = "```json\n" + body([{ history_id: "1", relevance: 5, reason: "r" }]) + "\n```";
    expect(parseHistorySearchResponse(fenced, allowed).ok).toBe(true);
    expect(parseHistorySearchResponse("nope", allowed)).toEqual({ ok: false, raw: "nope" });
    expect(parseHistorySearchResponse('{"matches":[{"history_id":"1"}]}', allowed).ok).toBe(false);
  });

  it("空配列は ok で 0 件", () => {
    expect(parseHistorySearchResponse(body([]), allowed)).toEqual({ ok: true, matches: [] });
  });
});

describe("describeCandidateScope (#699)", () => {
  it("件数・接続・期間・本番の有無をまとめる", () => {
    const s = describeCandidateScope(
      [
        { executedAt: "2026-01-03T00:00:00Z", connection: "Prod" },
        { executedAt: "2026-01-01T00:00:00Z", connection: "Dev" },
        { executedAt: "2026-01-02T00:00:00Z", connection: "Prod" },
      ],
      new Set(["Prod"]),
    );
    expect(s).toEqual({
      count: 3,
      connections: ["Prod", "Dev"],
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-03T00:00:00Z",
      includesProduction: true,
    });
    expect(describeCandidateScope([], new Set()).from).toBeNull();
  });
});
