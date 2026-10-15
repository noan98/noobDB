import { describe, expect, it } from "vitest";
import { comboMatchTier, rankComboOptions } from "../components/comboRank";

const opts = (...values: string[]) => values.map((value) => ({ value }));
const values = (o: { value: string }[]) => o.map((x) => x.value);

describe("comboMatchTier", () => {
  it("完全一致 0 / 前方一致 1 / 単語境界 2 / 部分一致 3 / 不一致 null", () => {
    expect(comboMatchTier("user", "user")).toBe(0);
    expect(comboMatchTier("USER", "user")).toBe(0);
    expect(comboMatchTier("user_id", "user")).toBe(1);
    expect(comboMatchTier("created_user", "user")).toBe(2);
    expect(comboMatchTier("createdUser", "user")).toBe(2);
    expect(comboMatchTier("superuser", "user")).toBe(3);
    expect(comboMatchTier("name", "user")).toBeNull();
  });
});

describe("rankComboOptions", () => {
  it("user と打つと user_id より user が先頭に来る", () => {
    const out = rankComboOptions(opts("id", "user_id", "created_by_user", "superuser", "user"), "user");
    expect(values(out)).toEqual(["user", "user_id", "created_by_user", "superuser"]);
  });
  it("同じ段の中は元の並びを保つ", () => {
    const out = rankComboOptions(opts("b_x", "a_x", "c_x"), "x");
    expect(values(out)).toEqual(["b_x", "a_x", "c_x"]);
  });
  it("空の検索語は全件を元の順で返す", () => {
    expect(values(rankComboOptions(opts("b", "a"), "  "))).toEqual(["b", "a"]);
  });
  it("一致しない候補は落とす", () => {
    expect(rankComboOptions(opts("a", "b"), "z")).toEqual([]);
  });
});
