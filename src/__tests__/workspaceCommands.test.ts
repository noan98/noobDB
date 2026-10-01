import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import { t } from "../i18n";
import {
  workspaceCommandItems,
  type WorkspaceCommandContext,
} from "../components/workspaceCommands";

/**
 * App Shell の操作をコマンドパレットへ出す候補 (#1112)。Sidebar / Bottom Panel /
 * テーブル構造への導線がパレットからも辿れること、可用条件 (未接続・SQLite・
 * 対象 DB 無し) が守られることを固定する。
 */

const base: WorkspaceCommandContext = {
  sessionId: "s1",
  driver: "mysql",
  database: "app",
  openConnectionCount: 1,
  sidebarCollapsed: false,
  profileDatabase: "app",
  tables: [
    { database: "app", table: "users" },
    { database: "app", table: "orders" },
  ],
  shortcuts: { toggleSidebar: "Ctrl+B", sidebarFilter: "Ctrl+P", objectSearch: "Ctrl+Shift+O" },
};

function actions() {
  return {
    toggleBottomPanel: vi.fn(),
    toggleSidebar: vi.fn(),
    focusExplorer: vi.fn(),
    openStructure: vi.fn(),
    openObjectSearch: vi.fn(),
    openDataSearch: vi.fn(),
    openSchemaDrift: vi.fn(),
    openUsers: vi.fn(),
    openServerInfo: vi.fn(),
    openTasks: vi.fn(),
  };
}

const ids = (ctx: WorkspaceCommandContext) =>
  workspaceCommandItems(ctx, actions(), t).map((i) => i.id);

describe("workspaceCommandItems", () => {
  it("接続中は Sidebar / Bottom Panel / 構造の候補がそろう", () => {
    expect(ids(base)).toEqual([
      "nav:toggle-sidebar",
      "nav:focus-explorer",
      "nav:output",
      "nav:activityPanel",
      "nav:advisor",
      "nav:inspector",
      "nav:processes",
      "nav:assertions",
      "nav:connectionHealth",
      "nav:whereUsed",
      "structure:app\0users",
      "structure:app\0orders",
      "nav:object-search",
      "nav:data-search",
      "nav:schema-drift",
      "nav:users",
      "nav:server-info",
      "nav:tasks",
    ]);
  });

  it("未接続でもサイドバー操作とログ系パネル (#1114) は出す。接続系は出さない", () => {
    expect(ids({ ...base, sessionId: null, driver: null, openConnectionCount: 0 })).toEqual([
      "nav:toggle-sidebar",
      "nav:focus-explorer",
      "nav:output",
      "nav:activityPanel",
      "nav:tasks",
    ]);
  });

  it("検索・管理系 (#1267 / #1268) の可用条件はレンチメニューと揃う", () => {
    const sqlite = ids({ ...base, driver: "sqlite" });
    expect(sqlite).not.toContain("nav:users");
    expect(sqlite).toContain("nav:server-info");
    const noDb = ids({ ...base, database: null, profileDatabase: null });
    expect(noDb).not.toContain("nav:data-search");
    expect(noDb).not.toContain("nav:schema-drift");
    expect(noDb).toContain("nav:object-search");
  });

  it("検索・管理系の候補は対応するアクションを呼び、検索はショートカットを添える", () => {
    const a = actions();
    const items = workspaceCommandItems(base, a, t);
    for (const [id, fn] of [
      ["nav:object-search", a.openObjectSearch],
      ["nav:data-search", a.openDataSearch],
      ["nav:schema-drift", a.openSchemaDrift],
      ["nav:users", a.openUsers],
      ["nav:server-info", a.openServerInfo],
      ["nav:tasks", a.openTasks],
    ] as const) {
      items.find((i) => i.id === id)?.run();
      expect(fn).toHaveBeenCalledOnce();
    }
    expect(items.find((i) => i.id === "nav:object-search")?.shortcut).toBe("Ctrl+Shift+O");
  });

  it("ログ系の候補はそれぞれのボトムパネルタブを開閉する (#1114)", () => {
    const acts = actions();
    const items = workspaceCommandItems(base, acts, t);
    for (const [id, tab] of [
      ["nav:output", "output"],
      ["nav:activityPanel", "activity"],
    ] as const) {
      items.find((i) => i.id === id)?.run();
      expect(acts.toggleBottomPanel).toHaveBeenLastCalledWith(tab);
    }
  });

  it("背景接続だけなら接続ヘルスは出す", () => {
    expect(ids({ ...base, sessionId: null, openConnectionCount: 2 })).toContain("nav:connectionHealth");
  });

  it("SQLite ではインスペクタ / プロセス一覧を出さない", () => {
    const got = ids({ ...base, driver: "sqlite" });
    expect(got).not.toContain("nav:inspector");
    expect(got).not.toContain("nav:processes");
  });

  it("対象 DB が決まらないとアドバイザを出さない", () => {
    expect(ids({ ...base, database: null })).not.toContain("nav:advisor");
  });

  it("サイドバーの開閉ラベルは状態で出し分け、ショートカットを添える", () => {
    const open = workspaceCommandItems(base, actions(), t)[0];
    expect(open.label).toBe(t("sidebarCollapse"));
    expect(open.shortcut).toBe("Ctrl+B");
    const closed = workspaceCommandItems({ ...base, sidebarCollapsed: true }, actions(), t)[0];
    expect(closed.label).toBe(t("sidebarExpand"));
  });

  it("各候補は対応するアクションを呼ぶ", () => {
    const a = actions();
    const items = workspaceCommandItems(base, a, t);
    const run = (id: string) => items.find((i) => i.id === id)?.run();
    run("nav:toggle-sidebar");
    run("nav:focus-explorer");
    run("nav:inspector");
    run("structure:app\0orders");
    expect(a.toggleSidebar).toHaveBeenCalledOnce();
    expect(a.focusExplorer).toHaveBeenCalledOnce();
    expect(a.toggleBottomPanel).toHaveBeenCalledWith("inspector");
    expect(a.openStructure).toHaveBeenCalledWith("app", "orders");
  });

  it("構造の候補はテーブル群に並び、DB 名を副表示にする", () => {
    const item = workspaceCommandItems(base, actions(), t).find((i) => i.id === "structure:app\0users");
    expect(item).toMatchObject({ group: "tables", sublabel: "app", icon: "columns" });
    expect(item?.label).toBe(t("cmdkTableStructure", { table: "users" }));
  });
});

describe("App.tsx の結線 (#1112)", () => {
  it("パレットは workspaceCommandItems 経由で Shell の操作を並べる", () => {
    expect(appSource).toContain("...workspaceCommandItems(");
  });
});
