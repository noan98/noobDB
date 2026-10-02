import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";
import {
  WORKSPACE_SURFACE_KEEP_ALIVE_LIMIT,
  workspaceSurfaceKey,
  workspaceViewKey,
  type WorkspaceViewInput,
  type WorkspaceViewKey,
} from "../components/workspaceView";

/**
 * ワークスペースの全画面ビュー切替 (#1020)。
 *
 * プロセス監視 / クエリインスペクタ / アドバイザは #1112 でボトムパネルへ移したため
 * ここには現れない (それらの判定は `bottomPanelTabs.test.ts`)。
 *
 * 判別子 (`workspaceViewKey`) はクロスフェードの `key` そのものなので、
 * 「排他なサーフェスがそれぞれ別の key になる」「同じサーフェスのまま props が
 * 変わっても key が変わらない」という 2 点が崩れると、切替が瞬間的に戻ったり
 * 逆に無用な再マウントが起きたりする。ここで純ロジックとして固定する。
 *
 * 併せて、`App.tsx` 側が実際にその判別子をワークスペース常駐 + keep-alive の
 * 重ね置き (#1311) に結線していること (= 判別子だけ作って結線を忘れていないこと) を
 * ソース走査で確認する (`?raw` インポートは `ipcCommandParity.test.ts` と同じ手法)。
 */

const base: WorkspaceViewInput = {
  showCompare: false,
  showErd: false,
  showUsers: false,
  showServerInfo: false,
  showSizes: false,
  showCompareResults: false,
  showForm: false,
  showSnippetForm: false,
  sessionId: null,
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
      workspaceViewKey({ ...connected, showUsers: true }),
      workspaceViewKey({ ...connected, showServerInfo: true }),
      workspaceViewKey({ ...connected, showSizes: true, sizesTarget: "app" }),
    ];
    expect(keys).toEqual(["erd", "users", "serverInfo", "sizes"]);
    // すべて相異なる = どの組み合わせの切替でも key が変わる。
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("セッションが無いと接続スコープのパネルは開かず workspace のまま", () => {
    expect(workspaceViewKey({ ...base, showErd: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showUsers: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showServerInfo: true })).toBe("workspace");
    expect(workspaceViewKey({ ...base, showSizes: true, sizesTarget: "app" })).toBe("workspace");
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
    // erd は users より前。
    expect(workspaceViewKey({ ...connected, showErd: true, showUsers: true })).toBe("erd");
    // form は snippetForm より前。
    expect(workspaceViewKey({ ...base, showForm: true, showSnippetForm: true })).toBe("form");
    // 接続スコープのパネルは、開けないときだけ後続 (フォーム) へ落ちる。
    expect(workspaceViewKey({ ...base, showErd: true, showForm: true })).toBe("form");
  });

  it("同じサーフェスのまま入力が変わっても key は不変 (無駄な再マウントをしない)", () => {
    const a = workspaceViewKey({
      ...base,
      sessionId: "sess1",
      showSizes: true,
      sizesTarget: "app",
    });
    const b = workspaceViewKey({
      ...base,
      sessionId: "sess2",
      showSizes: true,
      sizesTarget: "other",
    });
    expect(a).toBe(b);
  });
});

describe("workspaceSurfaceKey (#1311)", () => {
  const input = { sessionId: "s1", database: "app", sizesTarget: "app" };

  it("フォーム 2 種と通常のワークスペースは保持の対象外 (null)", () => {
    expect(workspaceSurfaceKey("form", input)).toBeNull();
    expect(workspaceSurfaceKey("snippetForm", input)).toBeNull();
    expect(workspaceSurfaceKey("workspace", input)).toBeNull();
  });

  it("接続を持たないサーフェスは view 名のまま", () => {
    expect(workspaceSurfaceKey("compare", { ...input, sessionId: null })).toBe("compare");
    expect(workspaceSurfaceKey("compareResults", input)).toBe("compareResults");
  });

  it("接続スコープのサーフェスは接続と対象 DB が変われば別インスタンスになる", () => {
    const erd = workspaceSurfaceKey("erd", input);
    expect(workspaceSurfaceKey("erd", { ...input, sessionId: "s2" })).not.toBe(erd);
    expect(workspaceSurfaceKey("erd", { ...input, database: "other" })).not.toBe(erd);
    expect(workspaceSurfaceKey("erd", input)).toBe(erd);
    const sizes = workspaceSurfaceKey("sizes", input);
    expect(workspaceSurfaceKey("sizes", { ...input, sizesTarget: "other" })).not.toBe(sizes);
    // view が違えば同じ接続・DB でも別キー。
    expect(workspaceSurfaceKey("users", input)).not.toBe(erd);
  });

  it("保持数には上限がある", () => {
    expect(WORKSPACE_SURFACE_KEEP_ALIVE_LIMIT).toBeGreaterThanOrEqual(1);
    expect(WORKSPACE_SURFACE_KEEP_ALIVE_LIMIT).toBeLessThanOrEqual(5);
  });
});

describe("App.tsx の結線 (#1311)", () => {
  it("全画面サーフェスの切替に mode=\"wait\" を使わない (退場待ちをなくす)", () => {
    expect(appSource).not.toMatch(/AnimatePresence mode="wait" initial=\{false\}/);
    // サイドバー・ボトムパネルのタブ切替・結果ペイン・全画面サーフェスのいずれも。
    expect(appSource).not.toMatch(/key=\{workspaceView\}[\s\S]{0,200}exit=\{variants\.fade\.exit\}/);
  });

  it("ワークスペースを常駐させ、サーフェスはその上に重ねる", () => {
    expect(appSource).toMatch(/const workspaceView = workspaceViewKey\(/);
    // 常駐するワークスペース層は、サーフェス表示中だけ inert + visibility:hidden。
    expect(appSource).toMatch(/inert=\{workspaceView !== "workspace" \|\| undefined\}/);
    expect(appSource).toMatch(/visibility: workspaceView === "workspace" \? "visible" : "hidden"/);
    // サーフェスは keep-alive (遅延マウント + 上限付き保持)。
    expect(appSource).toMatch(
      /<KeepAlive\s+activeKey=\{workspaceSurfaceKey\(workspaceView,[\s\S]{0,300}limit=\{WORKSPACE_SURFACE_KEEP_ALIVE_LIMIT\}/,
    );
  });

  it("Suspense は KeepAlive の内側 (サーフェス単位) に置く", () => {
    expect(appSource).toMatch(
      /<KeepAlive[\s\S]{0,500}?>\s*<Suspense fallback=\{<PaneEmpty><Spinner size=\{20\} \/><\/PaneEmpty>\}>\s*\{showCompare \? \(/,
    );
  });

  it("サイドバーの ConnectionList は常駐し (離れても loadSchemaTree をやり直さない)、ほかのタブは keep-alive", () => {
    // ConnectionList はタブ分岐の三項に入れない (= タブ切替でアンマウントされない)。
    expect(appSource).not.toMatch(/sidebarTab === "connections" \? \(\s*<ConnectionList/);
    expect(appSource).toMatch(/hidden=\{sidebarTab !== "connections"\}[\s\S]{0,200}inert=\{sidebarTab !== "connections" \|\| undefined\}/);
    expect(appSource).toMatch(/<KeepAlive\s+activeKey=\{sidebarTab === "connections" \? null : sidebarTab\}/);
  });

  it("ボトムパネルは接続切替で保持した中身を捨てる", () => {
    expect(appSource).toMatch(/<BottomPanel[\s\S]{0,300}resetKey=\{sessionId\}/);
  });
});
