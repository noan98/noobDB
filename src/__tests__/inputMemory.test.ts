// @vitest-environment jsdom (localStorage に触れるため)
import { beforeEach, describe, expect, it } from "vitest";
import type { ColumnGenSpec } from "../components/testDataGen";
import {
  DEFAULT_IMPORT_PREFS,
  MAX_DATA_SEARCH_HISTORY,
  MAX_RECENT_SCRIPTS,
  MAX_ROUTINE_ARG_SETS,
  applyRememberedSpecs,
  basenameOf,
  delimiterAfterPick,
  describeArgSet,
  dirnameOf,
  fitArgSet,
  joinDirAndName,
  loadDataSearchHistory,
  loadDumpPrefs,
  loadImportPrefs,
  loadRecentScripts,
  loadTablesExportPrefs,
  loadTestDataPrefs,
  pushDataSearchHistory,
  pushRecentScript,
  pushRoutineArgSet,
  sanitizeDataSearchHistory,
  sanitizeDumpPrefs,
  sanitizeImportPrefs,
  sanitizeRecentScripts,
  clearRoutineArgMemory,
  loadRoutineArgSets,
  routineArgsScope,
  saveRoutineArgSets,
  sanitizeTablesExportPrefs,
  sanitizeTestDataPrefs,
  saveDataSearchHistory,
  saveDumpPrefs,
  saveImportPrefs,
  saveRecentScripts,
  saveTablesExportPrefs,
  saveTestDataPrefs,
  snapshotTestDataPrefs,
  testDataScope,
  importScope,
  tablesExportScope,
  dataSearchScope,
} from "../inputMemory";

beforeEach(() => {
  localStorage.clear();
});

describe("パス部品", () => {
  it("dirnameOf / joinDirAndName / basenameOf", () => {
    expect(dirnameOf("/home/u/dump.sql")).toBe("/home/u");
    expect(dirnameOf("C:\\Users\\u\\dump.sql")).toBe("C:\\Users\\u");
    expect(dirnameOf("/dump.sql")).toBe("/");
    expect(dirnameOf("C:\\dump.sql")).toBe("C:\\");
    expect(dirnameOf("dump.sql")).toBe("");
    expect(joinDirAndName("/home/u", "a.sql")).toBe("/home/u/a.sql");
    expect(joinDirAndName("/", "a.sql")).toBe("/a.sql");
    expect(joinDirAndName("C:\\Users\\u", "a.sql")).toBe("C:\\Users\\u\\a.sql");
    expect(joinDirAndName("C:\\", "a.sql")).toBe("C:\\a.sql");
    expect(joinDirAndName("", "a.sql")).toBe("a.sql");
    expect(basenameOf("/a/b/c.sql")).toBe("c.sql");
    expect(basenameOf("C:\\a\\c.sql")).toBe("c.sql");
  });
});

describe("ダンプの記憶 (プロファイル単位)", () => {
  it("既知のスイッチだけを残し、型違いは捨てる", () => {
    const p = sanitizeDumpPrefs({ options: { gzip: true, noData: "x", unknown: true }, dir: "/d" });
    expect(p).toEqual({ options: { gzip: true }, dir: "/d" });
    expect(sanitizeDumpPrefs("x")).toBeNull();
  });
  it("プロファイルごとに保存・復元し、プロファイル不明なら何もしない", () => {
    saveDumpPrefs("p1", { options: { gzip: true }, dir: "/a" });
    saveDumpPrefs("p2", { options: { gzip: false }, dir: "/b" });
    expect(loadDumpPrefs("p1")?.dir).toBe("/a");
    expect(loadDumpPrefs("p2")?.options.gzip).toBe(false);
    expect(loadDumpPrefs(undefined)).toBeNull();
    saveDumpPrefs(undefined, { options: {}, dir: "" });
    expect(loadDumpPrefs("p3")).toBeNull();
  });
});

describe("取り込みの記憶 (テーブル単位)", () => {
  it("壊れた値は既定へ戻し、引用符は 1 バイト ASCII のみ", () => {
    const p = sanitizeImportPrefs({
      format: "zip",
      delimiter: "|",
      quote: "「",
      errorMode: "skip",
      nullMode: "custom",
      nullCustom: "\\N",
      hasHeader: false,
      encoding: "shift_jis",
    });
    expect(p).toEqual({
      ...DEFAULT_IMPORT_PREFS,
      errorMode: "skip",
      nullMode: "custom",
      nullCustom: "\\N",
      hasHeader: false,
      encoding: "shift_jis",
    });
  });
  it("接続 × DB × テーブルで別々に保存される", () => {
    const a = importScope("p1", "db", "users");
    const b = importScope("p1", "db", "orders");
    saveImportPrefs(a, { ...DEFAULT_IMPORT_PREFS, delimiter: ";" });
    saveImportPrefs(b, { ...DEFAULT_IMPORT_PREFS, encoding: "euc-jp" });
    expect(loadImportPrefs(a)?.delimiter).toBe(";");
    expect(loadImportPrefs(b)?.encoding).toBe("euc-jp");
    expect(loadImportPrefs(importScope("p2", "db", "users"))).toBeNull();
  });
  it("delimiterAfterPick: .tsv はタブ、タブから他拡張子はカンマ、それ以外は保つ", () => {
    expect(delimiterAfterPick(";", "/a/b.tsv")).toBe("\t");
    expect(delimiterAfterPick("\t", "/a/b.csv")).toBe(",");
    expect(delimiterAfterPick(";", "/a/b.csv")).toBe(";");
  });
});

describe("一括書き出しの記憶", () => {
  it("検証して保存・復元する", () => {
    expect(sanitizeTablesExportPrefs({ format: "zzz", dir: 1, maskEnabled: true })).toEqual({
      format: "csv",
      dir: "",
      maskEnabled: true,
      includeDdl: false,
    });
    const scope = tablesExportScope("p1", "db");
    saveTablesExportPrefs(scope, { format: "sql", dir: "/out", maskEnabled: true, includeDdl: true });
    expect(loadTablesExportPrefs(scope)).toEqual({
      format: "sql",
      dir: "/out",
      maskEnabled: true,
      includeDdl: true,
    });
  });
});

function spec(over: Partial<ColumnGenSpec>): ColumnGenSpec {
  return {
    column: "c",
    dataType: "varchar(10)",
    kind: "string",
    nullable: true,
    strategy: "randomString",
    nullRate: 0,
    fixedValue: "",
    choices: [],
    fkTable: null,
    fkColumn: null,
    length: 8,
    min: 0,
    max: 1000,
    serialStart: 1,
    temporal: "datetime",
    ...over,
  };
}

describe("テストデータの記憶", () => {
  const masks = ["password", "email"];
  it("保存時: 機微な列名の固定値は保存せず、スキーマ由来の候補値も含めない", () => {
    const snap = snapshotTestDataPrefs(
      [
        spec({ column: "name", strategy: "fixed", fixedValue: "Alice" }),
        spec({ column: "user_password", strategy: "fixed", fixedValue: "hunter2" }),
        spec({ column: "email", strategy: "fixed", fixedValue: "a@example.com" }),
      ],
      "50",
      42,
      masks,
    );
    expect(snap.columns.name.fixedValue).toBe("Alice");
    expect(snap.columns.user_password.fixedValue).toBeUndefined();
    expect(snap.columns.email.fixedValue).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain("hunter2");
    expect(JSON.stringify(snap)).not.toContain("a@example.com");
    expect(JSON.stringify(snap)).not.toContain("choices");
  });
  it("往復: 保存 → 読み込み → 適用で戦略・シード・行数が戻る", () => {
    const scope = testDataScope("p1", "db", "users");
    saveTestDataPrefs(
      scope,
      snapshotTestDataPrefs(
        [spec({ column: "age", strategy: "randomNumber", min: 18, max: 65, nullRate: 0.2 })],
        "250",
        12345,
        masks,
      ),
    );
    const loaded = loadTestDataPrefs(scope);
    expect(loaded?.seed).toBe(12345);
    expect(loaded?.rowCountText).toBe("250");
    const applied = applyRememberedSpecs([spec({ column: "age" }), spec({ column: "other" })], loaded!);
    expect(applied[0]).toMatchObject({ strategy: "randomNumber", min: 18, max: 65, nullRate: 0.2 });
    expect(applied[1].strategy).toBe("randomString");
  });
  it("適用: 選べなくなった戦略 (choice / fkRef) は既定のまま、固定値が無ければ既定を保つ", () => {
    const prefs = sanitizeTestDataPrefs({
      rowCountText: "10",
      seed: 1,
      columns: {
        a: { strategy: "choice" },
        b: { strategy: "fkRef" },
        c: { strategy: "fixed" },
      },
    })!;
    const out = applyRememberedSpecs(
      [
        spec({ column: "a", kind: "string" }),
        spec({ column: "b" }),
        spec({ column: "c", fixedValue: "keep" }),
      ],
      prefs,
    );
    expect(out[0].strategy).toBe("randomString");
    expect(out[1].strategy).toBe("randomString");
    expect(out[2]).toMatchObject({ strategy: "fixed", fixedValue: "keep" });
  });
  it("適用: 列挙型の choice と FK 列の fkRef は復元される", () => {
    const prefs = sanitizeTestDataPrefs({
      rowCountText: "10",
      seed: 1,
      columns: { a: { strategy: "choice" }, b: { strategy: "fkRef" } },
    })!;
    const out = applyRememberedSpecs(
      [spec({ column: "a", kind: "enum" }), spec({ column: "b", fkTable: "t", fkColumn: "id" })],
      prefs,
    );
    expect(out.map((s) => s.strategy)).toEqual(["choice", "fkRef"]);
  });
  it("sanitize: 範囲外の値を丸め、列数に上限がある", () => {
    const p = sanitizeTestDataPrefs({
      rowCountText: 5,
      seed: -3,
      columns: { a: { strategy: "serial", nullRate: 9, length: 0 } },
    })!;
    expect(p.rowCountText).toBe("100");
    expect(p.seed).toBe(0);
    expect(p.columns.a.nullRate).toBe(1);
    expect(p.columns.a.length).toBe(1);
  });
});

describe("ルーチン引数の履歴", () => {
  it("先頭に足し、同じ内容は繰り上げ、上限で古いものを捨てる", () => {
    let h: string[][] = [];
    for (let i = 0; i < MAX_ROUTINE_ARG_SETS + 2; i++) h = pushRoutineArgSet(h, [String(i)], ["n"], []);
    expect(h).toHaveLength(MAX_ROUTINE_ARG_SETS);
    expect(h[0]).toEqual([String(MAX_ROUTINE_ARG_SETS + 1)]);
    h = pushRoutineArgSet(h, [String(MAX_ROUTINE_ARG_SETS)], ["n"], []);
    expect(h[0]).toEqual([String(MAX_ROUTINE_ARG_SETS)]);
    expect(h).toHaveLength(MAX_ROUTINE_ARG_SETS);
  });
  it("機微な引数名の値は保存せず、全部空なら足さない", () => {
    const h = pushRoutineArgSet([], ["alice", "s3cret"], ["user_name", "api_token"], ["token"]);
    expect(h).toEqual([["alice", ""]]);
    expect(pushRoutineArgSet([], ["s3cret"], ["api_token"], ["token"])).toEqual([]);
    expect(pushRoutineArgSet([], ["", ""], ["a", "b"], [])).toEqual([]);
  });
  it("履歴はメモリだけに保持し、localStorage には書かない", () => {
    clearRoutineArgMemory();
    const scope = routineArgsScope("p1", "db", "procedure", "sp_x", null);
    saveRoutineArgSets(scope, [["1", "a"]]);
    expect(loadRoutineArgSets(scope)).toEqual([["1", "a"]]);
    expect(loadRoutineArgSets(routineArgsScope("p1", "db", "procedure", "sp_y", null))).toEqual([]);
    expect(localStorage.length).toBe(0);
    // 取り出した配列を書き換えても保持している履歴は変わらない。
    loadRoutineArgSets(scope)[0][0] = "changed";
    expect(loadRoutineArgSets(scope)).toEqual([["1", "a"]]);
    clearRoutineArgMemory();
    expect(loadRoutineArgSets(scope)).toEqual([]);
  });
  it("fit / describe", () => {
    expect(fitArgSet(["a"], 3)).toEqual(["a", "", ""]);
    expect(fitArgSet(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(describeArgSet(["1", "", "x"])).toBe("1, ·, x");
    expect(describeArgSet(["x".repeat(100)], 10)).toHaveLength(10);
  });
});

describe("最近のスクリプト", () => {
  it("パス重複は繰り上げ、上限を超えたら古い順に捨て、空パスは無視", () => {
    let l = pushRecentScript([], { path: "/a.sql", encoding: null });
    l = pushRecentScript(l, { path: "/b.sql", encoding: "shift_jis" });
    l = pushRecentScript(l, { path: "/a.sql", encoding: "utf-8" });
    expect(l).toEqual([
      { path: "/a.sql", encoding: "utf-8" },
      { path: "/b.sql", encoding: "shift_jis" },
    ]);
    expect(pushRecentScript(l, { path: "  ", encoding: null })).toEqual(l);
    for (let i = 0; i < MAX_RECENT_SCRIPTS + 3; i++)
      l = pushRecentScript(l, { path: `/${i}.sql`, encoding: null });
    expect(l).toHaveLength(MAX_RECENT_SCRIPTS);
  });
  it("保存・復元と sanitize (未知の文字コードは自動判定 = null)", () => {
    saveRecentScripts([{ path: "/a.sql", encoding: "euc-jp" }]);
    expect(loadRecentScripts()).toEqual([{ path: "/a.sql", encoding: "euc-jp" }]);
    expect(sanitizeRecentScripts([{ path: "/x.sql", encoding: "klingon" }, { path: 1 }, null])).toEqual([
      { path: "/x.sql", encoding: null },
    ]);
  });
});

describe("値検索の履歴", () => {
  const e = (term: string, over = {}) => ({
    term,
    mode: "contains" as const,
    scope: "all" as const,
    tables: [],
    ...over,
  });
  it("同じ条件は繰り上げ、テーブル順の違いは同一視、上限で古いものを捨てる", () => {
    let h = pushDataSearchHistory([], e("a", { scope: "selected", tables: ["t1", "t2"] }));
    h = pushDataSearchHistory(h, e("b"));
    h = pushDataSearchHistory(h, e("a", { scope: "selected", tables: ["t2", "t1"] }));
    expect(h.map((x) => x.term)).toEqual(["a", "b"]);
    for (let i = 0; i < MAX_DATA_SEARCH_HISTORY + 3; i++) h = pushDataSearchHistory(h, e(`t${i}`));
    expect(h).toHaveLength(MAX_DATA_SEARCH_HISTORY);
  });
  it("全体検索ではテーブルを持たず、空の語は足さない", () => {
    const h = pushDataSearchHistory([], e("a", { tables: ["x"] }));
    expect(h[0].tables).toEqual([]);
    expect(pushDataSearchHistory([], e("  "))).toEqual([]);
  });
  it("sanitize: 選択スコープでテーブルが無い / 語が空の項目は捨てる", () => {
    expect(
      sanitizeDataSearchHistory([
        { term: "a", scope: "selected", tables: [] },
        { term: "", scope: "all" },
        { term: "ok", mode: "exact", scope: "selected", tables: ["t", 1] },
      ]),
    ).toEqual([{ term: "ok", mode: "exact", scope: "selected", tables: ["t"] }]);
  });
  it("接続 × DB ごとに保存される", () => {
    saveDataSearchHistory(dataSearchScope("p1", "db1"), [e("x")]);
    expect(loadDataSearchHistory(dataSearchScope("p1", "db1"))).toHaveLength(1);
    expect(loadDataSearchHistory(dataSearchScope("p1", "db2"))).toEqual([]);
  });
});
