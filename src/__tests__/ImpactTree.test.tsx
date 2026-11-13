import { beforeEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, within } from "./testUtils";
import { ImpactTree, type ImpactGroup, type ImpactNode } from "../components/ImpactTree";
import { setLocale } from "../i18n";

function nodes(n: number, extra: Partial<ImpactNode> = {}): ImpactNode[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `n${i}`,
    kind: "table" as const,
    name: `child_${i}.col`,
    ...extra,
  }));
}

describe("ImpactTree (#2295)", () => {
  beforeEach(() => setLocale("en"));

  it("起点チップ・種別ラベル・名前・結果バッジを出す (グリフだけでなく文言を併記)", () => {
    const groups: ImpactGroup[] = [
      {
        key: "g",
        origin: { kind: "table", name: "users" },
        nodes: [
          { key: "a", kind: "view", kindLabel: "view", name: "public.v1", outcome: "rebuild" },
          { key: "b", kind: "table", name: "orders.user_id", outcome: "cascade", meta: "3 rows" },
          { key: "c", kind: "table", name: "logs.user_id", outcome: "block" },
          { key: "d", kind: "table", name: "notes.user_id", outcome: "setNull" },
        ],
      },
    ];
    renderWithProviders(<ImpactTree groups={groups} />);
    expect(screen.getByTestId("impact-origin")).toHaveTextContent("users");
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("viewpublic.v1Rebuild");
    expect(items[1]).toHaveTextContent("Cascade delete");
    expect(items[1]).toHaveTextContent("3 rows");
    expect(items[2]).toHaveTextContent("Blocks");
    expect(items[3]).toHaveTextContent("Set NULL");
  });

  it("起点が無ければチップを出さない", () => {
    renderWithProviders(<ImpactTree groups={[{ key: "g", nodes: nodes(1) }]} />);
    expect(screen.queryByTestId("impact-origin")).toBeNull();
  });

  it("多段の依存は入れ子の木として字下げして出す", () => {
    const tree: ImpactNode[] = [
      {
        key: "p",
        kind: "view",
        name: "v_parent",
        outcome: "rebuild",
        children: [{ key: "c", kind: "matview", name: "mv_child", outcome: "rebuild" }],
      },
    ];
    renderWithProviders(<ImpactTree groups={[{ key: "g", nodes: tree }]} />);
    const parent = screen.getByText("v_parent").closest("li");
    expect(parent).not.toBeNull();
    expect(within(parent as HTMLElement).getByText("mv_child")).toBeInTheDocument();
  });

  it("maxVisible を超えた分は「ほか N 件」に畳み、押すと全件を展開 / 折りたたみできる", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ImpactTree groups={[{ key: "g", nodes: nodes(5, { testId: "row" }) }]} maxVisible={2} />,
    );
    expect(screen.getAllByTestId("row")).toHaveLength(2);
    const toggle = screen.getByRole("button", { name: "and 3 more" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(await screen.findAllByTestId("row")).toHaveLength(5);
    expect(screen.getByText("child_4.col")).toBeInTheDocument();
    const less = screen.getByRole("button", { name: "Show fewer" });
    expect(less).toHaveAttribute("aria-expanded", "true");
  });

  it("上限は起点をまたいだ通し数で数える", () => {
    const groups: ImpactGroup[] = [
      { key: "a", origin: { kind: "table", name: "a" }, nodes: nodes(2, { testId: "row" }) },
      {
        key: "b",
        origin: { kind: "table", name: "b" },
        nodes: nodes(2, { testId: "row" }).map((n) => ({ ...n, key: `b${n.key}` })),
      },
    ];
    renderWithProviders(<ImpactTree groups={groups} maxVisible={3} />);
    expect(screen.getAllByTestId("row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "and 1 more" })).toBeInTheDocument();
  });

  it("上限以内なら展開ボタンを出さない", () => {
    renderWithProviders(<ImpactTree groups={[{ key: "g", nodes: nodes(3) }]} maxVisible={3} />);
    expect(screen.queryByTestId("impact-tree-toggle")).toBeNull();
  });
});
