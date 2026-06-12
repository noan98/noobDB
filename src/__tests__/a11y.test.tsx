import { describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { renderWithProviders } from "./testUtils";

// axe() の解決値の型 (axe-core は直接依存ではないため戻り型から導出する)。
type AxeResults = Awaited<ReturnType<typeof axe>>;
import { setLocale } from "../i18n";
import { DangerousQueryDialog } from "../components/DangerousQueryDialog";
import { ParameterInputModal } from "../components/ParameterInputModal";
import { EmptyState } from "../components/EmptyState";
import { WelcomeIllustration } from "../components/illustrations";
import { ResultGrid } from "../components/ResultGrid";
import { SnippetForm } from "../components/SnippetForm";
import type { Column, QueryResult } from "../api/tauri";
import type { DangerFinding } from "../dangerousSql";

// 主要コンポーネントのアクセシビリティ (a11y) 自動検査。
//
// axe-core (vitest-axe ラッパ) で各コンポーネントを実描画し、コントラスト・
// ラベル欠落・ロール不整合などの a11y 違反を検出し、回帰から守る。
//
// jsdom はレイアウトを計算しないため、色コントラスト (`color-contrast`) など
// 実レンダリング寸法に依存するルールは安定して評価できない。これらは
// 実ブラウザ (ビジュアル回帰) テストの担当領域とし、ここでは構造・ラベル・
// ロールの違反 (フォームコントロールのラベル付け、ボタン名、見出し順序、
// ARIA 属性の妥当性など) に絞って検証する。誤検出を避けるため
// `color-contrast` ルールのみ無効化する。
// axe の結果から違反を判定するマッチャ。vitest-axe 同梱の `toHaveNoViolations`
// は型再エクスポートが Vitest 4 の expect 拡張と噛み合わないため、違反配列を
// 見るだけの薄いマッチャを自前で定義する (判定ロジックは axe-core 本体が担う)。
expect.extend({
  toHaveNoViolations(received: AxeResults) {
    const violations = received.violations ?? [];
    const pass = violations.length === 0;
    return {
      pass,
      message: () =>
        pass
          ? "a11y 違反は検出されませんでした"
          : `a11y 違反 ${violations.length} 件:\n` +
            violations
              .map((v) => `  - [${v.id}] ${v.help} (${v.nodes.length} 要素)`)
              .join("\n"),
    };
  },
});

// jsdom で安定して評価できないレイアウト依存ルールを除外した共通オプション。
const AXE_OPTIONS = {
  rules: {
    "color-contrast": { enabled: false },
  },
} as const;

function makeResult(columns: Column[], rows: QueryResult["rows"]): QueryResult {
  return { columns, rows, rows_affected: 0, elapsed_ms: 3 };
}

describe("アクセシビリティ (axe-core) 自動検査", () => {
  // ロケールを固定し、描画文言を決定的にする。
  setLocale("en");

  it("DangerousQueryDialog に a11y 違反がない", async () => {
    const findings: DangerFinding[] = [{ kind: "deleteNoWhere", target: "users" }];
    const { container } = renderWithProviders(
      <DangerousQueryDialog
        findings={findings}
        isProduction
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("ParameterInputModal に a11y 違反がない", async () => {
    const { container } = renderWithProviders(
      <ParameterInputModal
        sql="SELECT * FROM {{tbl}} WHERE id = {{id}}"
        driver="mysql"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("EmptyState (オンボーディング) に a11y 違反がない", async () => {
    const { container } = renderWithProviders(
      <EmptyState
        illustration={<WelcomeIllustration />}
        title="No connections yet"
        description="Create your first connection to get started."
        action={{ label: "Create connection", onClick: () => {} }}
      />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("ResultGrid (結果グリッド) に a11y 違反がない", async () => {
    const result = makeResult(
      [
        { name: "name", type_name: "VARCHAR" },
        { name: "qty", type_name: "INT" },
      ],
      [
        ["banana", 2],
        ["apple", 5],
      ],
    );
    const { container } = renderWithProviders(<ResultGrid result={result} />);
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it("SnippetForm (フォーム) に a11y 違反がない", async () => {
    const { container } = renderWithProviders(
      <SnippetForm
        initial={null}
        snippets={[]}
        profiles={[]}
        activeProfile={null}
        onSaved={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
