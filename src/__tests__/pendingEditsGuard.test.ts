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
    expect(many.indexOf("if (!ok) return;")).toBeGreaterThan(-1);
    expect(many.indexOf("if (!ok) return;")).toBeLessThan(many.indexOf("handleCloseTab(id)"));
  });

  it("確認キャンセル時に閉じたタブ履歴 (#1353) へ積まない: スナップショットは handleCloseTab の中だけ", () => {
    // スナップショットは handleCloseTab 内で取る。request* は確認後にだけそれを呼ぶので、
    // request* 自体が履歴を触っていないことを固定する。
    for (const name of ["requestCloseTab", "requestCloseTabs"]) {
      const b = body(name);
      expect(b).not.toContain("snapshotClosedTab");
      expect(b).not.toContain("pushClosedTab");
    }
    expect(body("handleCloseTab")).toContain("snapshotClosedTab(");
  });

  it("一括クローズ (closeTabsBulk) は確認付きの requestCloseTabs を通る", () => {
    const b = body("closeTabsBulk");
    expect(b).toContain("requestCloseTabs(tabsToClose(");
    expect(b).not.toContain("handleCloseTab(");
  });

  it("ユーザ操作の入口は確認付きを通り、素の handleCloseTab を直接呼ばない", () => {
    expect(appSource).toContain("void requestCloseTabRef.current(active)");
    expect(appSource).toContain("void requestCloseTab(tabMenu.tabId)");
    expect(appSource).toContain("handleCloseTab: requestCloseTab");
    expect(appSource).not.toMatch(/onSelect: \(\) => handleCloseTab\(/);
  });

  it("DROP などの自動クローズ (record: false) は確認なしのまま handleCloseTab を使う", () => {
    expect(appSource).toContain("handleCloseTabRef.current(tt.id, { record: false })");
    expect(appSource).not.toMatch(/requestCloseTab\w*(Ref\.current)?\([^)]*record: false/);
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

describe("結果を置き換える手動操作の入口 (#2234)", () => {
  it("runQueryInTab / goToPageInTab / runTxInTab は破棄の前に resolvePendingBeforeReplace を通り、キャンセルで中断する", () => {
    for (const name of ["runQueryInTab", "goToPageInTab", "runTxInTab"]) {
      const b = body(name);
      const at = b.indexOf("resolvePendingBeforeReplace(");
      expect(at, `${name} が確認を呼んでいない`).toBeGreaterThan(-1);
      expect(b.indexOf("pendingEdits: {}")).toBeGreaterThan(at);
      // 3 種 (セル編集 / 削除予定 / 追加行) を同じ patch で空にして揃える。
      expect(b).toContain("pendingDeletes: []");
      expect(b).toContain("pendingInserts: []");
    }
  });

  it("確認は 3 択 (適用 / 破棄 / キャンセル) で、適用の成功後にだけ続行する", () => {
    const b = body("resolvePendingBeforeReplace");
    expect(b).toContain("chooseDiscard(");
    expect(b).toContain('if (choice === "cancel") return null;');
    expect(
      b.indexOf("applyEditsForTabRef.current?.(latest, undefined, { skipReload: true })"),
    ).toBeGreaterThan(-1);
    expect(b).toContain("if (!ok) return null;");
  });

  it("Apply 後の取り直しと再読込は確認を省く", () => {
    expect(appSource.match(/skipPendingGuard: true/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
