import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { Callout, CALLOUT_ICONS } from "../components/Callout";
import { ErrorNote } from "../components/modalForm";
import { SEMANTIC_ROLES } from "../semanticColors";

/**
 * 状態バナーの共有プリミティブ (#1145)。
 *
 * 役割 → アイコンの対応と、`ErrorNote` がこの上に載っていることを固定する。
 * 画面ごとの手組みに戻ると、同じ「危険」でも枠の色やアイコンの有無がまた分裂する。
 */
describe("Callout (#1145)", () => {
  it("すべての意味役割に既定のアイコンがあり、互いに重ならない", () => {
    const icons = SEMANTIC_ROLES.map((role) => CALLOUT_ICONS[role]);
    expect(icons.every(Boolean)).toBe(true);
    expect(new Set(icons).size).toBe(SEMANTIC_ROLES.length);
  });

  it("title・本文・アクションを描き、role は呼び出し側の指定をそのまま使う", () => {
    renderWithProviders(
      <Callout tone="warning" role="status" title="見出し" action={<button type="button">再試行</button>}>
        本文
      </Callout>,
    );
    const el = screen.getByRole("status");
    expect(el).toHaveAttribute("data-tone", "warning");
    expect(el).toHaveTextContent("見出し");
    expect(el).toHaveTextContent("本文");
    expect(screen.getByRole("button", { name: "再試行" })).toBeInTheDocument();
    // 先頭アイコンは装飾なので読み上げない。
    expect(el.querySelector("[aria-hidden] svg")).not.toBeNull();
  });

  it("icon={null} で先頭アイコンを出さない", () => {
    renderWithProviders(
      <Callout tone="info" icon={null} role="note">
        案内
      </Callout>,
    );
    expect(screen.getByRole("note").querySelector("svg")).toBeNull();
  });

  it("ErrorNote は危険の Callout (協調枠線 + アイコン) として描かれる", () => {
    renderWithProviders(<ErrorNote role="alert">失敗しました</ErrorNote>);
    const el = screen.getByRole("alert");
    expect(el).toHaveAttribute("data-tone", "danger");
    expect(el).toHaveTextContent("失敗しました");
    expect(el.querySelector("svg")).not.toBeNull();
  });
});
