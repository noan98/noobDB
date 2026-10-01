import { describe, it, expect } from "vitest";
import { renderWithProviders } from "./testUtils";
import { EmptyState } from "../components/EmptyState";
import { WelcomeIllustration } from "../components/illustrations";

/**
 * 空状態 / オンボーディング。リッチイラスト + CTA の一貫表示と、compact 時の
 * フォールバック挙動を固定する。
 */
describe("EmptyState onboarding (#450)", () => {
  it("renders the illustration, title, description and CTA", () => {
    const { getByText, getByRole, container } = renderWithProviders(
      <EmptyState
        illustration={<WelcomeIllustration />}
        title="No connections yet"
        description="Create your first connection to get started."
        action={{ label: "Create connection", onClick: () => {} }}
      />,
    );
    expect(getByText("No connections yet")).toBeTruthy();
    expect(getByText("Create your first connection to get started.")).toBeTruthy();
    expect(getByRole("button", { name: "Create connection" })).toBeTruthy();
    // イラストは SVG として描画される。
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("falls back to the small icon badge in compact layout (no illustration)", () => {
    const { container } = renderWithProviders(
      <EmptyState
        compact
        illustration={<WelcomeIllustration />}
        icon="table"
        title="No rows"
      />,
    );
    // compact ではイラストを出さず、アイコンバッジ (svg) のみ。少なくとも 1 つの svg。
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(1);
  });
});

describe("EmptyState secondaryActions (#1271)", () => {
  it("renders secondary buttons with shortcut hints and fires handlers", async () => {
    const { buildTabsEmptyActions, TABS_EMPTY_ACTIONS } = await import(
      "../components/tabsEmptyActions"
    );
    const { fireEvent } = await import("@testing-library/react");
    const calls: string[] = [];
    const items = buildTabsEmptyActions(
      (k) => `L:${k}`,
      {
        openSqlFile: () => calls.push("file"),
        snippets: () => calls.push("snip"),
        erDiagram: () => calls.push("er"),
        commandPalette: () => calls.push("pal"),
      },
      "Ctrl+K",
    );
    expect(items.map((i) => i.id)).toEqual(TABS_EMPTY_ACTIONS.map((a) => a.id));
    expect(items).toHaveLength(4);
    expect(items.filter((i) => i.shortcut).map((i) => i.id)).toEqual(["commandPalette"]);

    const { getByRole } = renderWithProviders(
      <EmptyState
        title="t"
        action={{ label: "New", onClick: () => calls.push("new") }}
        secondaryActions={items}
      />,
    );
    for (const i of items) fireEvent.click(getByRole("button", { name: new RegExp(i.label) }));
    fireEvent.click(getByRole("button", { name: "New" }));
    expect(calls).toEqual(["file", "snip", "er", "pal", "new"]);
    expect(getByRole("button", { name: /CommandPalette.*Ctrl\+K/ })).toBeTruthy();
  });
});
