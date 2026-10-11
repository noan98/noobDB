import { useState } from "react";
import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { TableConstraintEditor } from "../components/TableConstraintEditor";
import { emptyForeignKey } from "../components/tableConstraints";
import { t } from "../i18n";

// 参照列の入力は trim せず往復させ、`Order Id` のような空白入りの列名を入力できる (#1527)。
function Harness() {
  const [fks, setFks] = useState([{ ...emptyForeignKey(), id: "fk1" }]);
  return (
    <TableConstraintEditor
      foreignKeys={fks}
      checks={[]}
      onForeignKeysChange={setFks}
      onChecksChange={() => {}}
      columnNames={["a"]}
      tableNames={[]}
      nextId={() => "x"}
      idPrefix="t"
    />
  );
}

describe("TableConstraintEditor 参照列入力", () => {
  it("入力途中の空白を保つ", () => {
    renderWithProviders(<Harness />);
    const input = screen.getByLabelText(t("constraintFkRefColumns")) as HTMLInputElement;
    for (const v of ["O", "Or", "Order", "Order ", "Order I", "Order Id", "Order Id, x"]) {
      fireEvent.change(input, { target: { value: v } });
      expect(input.value).toBe(v);
    }
  });
});
