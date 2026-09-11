import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import {
  BOTTOM_PANEL_TABS,
  availableBottomPanelTabs,
  nextBottomPanelTab,
  resolveBottomPanelTab,
  toggleBottomPanelTab,
  type BottomPanelTab,
} from "../components/bottomPanelTabs";

/**
 * ボトムパネル (#1112 / Epic #1110 Phase 2) の純ロジック。
 *
 * アドバイザ / クエリインスペクタ / プロセスモニタは #1112 以前、`<main>` を丸ごと
 * 置き換える全画面サーフェスだった。ボトムパネルへ移したことで
 * **ワークスペースと同時に表示される**ようになり、「開けない文脈で開きっぱなしに
 * ならないこと」が新しい不変条件になる (全画面サーフェスのときは三項チェーンの
 * 条件が同時にガードしていた)。ここではその解決規則を固定する。
 *
 * 併せて `App.tsx` が実際にこの純ロジックへ結線されていること (= 関数だけ作って
 * 使い忘れていないこと) をソース走査で確認する (`workspaceView.test.ts` と同じ手法)。
 */

const connected = { sessionId: "sess1", advisorDatabase: "app" };

describe("availableBottomPanelTabs", () => {
  it("未接続ではどのタブも開けない", () => {
    expect(availableBottomPanelTabs({ sessionId: null, advisorDatabase: "app" })).toEqual([]);
  });

  it("接続していれば 3 タブとも開ける (定義順を保つ)", () => {
    expect(availableBottomPanelTabs(connected)).toEqual([...BOTTOM_PANEL_TABS]);
  });

  it("対象データベースが決まらないとアドバイザだけ落ちる", () => {
    for (const db of [null, undefined, ""]) {
      expect(availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: db })).toEqual([
        "inspector",
        "processes",
      ]);
    }
  });
});

describe("resolveBottomPanelTab", () => {
  it("閉じているときは null のまま", () => {
    expect(resolveBottomPanelTab(null, connected)).toBeNull();
  });

  it("開けるタブはそのまま通す", () => {
    for (const tab of BOTTOM_PANEL_TABS) {
      expect(resolveBottomPanelTab(tab, connected)).toBe(tab);
    }
  });

  it("切断したら開いていたタブを閉じる", () => {
    expect(
      resolveBottomPanelTab("processes", { sessionId: null, advisorDatabase: "app" }),
    ).toBeNull();
  });

  it("対象データベースが外れたらアドバイザだけ閉じる (他タブは残る)", () => {
    const ctx = { sessionId: "sess1", advisorDatabase: null };
    expect(resolveBottomPanelTab("advisor", ctx)).toBeNull();
    expect(resolveBottomPanelTab("inspector", ctx)).toBe("inspector");
    expect(resolveBottomPanelTab("processes", ctx)).toBe("processes");
  });
});

describe("toggleBottomPanelTab", () => {
  it("閉じている状態から選ぶと開く", () => {
    expect(toggleBottomPanelTab(null, "advisor")).toBe("advisor");
  });

  it("開いているタブをもう一度選ぶと閉じる", () => {
    expect(toggleBottomPanelTab("advisor", "advisor")).toBeNull();
  });

  it("別のタブを選ぶと切り替わる (閉じない)", () => {
    expect(toggleBottomPanelTab("advisor", "processes")).toBe("processes");
  });
});

describe("nextBottomPanelTab", () => {
  const tabs: readonly BottomPanelTab[] = BOTTOM_PANEL_TABS;

  it("矢印キーで隣のタブへ進む", () => {
    expect(nextBottomPanelTab(tabs, "advisor", 1)).toBe("inspector");
    expect(nextBottomPanelTab(tabs, "inspector", -1)).toBe("advisor");
  });

  it("端では折り返す", () => {
    expect(nextBottomPanelTab(tabs, "processes", 1)).toBe("advisor");
    expect(nextBottomPanelTab(tabs, "advisor", -1)).toBe("processes");
  });

  it("開けるタブだけの並びで折り返す (アドバイザが落ちている場合)", () => {
    const partial: readonly BottomPanelTab[] = ["inspector", "processes"];
    expect(nextBottomPanelTab(partial, "processes", 1)).toBe("inspector");
    expect(nextBottomPanelTab(partial, "inspector", -1)).toBe("processes");
  });

  it("並びに無いタブ / 空の並びでは移動しない", () => {
    expect(nextBottomPanelTab(["inspector"], "advisor", 1)).toBeNull();
    expect(nextBottomPanelTab([], "advisor", 1)).toBeNull();
  });
});

describe("App.tsx の結線 (#1112)", () => {
  it("ボトムパネルのタブは純ロジックで解決してから描画する", () => {
    // state を直接描画に使うと、切断後も開きっぱなしのタブが残りうる。
    expect(appSource).toMatch(/const activeBottomPanelTab = resolveBottomPanelTab\(/);
    expect(appSource).toMatch(/const bottomPanelTabs = availableBottomPanelTabs\(/);
    expect(appSource).toContain("tab={activeBottomPanelTab}");
  });

  it("同じタブの再選択で閉じられる (トグル) 入口を通す", () => {
    expect(appSource).toMatch(/setBottomPanelTab\(\(current\) => toggleBottomPanelTab\(current, tab\)\)/);
  });

  it("ワークスペースとボトムパネルの分割は共通の Splitter へ委ねる", () => {
    // 高さのリサイズ規則 (クランプ・永続化・キーボード操作) を二重実装しない。
    expect(appSource).toContain("<WorkspaceSplit");
  });

  it("ボトムパネルへ移した 3 つは全画面サーフェスとして残っていない", () => {
    // 残っていると「開くとエディタが消える」旧挙動へ戻る。
    for (const gone of ["showAdvisor", "showQueryInspector", "showProcesses"]) {
      expect(appSource).not.toContain(gone);
    }
  });
});
