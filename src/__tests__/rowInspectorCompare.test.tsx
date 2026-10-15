import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { RowInspector } from "../components/RowInspector";
import { differingColumns } from "../components/rowInspectorEdit";
import { setLocale, t } from "../i18n";

describe("differingColumns (#1628)", () => {
  it("値が異なる列だけ true、NULL 同士と同じ文字列表現は等しい", () => {
    expect(differingColumns([1, "a", null, "x"], [1, "b", null, "y"], 4)).toEqual([false, true, false, true]);
    expect(differingColumns([1, null], ["1", "z"], 2)).toEqual([false, true]);
  });
  it("行が短い列は NULL として比べる", () => {
    expect(differingColumns([1], [1, null], 2)).toEqual([false, false]);
    expect(differingColumns([1], [1, "v"], 2)).toEqual([false, true]);
  });
});

describe("RowInspector の 2 行比較 (#1628)", () => {
  beforeEach(() => setLocale("en"));
  const columns = [
    { name: "id", type_name: "INT" },
    { name: "name", type_name: "TEXT" },
  ];
  const render = (rowNumber: number, values: (string | number | null)[]) =>
    renderWithProviders(
      <RowInspector
        columns={columns}
        values={values}
        columnKinds={["number", "string"]}
        rowNumber={rowNumber}
        hasPrev={false}
        hasNext={false}
        onClose={() => {}}
      />,
    );

  it("固定していなければ比較表示は出ない", () => {
    render(1, [1, "alice"]);
    expect(screen.queryByTestId("inspector-pinned-value")).toBeNull();
  });

  it("固定後に別の行へ移ると、異なる列に固定行の値が並ぶ", async () => {
    const { rerender } = render(1, [1, "alice"]);
    fireEvent.click(screen.getByRole("button", { name: t("rowInspectorPin") }));
    rerender(
      <RowInspector
        columns={columns}
        values={[2, "alice"]}
        columnKinds={["number", "string"]}
        rowNumber={2}
        hasPrev={false}
        hasNext={false}
        onClose={() => {}}
      />,
    );
    const pinned = await screen.findAllByTestId("inspector-pinned-value");
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toHaveTextContent("1");
    expect(screen.getByRole("status")).toHaveTextContent("1");
  });
});
