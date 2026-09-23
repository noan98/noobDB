import { describe, expect, it } from "vitest";
import type { ColumnProfile } from "../api/tauri";
import { dictionaries } from "../i18n";
import {
  formatBucketLabel,
  formatPercent,
  formatProfileCount,
  profileChartKind,
  profileChartModel,
  profileCountValue,
  profileNoteKey,
  profilePercent,
  profileTargetLabel,
  profileValueLabel,
} from "../components/columnProfile";

/**
 * 列データプロファイル (#974) の表示整形。集計はバックエンド (`db/profile.rs`) が
 * サーバ側で行い、ここは件数の表示・率・チャートモデル・縮退理由の写像だけを持つ。
 */

function profile(overrides: Partial<ColumnProfile> = {}): ColumnProfile {
  return {
    column: "age",
    data_type: "int",
    numeric: true,
    total_count: 100,
    non_null_count: 80,
    null_count: 20,
    distinct_count: 30,
    distinct_approximate: false,
    min_value: 1,
    max_value: 90,
    top_values: [
      { value: 42, count: 10 },
      { value: null, count: 1 },
    ],
    histogram: [
      { lower: 0, upper: 5, count: 3 },
      { lower: 5, upper: 10, count: "7" },
    ],
    notes: [],
    ...overrides,
  };
}

describe("件数の扱い (2^53 超は文字列で届く)", () => {
  it("文字列の件数は丸めずに桁区切りする", () => {
    expect(formatProfileCount("9007199254740993")).toBe("9,007,199,254,740,993");
    expect(formatProfileCount(1234567)).toBe("1,234,567");
    expect(formatProfileCount(0)).toBe("0");
    expect(formatProfileCount(null)).toBe("—");
  });

  it("率の計算用には数値へ落とす (解釈できなければ 0)", () => {
    expect(profileCountValue("12")).toBe(12);
    expect(profileCountValue("abc")).toBe(0);
    expect(profileCountValue(undefined)).toBe(0);
  });

  it("百分率は分母 0 で null、極小は <0.1% と表示する", () => {
    expect(profilePercent(20, 100)).toBe(20);
    expect(profilePercent(1, 0)).toBeNull();
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.01)).toBe("<0.1%");
    expect(formatPercent(12.345)).toBe("12.3%");
  });
});

describe("値とラベル", () => {
  it("NULL は null を返し、真偽値は文字列にする", () => {
    expect(profileValueLabel(null)).toBeNull();
    expect(profileValueLabel(true)).toBe("true");
    expect(profileValueLabel("9007199254740993")).toBe("9007199254740993");
  });

  it("区間ラベルは整数なら小数を出さず、極端な値は指数表記にする", () => {
    expect(formatBucketLabel(0, 5)).toBe("0–5");
    expect(formatBucketLabel(0.5, 1.25)).toBe("0.5–1.25");
    expect(formatBucketLabel(1234567.5, 2e7)).toBe("1.23e+6–20000000");
  });

  it("対象ラベルは SQLite ではデータベースを省く", () => {
    expect(profileTargetLabel("mysql", { database: "app", table: "users", column: "age" })).toBe("app.users.age");
    expect(profileTargetLabel("sqlite", { database: "main", table: "users", column: null })).toBe("users");
  });
});

describe("チャート (ChartView の棒グラフを再利用)", () => {
  it("数値列はヒストグラム、区間が無ければ上位頻出値、どちらも無ければ null", () => {
    expect(profileChartKind(profile())).toBe("histogram");
    expect(profileChartKind(profile({ histogram: [] }))).toBe("topValues");
    expect(profileChartKind(profile({ numeric: false }))).toBe("topValues");
    expect(profileChartKind(profile({ histogram: [], top_values: [] }))).toBeNull();
  });

  it("ヒストグラムを 1 系列の棒モデルにする (文字列件数も数値化)", () => {
    const m = profileChartModel(profile(), "histogram", { value: "値", count: "件数", nullLabel: "NULL" });
    expect(m.labels).toEqual(["0–5", "5–10"]);
    expect(m.series).toEqual([{ name: "件数", values: [3, 7] }]);
  });

  it("上位頻出値の NULL は指定ラベルで表示する", () => {
    const m = profileChartModel(profile(), "topValues", { value: "v", count: "c", nullLabel: "NULL" });
    expect(m.labels).toEqual(["42", "NULL"]);
    expect(m.series[0].values).toEqual([10, 1]);
  });
});

describe("縮退理由コード", () => {
  it("既知のコードは専用文言、未知は汎用文言へ倒す (両言語に存在する)", () => {
    const codes = [
      "stats_unavailable",
      "top_values_unavailable",
      "histogram_unavailable",
      "approx_distinct_unsupported",
      "approx_distinct_no_stats",
      "something_new",
    ];
    const keys = codes.map(profileNoteKey);
    expect(keys[keys.length - 1]).toBe("profileNoteUnknown");
    expect(new Set(keys).size).toBe(codes.length);
    for (const key of keys) {
      expect(dictionaries.en[key]).toBeTruthy();
      expect(dictionaries.ja[key]).toBeTruthy();
    }
  });
});
