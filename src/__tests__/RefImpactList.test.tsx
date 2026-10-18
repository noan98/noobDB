import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { useConfirm } from "../components/ConfirmDialog";
import { RefImpactList } from "../components/RefImpactList";
import { setLocale } from "../i18n";
import type { RefImpact } from "../refImpact";

const impacts: RefImpact[] = [
  {
    parentTable: "users",
    table: "orders",
    column: "user_id",
    referencedColumn: "id",
    onDelete: "CASCADE",
    count: 3,
  },
  {
    parentTable: "users",
    table: "logs",
    column: "user_id",
    referencedColumn: "id",
    onDelete: "RESTRICT",
    count: 2,
  },
];

describe("RefImpactList (#1506)", () => {
  beforeEach(() => setLocale("en"));

  it("参照が無ければ何も描かない", () => {
    const { container } = renderWithProviders(<RefImpactList impacts={[]} mode="rows" sqlite={false} />);
    expect(container.querySelector('[data-testid="ref-impact-list"]')).toBeNull();
  });

  it("子テーブルごとの行数と ON DELETE を出し、合計をタイトルに出す", () => {
    renderWithProviders(<RefImpactList impacts={impacts} mode="rows" sqlite={false} />);
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("5 child rows in 2 table(s)");
    const rows = screen.getAllByTestId("ref-impact-row");
    expect(rows[0]).toHaveTextContent("orders.user_id ← users.id");
    expect(rows[0]).toHaveTextContent("3 rows");
    expect(rows[0]).toHaveTextContent("ON DELETE CASCADE");
    expect(rows[1]).toHaveTextContent("ON DELETE RESTRICT");
  });

  it("SQLite では PRAGMA foreign_keys の注意書きを足す / partial は下限表示", () => {
    renderWithProviders(<RefImpactList impacts={impacts} mode="rows" sqlite partial />);
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("PRAGMA foreign_keys");
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("At least 5");
  });

  it("「子行を開く」は確認ダイアログを閉じ (キャンセル)、開く対象を渡す", async () => {
    const onOpen = vi.fn();
    const onResult = vi.fn();
    const user = userEvent.setup();
    function Harness() {
      const { confirm, dialog } = useConfirm();
      return (
        <>
          <button
            type="button"
            onClick={() =>
              confirm({
                title: "Delete?",
                message: (controls) => (
                  <RefImpactList
                    impacts={impacts}
                    mode="rows"
                    sqlite={false}
                    onOpen={(imp) => {
                      controls.cancel();
                      onOpen(imp);
                    }}
                  />
                ),
                confirmLabel: "Delete anyway",
                tone: "warning",
              }).then(onResult)
            }
          >
            open
          </button>
          {dialog}
        </>
      );
    }
    renderWithProviders(<Harness />);
    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getAllByRole("button", { name: "Open child rows" })[0]);
    expect(onOpen).toHaveBeenCalledWith(impacts[0]);
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
