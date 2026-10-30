import { describe, it, expect, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "./testUtils";
import { TableDiffDetail, TableDiffList } from "../components/SchemaDiffDetail";
import { groupTables } from "../components/schemaCompareModel";
import { t } from "../i18n";
import type { ColumnDiff, DiffStatus, SyncStatement, TableColumnInfo, TableDiff } from "../api/tauri";

/**
 * スキーマ比較の 2 ペイン (左: テーブル一覧 / 右: 選んだテーブルの差分)。
 * 「更新先を基準に合わせる」向きで読めること — 状態は追加/変更/削除の動詞、
 * 変更の矢印は「更新先の現在 → 適用後」— を固定する。
 */

function makeColumnInfo(name: string, dataType = "int"): TableColumnInfo {
  return {
    name,
    data_type: dataType,
    nullable: false,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  };
}

function makeColumnDiff(name: string, status: DiffStatus): ColumnDiff {
  const info = makeColumnInfo(name);
  return {
    name,
    status,
    source: status === "target_only" ? null : info,
    target: status === "source_only" ? null : info,
    changed_fields: status === "different" ? ["data_type"] : [],
  };
}

function detail(table: TableDiff, statements: SyncStatement[] = [], planReady = false) {
  return renderWithProviders(
    <TableDiffDetail
      table={table}
      sourceName="dl / app"
      targetName="sl / app"
      statements={statements}
      planReady={planReady}
      t={t}
    />,
  );
}

describe("TableDiffList (左ペイン)", () => {
  it("操作ごとのグループ見出しを付け、押したテーブルを選択として通知する", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const tables: TableDiff[] = [
      { name: "users", status: "source_only", columns: [makeColumnDiff("id", "source_only")] },
      { name: "orders", status: "different", columns: [makeColumnDiff("total", "different")] },
    ];
    renderWithProviders(
      <TableDiffList groups={groupTables(tables)} selected="orders" onSelect={onSelect} t={t} />,
    );
    expect(screen.getByText(t("schemaCompareGroupChange", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareGroupAdd", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /orders/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /users/ })).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("button", { name: /users/ }));
    expect(onSelect).toHaveBeenCalledWith("users");
  });

  it("カラムと制約の件数を 1 つの表記にまとめる", () => {
    const table: TableDiff = {
      name: "call_statuses",
      status: "different",
      columns: [makeColumnDiff("flag", "different")],
      indexes: [
        {
          name: "idx",
          status: "target_only",
          source: null,
          target: { name: "idx", columns: ["flag"], unique: false, method: null },
        },
      ],
    };
    renderWithProviders(
      <TableDiffList groups={groupTables([table])} selected={null} onSelect={() => {}} t={t} />,
    );
    expect(
      screen.getByText(
        `${t("schemaCompareColumnCount", { count: 1 })} ・ ${t("schemaCompareConstraintCount", { count: 1 })}`,
      ),
    ).toBeInTheDocument();
  });
});

describe("TableDiffDetail (右ペイン)", () => {
  it("変更は「更新先の現在 → 適用後」の向きで表示する (基準が longtext、更新先が text)", () => {
    const table: TableDiff = {
      name: "api_logs",
      status: "different",
      columns: [
        {
          name: "body",
          status: "different",
          source: makeColumnInfo("body", "longtext"),
          target: makeColumnInfo("body", "text"),
          changed_fields: ["data_type"],
        },
      ],
    };
    detail(table);
    const change = screen.getByTestId("schema-compare-change");
    expect(change).toHaveTextContent(`${t("schemaCompareFieldDataType")}: text → longtext`);
    expect(change.querySelector("s")).toHaveTextContent("text");
    expect(screen.getByText(t("schemaCompareOpChange"))).toBeInTheDocument();
  });

  it("基準にしか無い項目は「追加」、更新先にしか無い項目は「削除」と表示する", () => {
    const table: TableDiff = {
      name: "orders",
      status: "different",
      columns: [makeColumnDiff("note", "source_only"), makeColumnDiff("legacy", "target_only")],
    };
    detail(table);
    expect(screen.getByText(t("schemaCompareOpAdd"))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareOpDrop"))).toBeInTheDocument();
    expect(
      screen.getByText(t("schemaCompareDetailCounts", { add: 1, change: 0, drop: 1 })),
    ).toBeInTheDocument();
  });

  it("インデックスと外部キーの差分を小見出しで分け、矢印は更新先 → 基準の値", () => {
    const ix = (columns: string[], unique: boolean) => ({ name: "idx_email", columns, unique, method: null });
    const fk = (onDelete: string | null) => ({
      name: "fk_user",
      columns: ["user_id"],
      referenced_table: "users",
      referenced_columns: ["id"],
      on_delete: onDelete,
      on_update: null,
    });
    const table: TableDiff = {
      name: "orders",
      status: "different",
      columns: [],
      indexes: [
        {
          name: "idx_email",
          status: "different",
          source: ix(["email"], true),
          target: ix(["email", "name"], false),
          changed_fields: ["columns", "unique"],
        },
      ],
      fk_changes: [
        { status: "different", source: fk("CASCADE"), target: fk(null), changed_fields: ["on_delete"] },
      ],
    };
    detail(table);
    expect(screen.getByText(t("schemaCompareSectionIndexes"))).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareSectionForeignKeys"))).toBeInTheDocument();
    const texts = screen.getAllByTestId("schema-compare-change").map((el) => el.textContent);
    expect(texts).toContain(`${t("schemaCompareIdxFieldColumns")}: (email, name) → (email)`);
    expect(texts).toContain(`${t("schemaCompareFkFieldOnDelete")}: NO ACTION → CASCADE`);
  });

  it("SQL 生成前は案内を出し、生成後はこのテーブルの SQL を表示する", () => {
    const table: TableDiff = {
      name: "orders",
      status: "different",
      columns: [makeColumnDiff("total", "different")],
    };
    const { unmount } = detail(table);
    expect(screen.getByText(t("schemaCompareTableSqlHint"))).toBeInTheDocument();
    unmount();

    detail(
      table,
      [
        {
          sql: "ALTER TABLE orders MODIFY total bigint",
          table: "orders",
          kind: "alter_column",
          destructive: false,
        },
        { sql: "ALTER TABLE orders DROP COLUMN x", table: "orders", kind: "drop_column", destructive: true },
      ],
      true,
    );
    expect(screen.getByText(/ALTER TABLE orders MODIFY total bigint/)).toBeInTheDocument();
    expect(screen.getByText(t("schemaCompareTableSqlDestructive", { count: 1 }))).toBeInTheDocument();
  });

  it("同一のテーブルは差分なしと表示し、SQL 欄を出さない", () => {
    detail({ name: "same_table", status: "same", columns: [] });
    expect(screen.getByText(t("schemaCompareDetailSame"))).toBeInTheDocument();
    expect(screen.queryByText(t("schemaCompareTableSqlHint"))).not.toBeInTheDocument();
  });
});
