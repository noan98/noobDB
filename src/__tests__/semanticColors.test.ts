import { describe, it, expect } from "vitest";
// App.css を実ファイルから読み取り、このモジュールが指す CSS 変数名が実在する
// ことを検証する (themeContrast.test.ts と同じ `?raw` 経路)。CSS 側を source of
// truth とし、TS 側の名前解決だけがここでテストされることを保証する (#664)。
import css from "../App.css?raw";
import {
  SEMANTIC_ROLES,
  SEMANTIC_TIERS,
  semanticColorToken,
  semanticColorVar,
  type SemanticRole,
  type SemanticTier,
} from "../semanticColors";

describe("semanticColors token resolution (#664)", () => {
  it("covers exactly the 4 canonical roles and 4 tiers", () => {
    expect(SEMANTIC_ROLES).toEqual(
      expect.arrayContaining(["success", "warning", "danger", "info"]),
    );
    expect(SEMANTIC_ROLES).toHaveLength(4);
    expect(SEMANTIC_TIERS).toEqual(
      expect.arrayContaining(["subtle", "border", "solid", "text"]),
    );
    expect(SEMANTIC_TIERS).toHaveLength(4);
  });

  it("semanticColorVar resolves danger to the existing --error-* family (back-compat)", () => {
    expect(semanticColorVar("danger", "text")).toBe("var(--error-text)");
    expect(semanticColorVar("danger", "subtle")).toBe("var(--error-subtle)");
    expect(semanticColorVar("danger", "border")).toBe("var(--error-border)");
    expect(semanticColorVar("danger", "solid")).toBe("var(--error-solid)");
  });

  it("semanticColorVar resolves success/warning/info to their own family name", () => {
    expect(semanticColorVar("success", "text")).toBe("var(--success-text)");
    expect(semanticColorVar("warning", "text")).toBe("var(--warning-text)");
    expect(semanticColorVar("info", "text")).toBe("var(--info-text)");
  });

  it("semanticColorToken resolves danger to the app.error.* Chakra namespace (back-compat)", () => {
    expect(semanticColorToken("danger", "subtle")).toBe("app.error.subtle");
    expect(semanticColorToken("success", "solid")).toBe("app.success.solid");
    expect(semanticColorToken("warning", "border")).toBe("app.warning.border");
    expect(semanticColorToken("info", "text")).toBe("app.info.text");
  });

  it("every role x tier combination resolves to a distinct var() reference", () => {
    const seen = new Set<string>();
    for (const role of SEMANTIC_ROLES) {
      for (const tier of SEMANTIC_TIERS) {
        const v = semanticColorVar(role, tier);
        expect(v).toMatch(/^var\(--[\w-]+\)$/);
        seen.add(v);
      }
    }
    // danger は error にマップされるため success/warning/info と合わせて
    // ちょうど 16 種 (4 family x 4 tier) の一意な変数参照になる。
    expect(seen.size).toBe(16);
  });

  it("every resolved CSS variable is actually defined in :root (App.css)", () => {
    // ":root { ... }" のライトデフォルトブロックを取り出し、resolve した
    // 変数名がそこに存在することを確認する。CSS 側の変数名が将来リネームされて
    // このモジュールとズレたら、ここで即座に検知できる。
    const m = css.match(/:root\s*\{([\s\S]*?)\n\}/);
    expect(m).toBeTruthy();
    const rootBody = m![1];
    for (const role of SEMANTIC_ROLES) {
      for (const tier of SEMANTIC_TIERS) {
        const varName = semanticColorVar(role, tier).replace(/^var\((--[\w-]+)\)$/, "$1");
        expect(rootBody, `${varName} must be defined in :root`).toMatch(
          new RegExp(`${varName}:\\s*#[0-9a-fA-F]{6};`),
        );
      }
    }
  });

  it("every resolved Chakra token path matches the app.{family}.{tier} shape used by theme.ts", () => {
    const role: SemanticRole = "warning";
    const tier: SemanticTier = "border";
    expect(semanticColorToken(role, tier)).toMatch(/^app\.(success|warning|error|info)\.(subtle|border|solid|text)$/);
  });
});
