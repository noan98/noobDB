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
    const { container } = renderWithProviders(<RefImpactList impacts={[]} mode="rows" driver="mysql" />);
    expect(container.querySelector('[data-testid="ref-impact-list"]')).toBeNull();
  });

  it("子テーブルごとの行数と ON DELETE を出し、合計をタイトルに出す", () => {
    renderWithProviders(<RefImpactList impacts={impacts} mode="rows" driver="mysql" />);
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("5 child rows in 2 table(s)");
    const rows = screen.getAllByTestId("ref-impact-row");
    expect(rows[0]).toHaveTextContent("orders.user_id ← users.id");
    expect(rows[0]).toHaveTextContent("3 rows will be cascade-deleted");
    expect(rows[0]).toHaveTextContent("ON DELETE CASCADE");
    expect(rows[1]).toHaveTextContent("ON DELETE RESTRICT");
  });

  it("SQLite では PRAGMA foreign_keys の注意書きを足す / partial は下限表示", () => {
    renderWithProviders(<RefImpactList impacts={impacts} mode="rows" driver="sqlite" partial />);
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
                    driver="mysql"
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

  it("TRUNCATE (MySQL / PostgreSQL) は ON DELETE に関係なく失敗すると伝える", () => {
    const onlyCascade = [impacts[0]];
    const { unmount } = renderWithProviders(
      <RefImpactList impacts={onlyCascade} mode="truncate" driver="mysql" />,
    );
    const box = screen.getByTestId("ref-impact-list");
    expect(box).toHaveTextContent("MySQL refuses to TRUNCATE");
    expect(box).toHaveTextContent("this TRUNCATE will fail");
    expect(box).not.toHaveTextContent("deleted together");
    expect(box).not.toHaveTextContent("SQLite");
    unmount();
    renderWithProviders(<RefImpactList impacts={onlyCascade} mode="truncate" driver="postgres" />);
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("PostgreSQL refuses to TRUNCATE");
  });

  it("TRUNCATE (SQLite) は DELETE FROM なので CASCADE の連鎖削除と PRAGMA の注記を出す", () => {
    renderWithProviders(<RefImpactList impacts={impacts} mode="truncate" driver="sqlite" />);
    const box = screen.getByTestId("ref-impact-list");
    expect(box).toHaveTextContent("deleted together");
    expect(box).toHaveTextContent("PRAGMA foreign_keys");
    expect(box).not.toHaveTextContent("MySQL");
    expect(box).not.toHaveTextContent("PostgreSQL");
  });

  it("上限に達した子テーブルは「N+ 行」と表示し、タイトルも下限表記にする", () => {
    renderWithProviders(
      <RefImpactList
        impacts={[{ ...impacts[0], count: 1000, capped: true }]}
        mode="truncate"
        driver="sqlite"
      />,
    );
    expect(screen.getByTestId("ref-impact-list")).toHaveTextContent("At least 1000 child rows");
    expect(screen.getByTestId("ref-impact-row")).toHaveTextContent("1000+ rows");
  });

  it("数えられなかったときは確認できなかった旨と子テーブル名を出す", () => {
    renderWithProviders(
      <RefImpactList impacts={[]} mode="rows" driver="mysql" unverified={["orders", "logs"]} />,
    );
    expect(screen.getByTestId("ref-impact-unverified")).toHaveTextContent("Could not check");
    expect(screen.getByTestId("ref-impact-unverified")).toHaveTextContent("orders, logs");
  });
});
