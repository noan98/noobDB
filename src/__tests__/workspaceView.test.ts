import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import {
  workspaceViewKey,
  type WorkspaceViewInput,
  type WorkspaceViewKey,
} from "../components/workspaceView";

/**
 * ワークスペースの全画面ビュー切替 (#1020)。
 *
 * 判別子 (`workspaceViewKey`) はクロスフェードの `key` そのものなので、
 * 「排他なサーフェスがそれぞれ別の key になる」「同じサーフェスのまま props が
 * 変わっても key が変わらない」という 2 点が崩れると、切替が瞬間的に戻ったり
 * 逆に無用な再マウントが起きたりする。ここで純ロジックとして固定する。
 *
 * 併せて、`App.tsx` 側が実際にその判別子を `AnimatePresence mode="wait"` +
 * `variants.fade` に載せていること (= 判別子だけ作って結線を忘れていないこと) を
 * ソース走査で確認する (`?raw` インポートは `ipcCommandParity.test.ts` と同じ手法)。
 */

const base: WorkspaceViewInput = {
  showCompare: false,
  showErd: false,
  showProcesses: false,
  showUsers: false,
  showServerInfo: false,
  showQueryInspector: false,
  showAdvisor: false,
  showSizes: false,
  showCompareResults: false,
  showForm: false,
  showSnippetForm: false,
  sessionId: null,
  advisorDatabase: null,
  sizesTarget: null,
};

describe("workspaceViewKey", () => {
  it("何も開いていなければ通常のワークスペース", () => {
    expect(workspaceViewKey(base)).toBe("workspace");
  });

  it("接続スコープのパネルは、それぞれ別の key になる (切替でクロスフェードが走る)", () => {
    const connected = { ...base, sessionId: "sess1" };
    const keys: WorkspaceViewKey[] = [
      workspaceViewKey({ ...connected, showErd: true }),
      workspaceViewKey({ ...connected, showProcesses: true }),
      workspaceViewKey({ ...connected, showUsers: true }),
      workspaceViewKey({ ...connected, showServerInfo: true }),
      workspaceViewKey({ ...connected, showQueryInspector: true }),
      workspaceViewKey({ ...connected, showAdvisor: true, advisorDatabase: "app" }),
      workspaceViewKey({ ...connected, showSizes: true, sizesTarget: "app" }),
    ];
    expect(keys).toEqual([
      "erd",
      "processes",
      "users",
      "serverInfo",
      "queryInspector",
      "advisor",
      "sizes",
    ]);
    // すべて相異なる = どの組み合わせの切替でも key が変わる。
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("セッションが無いと接続スコープのパネルは開かず workspace のまま", () => {
    expect(workspaceViewKey({ ...base, showErd: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showProcesses: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showUsers: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showServerInfo: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showQueryInspector: true })).toBe("workspace");
    expect(
      workspaceViewKey({ ...base, showAdvisor: true, advisorDatabase: "app" }),
    ).toBe("workspace");
    expect(workspaceViewKey({ ...base, showSizes: true, sizesTarget: "app" })).toBe("workspace");
  });

  it("Advisor は対象 DB が決まらなければ開かない", () => {
    const connected = { ...base, sessionId: "sess1", showAdvisor: true };
    expect(workspaceViewKey({ ...connected, advisorDatabase: null })).toBe("workspace");
    expect(workspaceViewKey({ ...connected, advisorDatabase: undefined })).toBe("workspace");
    expect(workspaceViewKey({ ...connected, advisorDatabase: "" })).toBe("workspace");
    expect(workspaceViewKey({ ...connected, advisorDatabase: "app" })).toBe("advisor");
  });

  it("テーブル統計は対象 DB が無ければ開かない", () => {
    const connected = { ...base, sessionId: "sess1", showSizes: true };
    expect(workspaceViewKey({ ...connected, sizesTarget: null })).toBe("workspace");
    expect(workspaceViewKey({ ...connected, sizesTarget: "app" })).toBe("sizes");
  });

  it("接続不要のサーフェス (比較・結果比較・各フォーム) はセッション無しでも開く", () => {
    expect(workspaceViewKey({ ...base, showCompare: true })).toBe("compare");
    expect(workspaceViewKey({ ...base, showCompareResults: true })).toBe("compareResults");
    expect(workspaceViewKey({ ...base, showForm: true })).toBe("form");
    expect(workspaceViewKey({ ...base, showSnippetForm: true })).toBe("snippetForm");
  });

  it("複数フラグが同時に立っても App.tsx の三項チェーンと同じ優先順位で 1 つに決まる", () => {
    const connected = { ...base, sessionId: "sess1" };
    // compare が最優先。
    expect(
      workspaceViewKey({ ...connected, showCompare: true, showErd: true, showForm: true }),
    ).toBe("compare");
    // erd は processes より前。
    expect(workspaceViewKey({ ...connected, showErd: true, showProcesses: true })).toBe("erd");
    // form は snippetForm より前。
    expect(workspaceViewKey({ ...base, showForm: true, showSnippetForm: true })).toBe("form");
    // 接続スコープのパネルは、開けないときだけ後続 (フォーム) へ落ちる。
    expect(workspaceViewKey({ ...base, showErd: true, showForm: true })).toBe("form");
  });

  it("同じサーフェスのまま入力が変わっても key は不変 (無駄な再マウントをしない)", () => {
    const a = workspaceViewKey({
      ...base,
      sessionId: "sess1",
      showAdvisor: true,
      advisorDatabase: "app",
    });
    const b = workspaceViewKey({
      ...base,
      sessionId: "sess2",
      showAdvisor: true,
      advisorDatabase: "other",
    });
    expect(a).toBe(b);
  });
});

describe("App.tsx の結線 (#1020)", () => {
  it("全画面ビューを AnimatePresence mode=\"wait\" + variants.fade でクロスフェードする", () => {
    // 判別子を計算しているか。
    expect(appSource).toMatch(/const workspaceView = workspaceViewKey\(/);
    // それを key にした motion.div が AnimatePresence mode="wait" 配下にあるか。
    const wrapper = appSource.match(
      /<AnimatePresence mode="wait" initial=\{false\}>\s*<motion\.div\s+key=\{workspaceView\}[\s\S]{0,400}?>/,
    );
    expect(wrapper).not.toBeNull();
    const wrapperSrc = wrapper?.[0] ?? "";
    // #788 の結果パネルと同じプリセットを流用し、尺を二重定義していないこと。
    expect(wrapperSrc).toContain("variants.fade.initial");
    expect(wrapperSrc).toContain("variants.fade.animate");
    expect(wrapperSrc).toContain("variants.fade.exit");
    expect(wrapperSrc).toContain("transitions.enter");
  });

  it("Suspense は AnimatePresence の外ではなく motion.div の内側に置く (退出が壊れないため)", () => {
    // motion.div の開始タグ直後に Suspense が来る形を要求する。外側に置くと、
    // 遅延ロードのサスペンドで退出中の旧ビューごとフォールバックへ差し替わる。
    expect(appSource).toMatch(
      /key=\{workspaceView\}[\s\S]{0,400}?>\s*<Suspense fallback=\{<PaneEmpty><Spinner size=\{20\} \/><\/PaneEmpty>\}>/,
    );
  });
});
