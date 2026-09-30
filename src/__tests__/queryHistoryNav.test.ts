import { describe, it, expect } from "vitest";
import {
  dedupeAdjacentHistory,
  initialHistoryNav,
  pushHistoryEntry,
  QUERY_HISTORY_LIMIT,
  navigateNewer,
  navigateOlder,
} from "../components/queryHistoryNav";

// 履歴ナビゲーションの純粋ロジックの回帰テスト。最新が先頭の履歴配列に対し、
// ↑ で古い方向 / ↓ で新しい方向へたどり、最新位置へ戻ると下書きを復元することを固定する。
const HISTORY = ["SELECT 3;", "SELECT 2;", "SELECT 1;"]; // 3 が最新

describe("navigateOlder (↑)", () => {
  it("履歴が空なら null を返し通常のカーソル移動へ委ねる", () => {
    expect(navigateOlder([], "draft", initialHistoryNav)).toBeNull();
  });

  it("初回は現在の編集内容を下書きに退避して最新を読み込む", () => {
    const res = navigateOlder(HISTORY, "my draft", initialHistoryNav);
    expect(res).toEqual({
      state: { index: 0, draft: "my draft" },
      text: "SELECT 3;",
      cursor: "start",
    });
  });

  it("続けて押すと 1 つずつ古い履歴へ進み下書きは保持する", () => {
    const r1 = navigateOlder(HISTORY, "draft", initialHistoryNav)!;
    const r2 = navigateOlder(HISTORY, r1.text, r1.state)!;
    expect(r2.text).toBe("SELECT 2;");
    expect(r2.state).toEqual({ index: 1, draft: "draft" });
  });

  it("最古を超えてもクランプし、キーを消費し続ける", () => {
    const atOldest = { index: HISTORY.length - 1, draft: "draft" };
    const res = navigateOlder(HISTORY, "SELECT 1;", atOldest)!;
    expect(res.text).toBe("SELECT 1;");
    expect(res.state.index).toBe(HISTORY.length - 1);
    expect(res.cursor).toBe("start");
  });
});

describe("navigateNewer (↓)", () => {
  it("未ナビゲーションなら null を返す", () => {
    expect(navigateNewer(HISTORY, initialHistoryNav)).toBeNull();
  });

  it("1 つ新しい履歴へ戻る", () => {
    const res = navigateNewer(HISTORY, { index: 2, draft: "draft" })!;
    expect(res.text).toBe("SELECT 2;");
    expect(res.state).toEqual({ index: 1, draft: "draft" });
    expect(res.cursor).toBe("end");
  });

  it("最新位置を超えると下書きを復元してナビゲーションを終える", () => {
    const res = navigateNewer(HISTORY, { index: 0, draft: "my draft" })!;
    expect(res.text).toBe("my draft");
    expect(res.state).toEqual(initialHistoryNav);
    expect(res.cursor).toBe("end");
  });

  it("下書きが未保存 (null) なら空文字へ戻す", () => {
    const res = navigateNewer(HISTORY, { index: 0, draft: null })!;
    expect(res.text).toBe("");
    expect(res.state).toEqual(initialHistoryNav);
  });

  it("ナビゲーション中に履歴がクリアされて空になっても下書きへ安全に戻す", () => {
    // 履歴クリア等でナビゲーション中に history が空配列になったケース。
    // 修正前は history[nextIndex] が undefined になり、エディタが undefined で
    // 置換されてしまっていた。
    const res = navigateNewer([], { index: 2, draft: "my draft" })!;
    expect(res.text).toBe("my draft");
    expect(res.state).toEqual(initialHistoryNav);
    expect(res.cursor).toBe("end");
  });

  it("ナビゲーション中に履歴が縮んでも範囲内にクランプする (navigateOlder と対称)", () => {
    // 履歴が 3 件から 1 件に縮んだ状態で、まだ 3 件時点のインデックスを保持している。
    const res = navigateNewer(["only left"], { index: 5, draft: "draft" })!;
    expect(res.text).toBe("only left");
    expect(res.state.index).toBe(0);
    expect(res.cursor).toBe("end");
  });
});

describe("往復", () => {
  it("↑↑↓↓ で元の下書きに戻る", () => {
    let state = initialHistoryNav;
    const up1 = navigateOlder(HISTORY, "draft", state)!;
    state = up1.state;
    const up2 = navigateOlder(HISTORY, up1.text, state)!;
    state = up2.state;
    expect(up2.text).toBe("SELECT 2;");

    const down1 = navigateNewer(HISTORY, state)!;
    state = down1.state;
    expect(down1.text).toBe("SELECT 3;");

    const down2 = navigateNewer(HISTORY, state)!;
    expect(down2.text).toBe("draft");
    expect(down2.state).toEqual(initialHistoryNav);
  });
});

describe("dedupeAdjacentHistory / pushHistoryEntry (#1256)", () => {
  it("隣り合う重複だけを畳む (離れた重複は残す)", () => {
    expect(dedupeAdjacentHistory(["a", "a", "b", "a", "a"])).toEqual(["a", "b", "a"]);
    expect(dedupeAdjacentHistory([])).toEqual([]);
  });

  it("実行直後の SQL を先頭へ積む", () => {
    expect(pushHistoryEntry(["SELECT 2", "SELECT 1"], "SELECT 3")).toEqual([
      "SELECT 3",
      "SELECT 2",
      "SELECT 1",
    ]);
  });

  it("直前と同じ SQL は積まない (再取得後の畳み込みと同じ結果)", () => {
    const h = ["SELECT 2", "SELECT 1"];
    expect(pushHistoryEntry(h, "SELECT 2")).toEqual(h);
  });

  it("空白だけの SQL は積まない", () => {
    expect(pushHistoryEntry(["SELECT 1"], "  \n ")).toEqual(["SELECT 1"]);
  });

  it("上限を超えた古い分は捨てる", () => {
    const full = Array.from({ length: QUERY_HISTORY_LIMIT }, (_, i) => `q${i}`);
    const next = pushHistoryEntry(full, "new");
    expect(next).toHaveLength(QUERY_HISTORY_LIMIT);
    expect(next[0]).toBe("new");
    expect(next[next.length - 1]).toBe(`q${QUERY_HISTORY_LIMIT - 2}`);
  });
});
