import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import {
  BOTTOM_PANEL_TABS,
  BOTTOM_PANEL_TAB_GROUP,
  availableBottomPanelTabs,
  bottomPanelGroupStarts,
  bottomPanelStripTabs,
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

const connected = {
  sessionId: "sess1",
  advisorDatabase: "app",
  profileTable: "users",
  structureTable: "users",
  timelapseProfileId: "prof1",
  openConnectionCount: 1,
};

/** 接続に依存せず常に開けるログ系タブ (#1114)。 */
const LOG_TABS = ["output", "activity"];

describe("availableBottomPanelTabs", () => {
  it("未接続ではログ系 (出力 / メッセージ / アクティビティ) だけ開ける (#1114)", () => {
    // 接続失敗のメッセージこそ未接続のときに読みたいので、ログ系は接続を要求しない。
    expect(
      availableBottomPanelTabs({ sessionId: null, advisorDatabase: "app", openConnectionCount: 0 }),
    ).toEqual(LOG_TABS);
  });

  it("アクティブ接続が無くても背景接続があれば接続ヘルスも開ける (#1068)", () => {
    expect(
      availableBottomPanelTabs({ sessionId: null, advisorDatabase: "app", openConnectionCount: 2 }),
    ).toEqual([...LOG_TABS, "health"]);
  });

  it("接続していて対象が揃えば全タブを開ける (定義順を保つ)", () => {
    expect(availableBottomPanelTabs(connected)).toEqual([...BOTTOM_PANEL_TABS]);
  });

  it("対象データベースが決まらないとアドバイザだけ落ちる", () => {
    for (const db of [null, undefined, ""]) {
      expect(
        availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: db, openConnectionCount: 1 }),
      ).toEqual([...LOG_TABS, "inspector", "processes", "assertions", "health", "whereUsed"]);
    }
  });

  it("「列を探索」(#974) は対象テーブルが決まったときだけ開ける", () => {
    for (const table of [null, undefined, ""]) {
      expect(
        availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: "app", profileTable: table, openConnectionCount: 1 }),
      ).not.toContain("profile");
    }
    expect(
      availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: "app", profileTable: "users", openConnectionCount: 1 }),
    ).toContain("profile");
  });
});

describe("構造タブ (#1112)", () => {
  it("対象テーブルが決まったときだけ開ける", () => {
    for (const table of [null, undefined, ""]) {
      expect(availableBottomPanelTabs({ ...connected, structureTable: table })).not.toContain("structure");
    }
    expect(availableBottomPanelTabs(connected)).toContain("structure");
  });

  it("未接続では対象テーブルが残っていても開けない", () => {
    expect(
      availableBottomPanelTabs({ ...connected, sessionId: null, openConnectionCount: 0 }),
    ).not.toContain("structure");
  });

  it("対象が外れたら構造タブを閉じる", () => {
    expect(resolveBottomPanelTab("structure", { ...connected, structureTable: null })).toBeNull();
    expect(resolveBottomPanelTab("structure", connected)).toBe("structure");
  });
});

describe("タイムラプスタブ (#739)", () => {
  it("保存済みプロファイルで接続しているときだけ開ける (参照グループ)", () => {
    expect(availableBottomPanelTabs(connected)).toContain("timelapse");
    for (const id of [null, undefined, ""]) {
      expect(availableBottomPanelTabs({ ...connected, timelapseProfileId: id })).not.toContain("timelapse");
    }
    expect(
      availableBottomPanelTabs({ ...connected, sessionId: null, openConnectionCount: 0 }),
    ).not.toContain("timelapse");
    expect(BOTTOM_PANEL_TAB_GROUP.timelapse).toBe("reference");
  });

  it("App.tsx にパネルとツリーからの登録導線が結線されている", () => {
    expect(appSource).toContain("timelapseProfileId: selectedProfile?.id");
    expect(appSource).toContain('activeBottomPanelTab === "timelapse"');
    expect(appSource).toContain("<TableTimelapsePanel");
    expect(appSource).toContain("onWatchTable={handleWatchTable}");
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
      resolveBottomPanelTab("processes", {
        sessionId: null,
        advisorDatabase: "app",
        openConnectionCount: 0,
      }),
    ).toBeNull();
    expect(
      resolveBottomPanelTab("health", { sessionId: null, advisorDatabase: "app", openConnectionCount: 0 }),
    ).toBeNull();
  });

  it("プロファイル対象が外れたら「列を探索」を閉じる", () => {
    expect(resolveBottomPanelTab("profile", { ...connected, profileTable: null })).toBeNull();
  });

  it("対象データベースが外れたらアドバイザだけ閉じる (他タブは残る)", () => {
    const ctx = { sessionId: "sess1", advisorDatabase: null, openConnectionCount: 1 };
    expect(resolveBottomPanelTab("advisor", ctx)).toBeNull();
    expect(resolveBottomPanelTab("inspector", ctx)).toBe("inspector");
    expect(resolveBottomPanelTab("processes", ctx)).toBe("processes");
  });
});

describe("用途グループ (#1114)", () => {
  it("Output / Activity / Advisor の用途で並ぶ (ログ → 診断 → 参照)", () => {
    // 旧「メッセージ」タブはアクティビティへ統合した (同じ出来事が 2 タブに並んでいた)。
    expect(BOTTOM_PANEL_TABS.slice(0, 3)).toEqual(["output", "activity", "advisor"]);
    // 同じグループのタブは連続して並ぶ (グループが飛び飛びにならない)。
    const order = BOTTOM_PANEL_TABS.map((tab) => BOTTOM_PANEL_TAB_GROUP[tab]);
    const collapsed = order.filter((g, i) => i === 0 || g !== order[i - 1]);
    expect(collapsed).toEqual(["log", "diagnostics", "reference"]);
  });

  it("区切り線はグループが変わるタブの手前にだけ引く", () => {
    expect([...bottomPanelGroupStarts(BOTTOM_PANEL_TABS)]).toEqual(["advisor", "whereUsed"]);
  });

  it("開けないタブが抜けた並びでも、実際に隣り合うタブ同士で判定する", () => {
    // 未接続: ログ系 + 接続ヘルス → 区切りは health の手前の 1 本。
    expect([...bottomPanelGroupStarts([...LOG_TABS, "health"] as BottomPanelTab[])]).toEqual(["health"]);
    // ログ系だけ → 区切りなし。
    expect(bottomPanelGroupStarts(LOG_TABS as BottomPanelTab[]).size).toBe(0);
    expect(bottomPanelGroupStarts([]).size).toBe(0);
  });

  it("ログ系は切断しても閉じない", () => {
    for (const tab of LOG_TABS as BottomPanelTab[]) {
      expect(
        resolveBottomPanelTab(tab, { sessionId: null, advisorDatabase: null, openConnectionCount: 0 }),
      ).toBe(tab);
    }
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
    expect(nextBottomPanelTab(tabs, "timelapse", 1)).toBe("output");
    expect(nextBottomPanelTab(tabs, "output", -1)).toBe("timelapse");
  });

  it("影響分析 (#1027) は対象 DB が決まらなくても開ける (DB はパネル内で選ぶ)", () => {
    expect(
      availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: null, openConnectionCount: 1 }),
    ).toContain("whereUsed");
  });

  it("データ品質アサーション (#742) は対象 DB が決まらなくても開ける (セッション既定で検証)", () => {
    expect(
      availableBottomPanelTabs({ sessionId: "sess1", advisorDatabase: null, openConnectionCount: 1 }),
    ).toContain("assertions");
    expect(
      availableBottomPanelTabs({ sessionId: null, advisorDatabase: "app", openConnectionCount: 1 }),
    ).not.toContain("assertions");
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

  it("データ品質アサーション (#742) の結線: 違反行クエリは実行せずに新規タブで開く", () => {
    expect(appSource).toContain('activeBottomPanelTab === "assertions"');
    expect(appSource).toContain("onOpenSql={handleOpenAssertionSql}");
    expect(appSource).toContain('toggleBottomPanel("assertions")');
  });

  it("構造タブ (#1112) はツリーから開け、パネルからデータタブへ戻れる", () => {
    expect(appSource).toContain("structureTable: structureTarget?.table");
    expect(appSource).toContain('activeBottomPanelTab === "structure"');
    expect(appSource).toContain("onOpenStructure={handleOpenStructure}");
    expect(appSource).toContain("onOpenData={handleOpenTable}");
  });

  it("ログ系 2 タブ (#1114) を接続ガードより前で描き、記録元へ結線している", () => {
    const outputIdx = appSource.indexOf('activeBottomPanelTab === "output"');
    const guardIdx = appSource.indexOf("!sessionId ? null : activeBottomPanelTab");
    expect(outputIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeGreaterThan(outputIdx);
    expect(appSource).toContain("<OutputPanel onOpenSql={handleOpenHistoryInNewTab} />");
    expect(appSource).toContain("<ActivityLogPanel />");
    // 出力は実行経路の結果受信地点で、メッセージはステータスの変化で積む。
    expect(appSource).toMatch(/recordOutput\(/);
    expect(appSource).toMatch(/pushMessage\(cls\.severity, text, cls\.dedupeKey\)/);
  });

  it("ボトムパネルへ移した 3 つは全画面サーフェスとして残っていない", () => {
    // 残っていると「開くとエディタが消える」旧挙動へ戻る。
    for (const gone of ["showAdvisor", "showQueryInspector", "showProcesses"]) {
      expect(appSource).not.toContain(gone);
    }
  });
});

describe("bottomPanelStripTabs (折りたたみ時のパネルバー)", () => {
  const disabledTabs = (ctx: Parameters<typeof bottomPanelStripTabs>[0]) =>
    bottomPanelStripTabs(ctx).filter((e) => !e.enabled);

  it("未接続でもログ / 診断グループは並べ、診断は「接続が必要」で無効にする", () => {
    // 存在を見せるのが目的: 接続前に「プロセスモニタがある」と分かる。
    const entries = bottomPanelStripTabs({ sessionId: null, advisorDatabase: null, openConnectionCount: 0 });
    expect(entries.map((e) => e.tab)).toEqual([
      ...LOG_TABS,
      "advisor",
      "inspector",
      "processes",
      "assertions",
      "health",
    ]);
    expect(entries.slice(0, LOG_TABS.length).every((e) => e.enabled && e.reason === null)).toBe(true);
    for (const e of entries.slice(LOG_TABS.length)) {
      expect(e).toMatchObject({ enabled: false, reason: "needsSession" });
    }
  });

  it("参照グループは対象が揃っていても並べない (対象を決めて開くもの)", () => {
    const entries = bottomPanelStripTabs(connected);
    expect(entries.map((e) => e.tab)).toEqual(
      BOTTOM_PANEL_TABS.filter((tab) => BOTTOM_PANEL_TAB_GROUP[tab] !== "reference"),
    );
    expect(entries.every((e) => e.enabled && e.reason === null)).toBe(true);
  });

  it("接続中でも対象 DB が無ければアドバイザだけ「DB が必要」で無効", () => {
    expect(disabledTabs({ ...connected, advisorDatabase: null })).toEqual([
      { tab: "advisor", enabled: false, reason: "needsDatabase" },
    ]);
  });

  it("SQLite ではプロセスモニタとクエリインスペクタを非対応として無効にする (#732 / #746)", () => {
    // `availableBottomPanelTabs` は変えない (開けば中身が非対応の説明を出す)。
    expect(availableBottomPanelTabs({ ...connected, driver: "sqlite" })).toContain("processes");
    expect(disabledTabs({ ...connected, driver: "sqlite" })).toEqual([
      { tab: "inspector", enabled: false, reason: "sqliteUnsupported" },
      { tab: "processes", enabled: false, reason: "sqliteUnsupported" },
    ]);
    expect(disabledTabs({ ...connected, driver: "mysql" })).toEqual([]);
  });

  it("背景接続だけのときは接続ヘルスだけ開ける", () => {
    const entries = bottomPanelStripTabs({ sessionId: null, advisorDatabase: null, openConnectionCount: 1 });
    expect(entries.find((e) => e.tab === "health")).toMatchObject({ enabled: true });
    expect(entries.find((e) => e.tab === "processes")).toMatchObject({ enabled: false, reason: "needsSession" });
  });

  it("App.tsx でパネルバーが WorkspaceSplit の collapsed に結線されている", () => {
    expect(appSource).toContain("bottomPanelStripTabs(bottomPanelCtx)");
    expect(appSource).toContain("<BottomPanelStrip");
    expect(appSource).toMatch(/collapsed=\{\s*<BottomPanelStrip/);
    // SQLite 非対応の理由を出すためにドライバを渡す。
    expect(appSource).toContain("driver: sessionId ? (selectedProfile?.driver ?? null) : null");
  });

  it("パネルバーは全画面サーフェス中も隠さない (#1280): workspaceView で出し分けない", () => {
    // 開いたパネルは全画面サーフェスの下にも残り (WorkspaceSplit が <main> 全体を包む)、
    // 全画面中でもレンチメニュー / パレット / サイドバー右クリックから開ける。
    // 開閉状態と無関係にバーだけ隠すと入口の有無が不整合になるため、バーの表示条件に
    // workspaceView を持ち込まない。
    const start = appSource.indexOf("<WorkspaceSplit");
    const stripBlock = appSource.slice(start, appSource.indexOf("<BottomPanelStrip", start));
    expect(stripBlock).not.toContain("workspaceView");
    expect(stripBlock).not.toMatch(/workspaceView\w*\s*[!=]==/);
  });
});
