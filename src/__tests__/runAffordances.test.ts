// @vitest-environment jsdom
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeStatementHighlight } from "../components/activeStatement";
import { cteBadgeText, type RunAffordancesOptions, runAffordances } from "../components/runAffordances";
import type { CteRunRecord } from "../cteRunBadge";

describe("cteBadgeText (#2450)", () => {
  it("行数と最新 / stale のツールチップを返す", () => {
    const fresh = cteBadgeText({ rows: 12, stale: false, truncated: false });
    const stale = cteBadgeText({ rows: 12, stale: true, truncated: false });
    expect(fresh.text).toContain("12");
    expect(fresh.tip).toContain("12");
    expect(stale.tip).not.toBe(fresh.tip);
    expect(cteBadgeText({ rows: 1000, stale: false, truncated: true }).text).toContain("1000+");
  });
});

describe("runAffordances 拡張 (#2450)", () => {
  let view: EditorView | null = null;
  afterEach(() => {
    view?.destroy();
    view = null;
    vi.useRealTimers();
  });

  const mount = (doc: string, over: Partial<RunAffordancesOptions> & { runs?: CteRunRecord[] } = {}) => {
    vi.useFakeTimers();
    const calls = { stmt: 0, cte: [] as number[] };
    const opts: RunAffordancesOptions = {
      getDriver: () => "postgres",
      isBandEnabled: () => true,
      isCteEnabled: () => true,
      isCteUnsupported: () => false,
      getCteLimit: () => null,
      getCteRuns: () => over.runs ?? [],
      runStatement: () => {
        calls.stmt++;
      },
      runCte: (_v, at) => {
        calls.cte.push(at);
      },
      onTip: () => {},
      ...over,
    };
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      doc,
      parent,
      extensions: [
        activeStatementHighlight(
          () => "postgres",
          () => true,
        ),
        runAffordances(opts),
      ],
    });
    return { v: view, calls };
  };
  const settle = () => vi.advanceTimersByTime(300);

  it("2 文以上のとき、帯の文の先頭行のガターに実行ボタンが出て、クリックで runStatement を呼ぶ", () => {
    const { v, calls } = mount("SELECT 1;\nSELECT 2;\nSELECT 3");
    v.dispatch({ selection: { anchor: 12 } });
    settle();
    const btns = v.dom.querySelectorAll<HTMLButtonElement>(".cm-run-gutter-btn");
    // 実マーカー 1 つ (スペーサは button を持たない)。
    expect(btns).toHaveLength(1);
    expect(btns[0]?.getAttribute("aria-label")).toBeTruthy();
    btns[0]?.click();
    expect(calls.stmt).toBe(1);
  });

  it("1 文だけならガターのボタンは出ない", () => {
    const { v } = mount("SELECT 1;");
    settle();
    expect(v.dom.querySelectorAll(".cm-run-gutter-btn")).toHaveLength(0);
  });

  it("CTE の中では「CTE まで」が出て、クリックで runCte に CTE の先頭位置を渡す", () => {
    const doc = "WITH a AS (SELECT 1 AS n) SELECT * FROM a";
    const { v, calls } = mount(doc);
    v.dispatch({ selection: { anchor: 18 } });
    settle();
    const btn = v.dom.querySelector<HTMLButtonElement>(".cm-cte-run-btn");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("aria-disabled")).toBeNull();
    btn?.click();
    expect(calls.cte).toEqual([5]);
  });

  it("CTE の外では出ない", () => {
    const { v } = mount("WITH a AS (SELECT 1 AS n) SELECT * FROM a");
    v.dispatch({ selection: { anchor: 35 } });
    settle();
    expect(v.dom.querySelector(".cm-cte-run-btn")).toBeNull();
  });

  it("書き込み CTE は無効で、理由が data-run-tip に入り、クリックしても実行しない", () => {
    const doc = "WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d";
    const { v, calls } = mount(doc);
    v.dispatch({ selection: { anchor: 20 } });
    settle();
    const btn = v.dom.querySelector<HTMLButtonElement>(".cm-cte-run-btn");
    expect(btn?.getAttribute("aria-disabled")).toBe("true");
    expect(btn?.getAttribute("data-run-tip")).toBeTruthy();
    btn?.click();
    expect(calls.cte).toEqual([]);
  });

  it("WITH 非対応のサーバでは無効", () => {
    const { v } = mount("WITH a AS (SELECT 1) SELECT * FROM a", { isCteUnsupported: () => true });
    v.dispatch({ selection: { anchor: 16 } });
    settle();
    expect(v.dom.querySelector(".cm-cte-run-btn")?.getAttribute("aria-disabled")).toBe("true");
  });

  it("実行済みの CTE には行数バッジが付き、SQL が変わっていれば stale になる", () => {
    const doc = "WITH a AS (SELECT 1 AS n) SELECT * FROM a";
    const fresh = mount(doc, {
      runs: [{ name: "a", sql: "WITH a AS (SELECT 1 AS n)\nSELECT * FROM a", rows: 7 }],
    });
    fresh.v.dispatch({ selection: { anchor: 35 } });
    settle();
    const badge = fresh.v.dom.querySelector(".cm-cte-badge");
    expect(badge?.textContent).toContain("7");
    expect(badge?.classList.contains("cm-cte-badge-stale")).toBe(false);
    fresh.v.destroy();
    view = null;

    const stale = mount(doc, {
      runs: [{ name: "a", sql: "WITH a AS (SELECT 0)\nSELECT * FROM a", rows: 7 }],
    });
    stale.v.dispatch({ selection: { anchor: 35 } });
    settle();
    expect(stale.v.dom.querySelector(".cm-cte-badge")?.classList.contains("cm-cte-badge-stale")).toBe(true);
  });

  it("CTE 内でカーソルを動かしても (同じ内容なら) ウィジェットの DOM を作り直さない", () => {
    const { v } = mount("WITH a AS (SELECT 1 AS n) SELECT * FROM a");
    v.dispatch({ selection: { anchor: 16 } });
    settle();
    const before = v.dom.querySelector(".cm-cte-run-btn");
    v.dispatch({ selection: { anchor: 20 } });
    settle();
    expect(v.dom.querySelector(".cm-cte-run-btn")).toBe(before);
  });

  it("手前の編集で CTE の位置がずれたら、クリックで新しい先頭位置を渡す", () => {
    const doc = "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM b";
    const { v, calls } = mount(doc);
    const inB = doc.indexOf("SELECT 2") + 2;
    v.dispatch({ selection: { anchor: inB } });
    settle();
    const pad = " ".repeat(40);
    const at = doc.indexOf("1");
    v.dispatch({ changes: { from: at, insert: pad }, selection: { anchor: inB + pad.length } });
    settle();
    v.dom.querySelector<HTMLButtonElement>(".cm-cte-run-btn")?.click();
    expect(calls.cte).toEqual([doc.indexOf("b AS") + pad.length]);
  });

  it("onRunCte が無い (isCteEnabled=false) ときは CTE のウィジェットを出さない", () => {
    const { v } = mount("WITH a AS (SELECT 1) SELECT * FROM a", { isCteEnabled: () => false });
    v.dispatch({ selection: { anchor: 16 } });
    settle();
    expect(v.dom.querySelector(".cm-cte-run")).toBeNull();
  });
});
