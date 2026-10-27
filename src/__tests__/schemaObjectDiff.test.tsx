import { describe, it, expect } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { SchemaObjectDiff, countObjectDifferences } from "../components/SchemaObjectDiff";
import { t } from "../i18n";
import type { ObjectComparison, ObjectDiff } from "../api/tauri";

function item(over: Partial<ObjectDiff> & Pick<ObjectDiff, "kind" | "name" | "status">): ObjectDiff {
  return { signature: null, table: null, source_definition: null, target_definition: null, ...over };
}

const comparison = (items: ObjectDiff[], unsupported: string[] = []): ObjectComparison => ({
  compared: true,
  items,
  unsupported_kinds: unsupported,
});

describe("SchemaObjectDiff (#1879)", () => {
  it("差分のあるオブジェクトを状態バッジ付きで並べ、Different は定義を両側表示する", () => {
    renderWithProviders(
      <SchemaObjectDiff
        driver="mysql"
        hideSame={true}
        objects={comparison([
          item({
            kind: "view",
            name: "v_orders",
            status: "different",
            source_definition: "CREATE VIEW v_orders AS select 1",
            target_definition: "CREATE VIEW v_orders AS select 2",
          }),
          item({ kind: "trigger", name: "trg_a", status: "source_only", table: "orders" }),
          item({ kind: "view", name: "v_same", status: "same" }),
        ])}
      />,
    );
    expect(screen.getByText("v_orders")).toBeInTheDocument();
    expect(screen.getByText("trg_a")).toBeInTheDocument();
    expect(screen.queryByText("v_same")).not.toBeInTheDocument();
    expect(screen.getByText("CREATE VIEW v_orders AS select 1")).toBeInTheDocument();
    expect(screen.getByText("CREATE VIEW v_orders AS select 2")).toBeInTheDocument();
  });

  it("開閉できる行は aria-expanded で畳める", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <SchemaObjectDiff
        driver="postgres"
        hideSame={false}
        objects={comparison([
          item({
            kind: "sequence",
            name: "seq",
            status: "source_only",
            source_definition: "CREATE SEQUENCE seq",
          }),
        ])}
      />,
    );
    const row = screen.getByRole("button", { expanded: false });
    await user.click(row);
    expect(screen.getByText("CREATE SEQUENCE seq")).toBeInTheDocument();
  });

  it("SQLite では存在しない種別を理由付きで「対象外」と表示する", () => {
    renderWithProviders(
      <SchemaObjectDiff
        driver="sqlite"
        hideSame={true}
        objects={comparison([], ["sequence", "function", "procedure", "materialized_view"])}
      />,
    );
    expect(screen.getByText(t("schemaCompareObjectUnsupportedTitle"))).toBeInTheDocument();
    expect(
      screen.getAllByText(t("schemaCompareObjectUnsupportedRoutine", { driver: "SQLite" }), { exact: false }),
    ).toHaveLength(2);
    expect(
      screen.getByText(t("schemaCompareObjectUnsupportedSequence", { driver: "SQLite" }), { exact: false }),
    ).toBeInTheDocument();
  });

  it("取得に失敗したときは差分なしに見せず警告する", () => {
    renderWithProviders(
      <SchemaObjectDiff
        driver="mysql"
        hideSame={true}
        objects={{ compared: false, items: [], unsupported_kinds: [] }}
      />,
    );
    expect(screen.getByText(t("schemaCompareObjectsNotCompared"))).toBeInTheDocument();
    expect(screen.queryByText(t("schemaCompareObjectsIdentical"))).not.toBeInTheDocument();
  });

  it("差分が無ければ一致のメッセージを出し、差分件数は Same を除いて数える", () => {
    const objects = comparison([item({ kind: "view", name: "v", status: "same" })]);
    renderWithProviders(<SchemaObjectDiff driver="mysql" hideSame={true} objects={objects} />);
    expect(screen.getByText(t("schemaCompareObjectsIdentical"))).toBeInTheDocument();
    expect(countObjectDifferences(objects)).toBe(0);
    expect(countObjectDifferences(undefined)).toBe(0);
    expect(
      countObjectDifferences(
        comparison([
          item({ kind: "view", name: "a", status: "different" }),
          item({ kind: "view", name: "b", status: "same" }),
        ]),
      ),
    ).toBe(1);
  });
});
