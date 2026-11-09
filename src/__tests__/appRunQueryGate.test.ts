import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";

/**
 * 書き込みになりうる `api.runQuery(` が、App.tsx の中で実行ゲートを通らずに増えないことを固定する (#2176)。
 *
 * 新しいモーダルが DDL を直接 `api.runQuery` で流すと、本番 + confirm_writes・緊急モード・本番 DROP の型入力確認を
 * 素通りする。書き込みの経路は `runGuardedDdl` (共通ゲート) を通すか、自前で実行前確認を出して
 * いる経路だけを理由付きで許可リストに載せる。
 */

/** `api.runQuery(` を含むトップレベル `const <name> = ...` ごとの許可理由。 */
const ALLOWED: Record<string, string> = {
  loadMoreInTab: "読み取り専用の追加取得 (ページング)",
  goToPageInTab: "読み取り専用の追加取得 (ページング / keyset)",
  writeBlobForTab: "BLOB 書き戻し。接続設定に関わらず実行前に必ず確認する",
  handleRefetchLocalTable: "ローカルテーブルの取り直し (元クエリの読み取り)",
  handleTruncateTables: "一括 TRUNCATE。実行前の確認モーダルで本番は型入力 (#675)",
  handleRunTablesMaintenance: "一括保守。実行前の確認モーダルで本番は型入力 (#675)",
  handleDropTables: "一括 DROP。実行前の確認モーダルで本番は型入力 (#675)",
  // ゲート本体。呼び出し直前に runGuardedDdl を通ることは下のテストで確認する。
  runMaintenanceDdl: "共通ゲート経由の保守 DDL",
  runNamespaceDdl: "共通ゲート経由の名前空間 DDL",
  handleSaveAsViewConfirm: "CREATE VIEW。runGuardedDdl 経由",
};

function callSites(): { name: string; index: number }[] {
  const sites: { name: string; index: number }[] = [];
  for (const m of appSource.matchAll(/\bapi\.runQuery\(/g)) {
    const index = m.index ?? 0;
    const names = [...appSource.slice(0, index).matchAll(/^ {2}const (\w+)/gm)];
    sites.push({ name: names[names.length - 1]?.[1] ?? "(unknown)", index });
  }
  return sites;
}

describe("App.tsx の api.runQuery は実行ゲートか許可リストだけ (#2176)", () => {
  const sites = callSites();

  it("呼び出し箇所を検出できている", () => {
    expect(sites.length).toBeGreaterThan(5);
  });

  it("許可リスト外の関数 (またはインライン JSX) から直接呼ばない", () => {
    const stray = sites.filter((s) => !(s.name in ALLOWED));
    for (const s of stray) {
      // JSX のインライン onExecute などは、直前で runGuardedDdl を呼んでいればよい。
      const before = appSource.slice(Math.max(0, s.index - 600), s.index);
      expect(before, `${s.name} の api.runQuery が実行ゲート (runGuardedDdl) を通っていない`).toContain(
        "runGuardedDdl(",
      );
    }
  });

  it("許可リストに使われていない項目が残っていない", () => {
    const used = new Set(sites.map((s) => s.name));
    for (const name of Object.keys(ALLOWED)) expect(used.has(name), `${name} は不要`).toBe(true);
  });

  it("ゲート付きの DDL ラッパーは api.runQuery より前に runGuardedDdl を呼ぶ", () => {
    for (const name of ["runMaintenanceDdl", "runNamespaceDdl", "handleSaveAsViewConfirm"]) {
      const start = appSource.indexOf(`const ${name} = useCallback(`);
      expect(start, name).toBeGreaterThan(-1);
      const rest = appSource.slice(start);
      expect(rest.indexOf("runGuardedDdl("), name).toBeGreaterThan(-1);
      expect(rest.indexOf("runGuardedDdl("), name).toBeLessThan(rest.indexOf("api.runQuery("));
    }
  });
});
