import { describe, it, expect } from "vitest";
import {
  filterSectionsByTitle,
  isEmptyQuery,
  matchesQuery,
  pickActiveSection,
} from "../sectionNav";
import { filterHelpSections } from "../helpSearch";

describe("sectionNav", () => {
  it("matchesQuery は大小無視の部分一致で、空クエリは常に一致", () => {
    expect(matchesQuery("", "abc")).toBe(true);
    expect(matchesQuery("  ", "abc")).toBe(true);
    expect(matchesQuery("BC", "abc")).toBe(true);
    expect(matchesQuery("x", "abc", undefined)).toBe(false);
    expect(matchesQuery("x", "abc", "xyz")).toBe(true);
    expect(isEmptyQuery(" \t")).toBe(true);
  });

  it("filterSectionsByTitle は見出しで絞り込む", () => {
    const secs = [{ t: "Language" }, { t: "Safety" }];
    expect(filterSectionsByTitle(secs, "", (s) => s.t)).toEqual(secs);
    expect(filterSectionsByTitle(secs, "saf", (s) => s.t)).toEqual([{ t: "Safety" }]);
    expect(filterSectionsByTitle(secs, "zzz", (s) => s.t)).toEqual([]);
  });

  it("pickActiveSection: 空 / 先頭 / 途中 / 末尾 / 要素欠落", () => {
    const ids = ["a", "b", "c"];
    expect(pickActiveSection([], [], false)).toBeNull();
    expect(pickActiveSection(ids, [100, 400, 700], false)).toBe("a");
    expect(pickActiveSection(ids, [-300, 10, 300], false)).toBe("b");
    expect(pickActiveSection(ids, [-300, 24, 25], false)).toBe("b");
    expect(pickActiveSection(ids, [-300, -200, 100], true)).toBe("c");
    expect(pickActiveSection(ids, [null, -5, 500], false)).toBe("b");
  });
});

describe("filterHelpSections (#1273)", () => {
  interface F {
    title: string;
    desc: string;
    steps?: string[];
    note?: string;
  }
  const sections = [
    {
      header: "Safe",
      desc: "no writes",
      features: [
        { title: "Dry run", desc: "rollback", steps: ["press button"] },
        { title: "Format", desc: "pretty print", note: "uses sql-formatter" },
      ] as F[],
    },
    {
      header: "Guards",
      desc: "protect production",
      features: [{ title: "Read only", desc: "blocks writes" }] as F[],
    },
  ];
  const textsOf = (f: F) => f;

  it("空クエリでは全件", () => {
    expect(filterHelpSections(sections, " ", textsOf)).toEqual(sections);
  });

  it("カードのタイトル・説明・手順・注記に一致するものだけ残す", () => {
    const byTitle = filterHelpSections(sections, "dry", textsOf);
    expect(byTitle).toHaveLength(1);
    expect(byTitle[0].features.map((f) => f.title)).toEqual(["Dry run"]);
    expect(filterHelpSections(sections, "BUTTON", textsOf)[0].features[0].title).toBe("Dry run");
    expect(filterHelpSections(sections, "sql-formatter", textsOf)[0].features[0].title).toBe(
      "Format",
    );
    expect(filterHelpSections(sections, "blocks", textsOf)[0].header).toBe("Guards");
  });

  it("節の見出し・説明に一致したら節内の全カードを残す", () => {
    const r = filterHelpSections(sections, "guards", textsOf);
    expect(r).toHaveLength(1);
    expect(r[0].features).toHaveLength(1);
    const r2 = filterHelpSections(sections, "no writes", textsOf);
    expect(r2[0].features).toHaveLength(2);
  });

  it("一致が無ければ空配列 (元データは破壊しない)", () => {
    expect(filterHelpSections(sections, "zzz", textsOf)).toEqual([]);
    expect(sections[0].features).toHaveLength(2);
  });
});
