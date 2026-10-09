import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";

/**
 * 未確定のセル編集の保護 (#1391) の配線をソースで固定する。App 全体を描画せずに、
 * 「キャンセル時に破壊的処理へ進まない」「Undo 満了後は再確認しない」といった
 * 呼び順の退行を検出する。
 */

/** `const <name> = useCallback(` から次のトップレベル `useCallback` までの本体。 */
function body(name: string): string {
  const start = appSource.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} が見つからない`).toBeGreaterThan(-1);
  const next = appSource.indexOf("\n  const ", start + 10);
  return appSource.slice(start, next === -1 ? undefined : next);
}

describe("requestCloseTab / requestCloseTabs", () => {
  it("キャンセル (return) より後でしか閉じ処理を呼ばない", () => {
    const one = body("requestCloseTab");
    expect(one.indexOf("if (!ok) return;")).toBeGreaterThan(-1);
    expect(one.indexOf("if (!ok) return;")).toBeLessThan(one.indexOf("handleCloseTab(id)"));
    const many = body("requestCloseTabs");
    expect(many.indexOf("if (!ok) return;")).toBeLessThan(many.indexOf("closeTabsAsGroup(ids)"));
  });

  it("ユーザ操作の入口は確認付きを通り、素の handleCloseTab / closeTabsAsGroup を直接呼ばない", () => {
    expect(appSource).toContain("void requestCloseTabRef.current(active)");
    expect(appSource).toContain("void requestCloseTabs(tabsToClose(");
    expect(appSource).toContain("void requestCloseTab(tabMenu.tabId)");
    expect(appSource).toContain("handleCloseTab: requestCloseTab");
    expect(appSource).not.toMatch(/onSelect: \(\) => (handleCloseTab|closeTabsAsGroup)\(/);
  });
});

describe("接続の切断 / 削除 / サンドボックス破棄", () => {
  it("handleDisconnect は force でなければ確認し、キャンセルで false を返す", () => {
    const b = body("handleDisconnect");
    expect(b).toContain("!opts?.force && !(await confirmDiscardPendingEdits())) return false");
  });

  it("finalizeProfileDelete は force で切断する (Undo 満了後に再確認しない)", () => {
    expect(body("finalizeProfileDelete")).toContain("handleDisconnectProfile(id, { force: true })");
  });

  it("handleDeleteProfile は確認を先に行い、キャンセルならタイマーも非表示化もしない", () => {
    const b = body("handleDeleteProfile");
    const confirmAt = b.indexOf("confirmDiscardPendingEdits()");
    expect(confirmAt).toBeGreaterThan(-1);
    expect(confirmAt).toBeLessThan(b.indexOf("setPendingDeleteProfileIds"));
    expect(confirmAt).toBeLessThan(b.indexOf("setTimeout"));
  });

  it("handleDiscardSandbox は切断がキャンセルされたら discardSandbox へ進まない", () => {
    const b = body("handleDiscardSandbox");
    expect(b).toContain("if (!(await handleDisconnectProfile(sandboxProfileId(record.id)))) return;");
    expect(b.indexOf("return;")).toBeLessThan(b.indexOf("api.discardSandbox"));
  });
});
