import { describe, expect, it, vi } from "vitest";
import appSource from "../App.tsx?raw";
import { t } from "../i18n";
import {
  editorCommandItems,
  type EditorCommandContext,
} from "../components/editorCommands";

/**
 * SQL Editor の実行系・接続切替・アクティビティをコマンドパレットへ出す候補 (#1113)。
 * Issue の Command Palette 要件 (Run Query / Run Selected / Format SQL / Explain
 * Query / Switch Connection / Toggle Activity) がパレットから辿れること、可用条件
 * (未接続・エディタ無し・EXPLAIN タブ) が守られることを固定する。
 */

const base: EditorCommandContext = {
  sessionId: "s1",
  hasEditor: true,
  explainTab: false,
  openConnections: [
    { profileId: "p1", name: "Alpha", driver: "mysql", active: true },
    { profileId: "p2", name: "Beta", driver: "postgres", active: false },
  ],
  shortcuts: {
    run: "Ctrl+Enter",
    runStatement: "Ctrl+Alt+Enter",
    format: "Ctrl+Shift+F",
    explain: "Ctrl+E",
  },
};

function actions() {
  return {
    runAll: vi.fn(),
    runStatement: vi.fn(),
    formatSql: vi.fn(),
    explain: vi.fn(),
    focusEditor: vi.fn(),
    toggleActivity: vi.fn(),
    switchConnection: vi.fn(),
  };
}

const ids = (ctx: EditorCommandContext) => editorCommandItems(ctx, actions(), t).map((i) => i.id);

describe("editorCommandItems", () => {
  it("接続中でエディタがあれば実行・選択実行・EXPLAIN・整形を出す", () => {
    expect(ids(base)).toEqual(
      expect.arrayContaining([
        "editor:run",
        "editor:run-selected",
        "editor:explain",
        "editor:format",
        "editor:focus",
        "nav:toggle-activity",
      ]),
    );
  });

  it("各候補は対応するアクションを呼び、ショートカット表記を持つ", () => {
    const a = actions();
    const items = editorCommandItems(base, a, t);
    const byId = new Map(items.map((i) => [i.id, i]));
    byId.get("editor:run")?.run();
    byId.get("editor:run-selected")?.run();
    byId.get("editor:explain")?.run();
    byId.get("editor:format")?.run();
    byId.get("editor:focus")?.run();
    byId.get("nav:toggle-activity")?.run();
    expect(a.runAll).toHaveBeenCalledOnce();
    expect(a.runStatement).toHaveBeenCalledOnce();
    expect(a.explain).toHaveBeenCalledOnce();
    expect(a.formatSql).toHaveBeenCalledOnce();
    expect(a.focusEditor).toHaveBeenCalledOnce();
    expect(a.toggleActivity).toHaveBeenCalledOnce();
    expect(byId.get("editor:run")?.shortcut).toBe("Ctrl+Enter");
    expect(byId.get("editor:run-selected")?.shortcut).toBe("Ctrl+Alt+Enter");
    expect(byId.get("editor:explain")?.shortcut).toBe("Ctrl+E");
    expect(byId.get("editor:format")?.shortcut).toBe("Ctrl+Shift+F");
  });

  it("未接続なら実行系は出さないが、整形 (エディタ内で完結) とアクティビティは出す", () => {
    const got = ids({ ...base, sessionId: null });
    expect(got).not.toContain("editor:run");
    expect(got).not.toContain("editor:run-selected");
    expect(got).not.toContain("editor:explain");
    expect(got).toContain("editor:format");
    expect(got).toContain("nav:toggle-activity");
  });

  it("エディタを持つタブが無ければエディタ系を出さない", () => {
    const got = ids({ ...base, hasEditor: false });
    expect(got.filter((id) => id.startsWith("editor:"))).toEqual([]);
    expect(got).toContain("nav:toggle-activity");
  });

  it("EXPLAIN タブでは EXPLAIN / 選択実行を重ねて出さず、実行のラベルが EXPLAIN になる", () => {
    const items = editorCommandItems({ ...base, explainTab: true }, actions(), t);
    const got = items.map((i) => i.id);
    expect(got).not.toContain("editor:explain");
    expect(got).not.toContain("editor:run-selected");
    expect(items.find((i) => i.id === "editor:run")?.label).toBe(t("cmdkExplainRun"));
  });

  it("接続切替は背景で開いている接続だけを候補にし、選ぶとその接続へ切り替える", () => {
    const a = actions();
    const items = editorCommandItems(base, a, t).filter((i) => i.id.startsWith("switch:"));
    expect(items.map((i) => i.id)).toEqual(["switch:p2"]);
    expect(items[0].group).toBe("connections");
    expect(items[0].label).toBe(t("cmdkSwitchConnection", { name: "Beta" }));
    items[0].run();
    expect(a.switchConnection).toHaveBeenCalledWith("p2");
  });

  it("App.tsx のパレット候補に結線されている", () => {
    expect(appSource).toContain("...editorCommandItems(");
    expect(appSource).toContain("activeEditor()?.runAll()");
    expect(appSource).toContain("toggleActivityCenter()");
  });
});
