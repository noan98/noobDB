import { describe, it, expect } from "vitest";
import { statusColors } from "../components/diffStatusColors";
import { semanticColorVar } from "../semanticColors";

/**
 * `DiffStatus` の色語彙 (#1008)。`SchemaCompareView` / `SandboxReviewModal` の
 * 差分行が共有する `statusColors` が、`semanticColors.ts` の `semanticColorVar`
 * 経由で解決していること (`--status-*` の直書きに戻っていないこと) と、
 * 「追加 = success / 削除 = danger / 変更 = warning」の対応を固定する。
 */
describe("statusColors (#1008)", () => {
  it("source_only (追加) は success の意味色を返す", () => {
    expect(statusColors("source_only")).toEqual({
      color: semanticColorVar("success", "text"),
      borderColor: semanticColorVar("success", "text"),
    });
  });

  it("target_only (削除) は danger の意味色を返す", () => {
    expect(statusColors("target_only")).toEqual({
      color: semanticColorVar("danger", "text"),
      borderColor: semanticColorVar("danger", "text"),
    });
  });

  it("different (変更) は warning の意味色を返す", () => {
    expect(statusColors("different")).toEqual({
      color: semanticColorVar("warning", "text"),
      borderColor: semanticColorVar("warning", "text"),
    });
  });

  it("same (差分なし) は中立色を返し、意味色ファミリーは使わない", () => {
    const colors = statusColors("same");
    expect(colors.color).toBe("var(--text-muted)");
    expect(colors.borderColor).toBe("var(--border)");
  });

  it("いずれのステータスも `--status-*` を直接参照しない", () => {
    for (const status of ["source_only", "target_only", "different", "same"] as const) {
      const { color, borderColor } = statusColors(status);
      expect(color).not.toMatch(/--status-/);
      expect(borderColor).not.toMatch(/--status-/);
    }
  });
});
