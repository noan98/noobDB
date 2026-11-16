import { beforeEach, describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "./testUtils";
import { DropReferencedBy } from "../components/DropReferencedBy";
import { setLocale } from "../i18n";

// DROP の確認: 論理リレーション (仮想 FK, #2356) は DB が止めないので「失敗する」とは言わない。

describe("DropReferencedBy の論理リレーション (#2356)", () => {
  beforeEach(() => setLocale("en"));

  it("論理だけなら DB が止める旨を出さず、論理の注記だけを出す", () => {
    renderWithProviders(
      <DropReferencedBy
        sqlite={false}
        impacts={[
          {
            table: "users",
            refs: [{ table: "notes", column: "user_id", referencedColumn: "id", logical: true }],
          },
        ]}
      />,
    );
    const box = screen.getByTestId("drop-referenced-by");
    expect(box).toHaveTextContent("not enforced by the database");
    expect(box).not.toHaveTextContent(/fail|blocks/i);
  });

  it("宣言 FK と混在すれば、宣言側の注記も出る", () => {
    renderWithProviders(
      <DropReferencedBy
        sqlite={false}
        impacts={[
          {
            table: "users",
            refs: [
              { table: "orders", column: "user_id", referencedColumn: "id" },
              { table: "notes", column: "user_id", referencedColumn: "id", logical: true },
            ],
          },
        ]}
      />,
    );
    expect(screen.getByTestId("drop-referenced-by")).toHaveTextContent("not enforced by the database");
    expect(screen.getAllByText(/orders\.user_id/)).not.toHaveLength(0);
  });
});
