import { describe, expect, it } from "vitest";
import prices from "./fixtures/aiModelPrices.json";
import type { AiUsageRecord } from "../api/tauri";
import { AI_MODEL_IDS, AI_MODEL_PRICES } from "../ai/aiModels";
import {
  BUDGET_WARN_RATIO,
  budgetStatus,
  buildUsageReport,
  estimateRecordCostUsd,
  formatUsd,
  monthStartKey,
  sinceDayKey,
} from "../ai/aiUsageCost";

const rec = (over: Partial<AiUsageRecord>): AiUsageRecord => ({
  day: "2026-10-12",
  task: "nl2sql",
  model: "claude-opus-5-5",
  calls: 1,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  ...over,
});

describe("AI 使用量の集計と概算コスト (#1540)", () => {
  it("単価表は全モデルを持ち、キャッシュ読み取りは入力より安い", () => {
    for (const id of AI_MODEL_IDS) {
      const p = AI_MODEL_PRICES[id];
      expect(p.input).toBeGreaterThan(0);
      expect(p.output).toBeGreaterThan(p.input);
      expect(p.cacheRead).toBeLessThan(p.input);
      expect(p.cacheWrite).toBeGreaterThan(p.input);
    }
  });

  it("概算コストは 100 万トークン単価 × トークン数。未知のモデルは null", () => {
    const cost = estimateRecordCostUsd(
      rec({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 200_000,
      }),
    );
    // opus: 4 + 10 + 0.2 + 1 = 15.2
    expect(cost).toBeCloseTo(15.2, 6);
    expect(estimateRecordCostUsd(rec({ model: "claude-unknown" }))).toBeNull();
  });

  it("モデル別 / タスク別 / 日別に集計し、コストの大きい順に並べる", () => {
    const report = buildUsageReport([
      rec({ day: "2026-10-11", inputTokens: 100, outputTokens: 10 }),
      rec({ day: "2026-10-12", task: "generic", model: "claude-haiku-5-5", calls: 3, inputTokens: 1000 }),
      rec({ day: "2026-10-12", inputTokens: 1_000_000, calls: 2 }),
      rec({ day: "2026-10-12", model: "legacy-model", calls: 4, inputTokens: 5 }),
    ]);
    expect(report.total.calls).toBe(10);
    expect(report.total.unpricedCalls).toBe(4);
    expect(report.byModel.map((a) => a.key)).toEqual(["claude-opus-5-5", "claude-haiku-5-5", "legacy-model"]);
    expect(report.byTask.map((a) => a.key)).toEqual(["nl2sql", "generic"]);
    expect(report.byDay.map((a) => a.key)).toEqual(["2026-10-12", "2026-10-11"]);
  });

  it("sinceDay より前の日は集計に入れない (境界の日は含む)", () => {
    const rows = [rec({ day: "2026-10-05", calls: 1 }), rec({ day: "2026-10-06", calls: 2 })];
    expect(buildUsageReport(rows, "2026-10-06").total.calls).toBe(2);
    expect(buildUsageReport(rows).total.calls).toBe(3);
  });

  it("sinceDayKey は JST 基準の n 日前 (当日を含む)", () => {
    // 2026-10-12 15:00 UTC = JST 10-13 00:00
    const now = new Date("2026-10-12T15:00:00Z");
    expect(sinceDayKey(now, 1)).toBe("2026-10-13");
    expect(sinceDayKey(now, 7)).toBe("2026-10-07");
    expect(sinceDayKey(new Date("2026-10-12T14:59:00Z"), 1)).toBe("2026-10-12");
  });

  it("monthStartKey は JST の月初 (UTC 月末 15:00 から翌月)", () => {
    expect(monthStartKey(new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-01");
    expect(monthStartKey(new Date("2026-09-30T14:59:00Z"))).toBe("2026-09-01");
    expect(monthStartKey(new Date("2026-09-30T15:00:00Z"))).toBe("2026-10-01");
  });

  it("formatUsd は 1 セント未満を 4 桁で出す", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00123)).toBe("$0.0012");
    expect(formatUsd(0.0001)).toBe("$0.0001");
    expect(formatUsd(0.00009999)).toBe("< $0.0001");
    expect(formatUsd(0.00003)).toBe("< $0.0001");
    expect(formatUsd(1.234)).toBe("$1.23");
  });
});

describe("単価表の共有ベクタ (#1620)", () => {
  it("aiModelPrices.json と AI_MODEL_PRICES が一致する (Rust 側 AiModel::price も同じ JSON を読む)", () => {
    expect(prices.prices).toEqual(AI_MODEL_PRICES);
  });
});

describe("月次予算の状態 (#1620)", () => {
  const now = new Date("2026-10-15T03:00:00Z");
  // Opus 入力 $4 / MTok。1M トークンで $4。
  const spend = (m: number) => [rec({ day: "2026-10-02", inputTokens: m * 250_000 })];

  it("予算なし / 不正値は none", () => {
    expect(budgetStatus(spend(4), null, now).state).toBe("none");
    expect(budgetStatus(spend(4), 0, now).state).toBe("none");
    expect(budgetStatus(spend(4), Number.NaN, now).state).toBe("none");
  });

  it("8 割未満は ok、8 割以上は warning、予算以上は exceeded (バックエンドと同じ >= 境界)", () => {
    expect(BUDGET_WARN_RATIO).toBe(0.8);
    // spent = $4 * m/4... 1M トークン = $4。
    expect(budgetStatus(spend(4), 10, now).state).toBe("ok"); // $4
    expect(budgetStatus(spend(4), 5, now).state).toBe("warning"); // $4 / $5 = 80%
    expect(budgetStatus(spend(4), 4.01, now).state).toBe("warning");
    expect(budgetStatus(spend(4), 4, now).state).toBe("exceeded"); // ちょうど到達
    expect(budgetStatus(spend(4), 3, now).state).toBe("exceeded");
  });

  it("先月分は数えない (月の境目は JST)", () => {
    const records = [rec({ day: "2026-09-30", inputTokens: 10_000_000 })];
    expect(budgetStatus(records, 1, now).state).toBe("ok");
    // UTC 9/30 16:00 は JST 10/1 なので 9/30 の記録は先月。
    expect(budgetStatus(records, 1, new Date("2026-09-30T16:00:00Z")).spent).toBe(0);
  });
});
