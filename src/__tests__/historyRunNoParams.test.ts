import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 履歴の「実行」(handleRunSqlInNewTab) は展開済みの SQL を再実行するので、パラメータ解決
// (resolveParamsThen) を通さず runInTabWithGate で実行する (#2425)。App 全体は描画できないため
// ソースの該当ブロックで固定する。
describe("履歴の実行はパラメータ解決を通さない", () => {
  const src = readFileSync("src/App.tsx", "utf8");
  const start = src.indexOf("const handleRunSqlInNewTab = useCallback(");
  const block = src.slice(start, src.indexOf("\n  );", start));

  it("runInTabWithGate を使い resolveParamsThen を使わない", () => {
    expect(start).toBeGreaterThan(0);
    expect(block).toContain("runInTabWithGate(tab, sql");
    expect(block).not.toContain("resolveParamsThen");
  });
});
