import { describe, expect, it } from "vitest";
import {
  appendExchange,
  buildHistory,
  exchangesToMessages,
  historyBudget,
  MAX_HISTORY_EXCHANGES,
  MAX_PROMPT_BYTES,
  trimExchanges,
  type AiExchange,
} from "../ai/conversation";

const ex = (n: number, size = 1): AiExchange => ({ prompt: `q${n}`.padEnd(size, "x"), answer: `a${n}`.padEnd(size, "x") });

describe("会話履歴の組み立て (#1471)", () => {
  it("往復が無ければ履歴は空 (単発)", () => {
    expect(buildHistory([])).toEqual([]);
  });

  it("往復を user / assistant 交互に展開する", () => {
    expect(exchangesToMessages([ex(1), ex(2)])).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  it("直近 N 往復だけ残し、古いものから捨てる", () => {
    const all = Array.from({ length: 8 }, (_, i) => ex(i + 1));
    const kept = trimExchanges(all);
    expect(kept).toHaveLength(MAX_HISTORY_EXCHANGES);
    expect(kept[0].prompt).toBe("q4");
    expect(kept.at(-1)?.prompt).toBe("q8");
    expect(trimExchanges(all, { maxExchanges: 2 }).map((e) => e.prompt)).toEqual(["q7", "q8"]);
    expect(trimExchanges(all, { maxExchanges: 0 })).toEqual([]);
  });

  it("バイト数が予算を超える間は古い往復から往復単位で捨てる (交互は崩れない)", () => {
    const list = [ex(1, 100), ex(2, 100), ex(3, 100)]; // 1 往復 200 バイト
    expect(trimExchanges(list, { maxBytes: 600 })).toHaveLength(3);
    expect(trimExchanges(list, { maxBytes: 599 }).map((e) => e.prompt.slice(0, 2))).toEqual(["q2", "q3"]);
    expect(trimExchanges(list, { maxBytes: 200 }).map((e) => e.prompt.slice(0, 2))).toEqual(["q3"]);
    const msgs = buildHistory(list, { maxBytes: 450 });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("最新の 1 往復だけで予算を超えるなら履歴は空になる", () => {
    expect(buildHistory([ex(1, 100)], { maxBytes: 10 })).toEqual([]);
  });

  it("バイト数は UTF-8 で数える (日本語は 3 バイト/文字)", () => {
    const jp: AiExchange = { prompt: "あ".repeat(10), answer: "い".repeat(10) }; // 60 バイト
    expect(trimExchanges([jp], { maxBytes: 60 })).toHaveLength(1);
    expect(trimExchanges([jp], { maxBytes: 59 })).toHaveLength(0);
  });

  it("空のプロンプト / 回答の往復は含めない", () => {
    expect(buildHistory([{ prompt: " ", answer: "a" }, { prompt: "q", answer: "" }, ex(1)])).toHaveLength(2);
  });

  it("appendExchange は上限を超えた古い往復を捨て、元の配列を変えない", () => {
    const base = Array.from({ length: MAX_HISTORY_EXCHANGES }, (_, i) => ex(i + 1));
    const next = appendExchange(base, ex(99));
    expect(next).toHaveLength(MAX_HISTORY_EXCHANGES);
    expect(next[0].prompt).toBe("q2");
    expect(next.at(-1)?.prompt).toBe("q99");
    expect(base[0].prompt).toBe("q1");
  });

  it("historyBudget は system / プロンプト分を上限から引く (負にならない)", () => {
    expect(historyBudget()).toBe(MAX_PROMPT_BYTES);
    expect(historyBudget("abc", null, "あ")).toBe(MAX_PROMPT_BYTES - 6);
    expect(historyBudget("x".repeat(MAX_PROMPT_BYTES + 5))).toBe(0);
  });
});
