import { describe, expect, it } from "vitest";
import appSource from "../App.tsx?raw";

/**
 * 書き込みになりうる `api.runQuery(` / `api.runQueryTransaction(` が、App.tsx の中で実行ゲートを通らずに
 * 増えないことを固定する (#2176)。
 *
 * 新しいモーダルが DDL を直接流すと、本番 + confirm_writes・緊急モード・本番 DROP の型入力確認を素通りする。
 * 書き込みの経路は `runGuardedDdl` (共通ゲート) を通すか、自前で実行前確認を出している経路だけを、
 * 理由と呼び出し件数付きで許可リストに載せる。
 *
 * - read: 読み取り専用の取得
 * - confirmed: 実行前に `await confirm(` で確認する (本番は型入力)
 * - gated: 実行前に `runGuardedDdl(` を通る
 */
type Kind = "read" | "confirmed" | "gated";
const ALLOWED: Record<string, { count: number; kind: Kind; reason: string }> = {
  loadMoreInTab: { count: 1, kind: "read", reason: "追加取得 (ページング)" },
  goToPageInTab: { count: 2, kind: "read", reason: "ページング / keyset" },
  handleRefetchLocalTable: {
    count: 1,
    kind: "read",
    reason: "ローカルテーブルの取り直し (元クエリの読み取り)",
  },
  writeBlobForTab: { count: 1, kind: "confirmed", reason: "BLOB 書き戻し。常に確認する" },
  replaceColumnForTab: { count: 1, kind: "confirmed", reason: "列の一括置換。常に確認し本番は型入力" },
  handleAlterTableRun: { count: 1, kind: "confirmed", reason: "ALTER TABLE。確認モーダル付き" },
  handleTruncateTables: { count: 3, kind: "confirmed", reason: "一括 TRUNCATE (#675)" },
  handleRunTablesMaintenance: { count: 1, kind: "confirmed", reason: "一括保守 (#675)" },
  handleDropTables: { count: 2, kind: "confirmed", reason: "一括 DROP (#675)" },
  runMaintenanceDdl: { count: 1, kind: "gated", reason: "共通ゲート経由の保守 DDL" },
  runNamespaceDdl: { count: 1, kind: "gated", reason: "共通ゲート経由の名前空間 DDL" },
  handleSaveAsViewConfirm: { count: 2, kind: "gated", reason: "CREATE / REPLACE VIEW" },
  handleCloneTableConfirm: { count: 1, kind: "gated", reason: "テーブル複製" },
};

interface Site {
  name: string;
  /** 宣言の先頭から呼び出しまでの本文 (インライン JSX は直前の一定範囲)。 */
  before: string;
}

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const m of appSource.matchAll(/\bapi\.runQuery(?:Transaction)?\(/g)) {
    const index = m.index ?? 0;
    const head = appSource.slice(0, index);
    const consts = [...head.matchAll(/^ {2}const (\w+)/gm)];
    const last = consts[consts.length - 1];
    const start = last?.index ?? 0;
    // const 宣言と呼び出しの間にインデント 2 の別のトップレベル文 (useEffect / function / return など) が
    // あれば、その const の本文ではない (= unknown 扱い)。閉じ括弧の行 (`  );` `  }`) は文ではない。
    const between = head.slice(start + 1);
    const foreign = /\n {2}(?!const |[)}\]\s])\S/.test(between);
    sites.push(
      foreign || !last
        ? { name: "(unknown)", before: head.slice(Math.max(0, index - 1500)) }
        : { name: last[1], before: head.slice(start) },
    );
  }
  return sites;
}

describe("App.tsx の api.runQuery(Transaction) は実行ゲートか許可リストだけ (#2176)", () => {
  const sites = callSites();

  it("呼び出し箇所を検出できている", () => {
    expect(sites.length).toBeGreaterThan(10);
  });

  it("許可リスト外 (unknown を含む) は直前に runGuardedDdl を呼ぶ", () => {
    for (const s of sites.filter((x) => !(x.name in ALLOWED))) {
      expect(s.before, `${s.name} の呼び出しが実行ゲート (runGuardedDdl) を通っていない`).toContain(
        "runGuardedDdl(",
      );
    }
  });

  it("許可リストの関数ごとの呼び出し件数が一致する (許可済み関数内への追加も検出する)", () => {
    for (const [name, { count }] of Object.entries(ALLOWED)) {
      expect(sites.filter((s) => s.name === name).length, `${name} の呼び出し件数`).toBe(count);
    }
  });

  it("kind ごとの前提: gated は runGuardedDdl、confirmed は await confirm の呼び出しが実行より前にある", () => {
    for (const s of sites) {
      const a = ALLOWED[s.name];
      if (!a) continue;
      if (a.kind === "gated") expect(s.before, s.name).toContain("runGuardedDdl(");
      if (a.kind === "confirmed") expect(s.before, s.name).toMatch(/await confirm\(/);
    }
  });

  it("alreadyConfirmed: true の自己申告は、同じ関数内で前に await confirm の呼び出しがある", () => {
    const marks = [...appSource.matchAll(/alreadyConfirmed: (?:true|!!appendSql)/g)];
    expect(marks.length).toBeGreaterThan(5);
    for (const m of marks) {
      const index = m.index ?? 0;
      const head = appSource.slice(0, index);
      const consts = [...head.matchAll(/^ {2}const (\w+)/gm)];
      const last = consts[consts.length - 1];
      const body = head.slice(last?.index ?? 0);
      expect(body, `${last?.[1]} の alreadyConfirmed の前に確認がない`).toMatch(/await confirm\(/);
    }
  });
});
