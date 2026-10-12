import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { RowInspector, type RowInspectorSql } from "../components/RowInspector";
import type { CellValue, Column } from "../api/tauri";
import { setLocale, t } from "../i18n";

const copyToClipboard = vi.fn(async (_s: string) => true);
vi.mock("../components/clipboard", async (orig) => ({
  ...(await orig<typeof import("../components/clipboard")>()),
  copyToClipboard: (s: string) => copyToClipboard(s),
}));

// 行インスペクタの「SQL としてコピー」(#1541)。文は元の CellValue から生成し、
// NULL・64bit 整数・方言別クオートが右クリックの SQL コピーと同じになることを固定する。
const COLS: Column[] = [
  { name: "id", type_name: "BIGINT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "note", type_name: "TEXT" },
];
const VALUES: CellValue[] = ["9223372036854775807", "O'Neil", null];

function renderInspector(sql: Partial<RowInspectorSql> = {}) {
  return renderWithProviders(
    <RowInspector
      columns={COLS}
      values={VALUES}
      columnKinds={["number", "string", "string"]}
      rowNumber={1}
      hasPrev={false}
      hasNext={false}
      onClose={() => {}}
      rowSql={{
        driver: "postgres",
        database: "app",
        table: "users",
        pkIndices: [0],
        blockedByMask: false,
        ...sql,
      }}
    />,
  );
}

const open = () => fireEvent.click(screen.getByRole("button", { name: t("rowInspectorCopySql") }));

describe("RowInspector の SQL コピー (#1541)", () => {
  beforeEach(() => {
    setLocale("en");
    copyToClipboard.mockClear();
  });

  it("INSERT: 64bit 整数を丸めず、NULL と引用符を方言どおりに出す", async () => {
    renderInspector();
    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: t("gridCopyAsInsert") }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(copyToClipboard.mock.calls[0][0]).toBe(
      `INSERT INTO "app"."users" ("id", "name", "note") VALUES (9223372036854775807, 'O''Neil', NULL);`,
    );
  });

  it("UPDATE: 主キーで WHERE を作る", async () => {
    renderInspector({ driver: "mysql" });
    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: t("gridCopyAsUpdate") }));
    await waitFor(() => expect(copyToClipboard).toHaveBeenCalled());
    expect(copyToClipboard.mock.calls[0][0]).toBe(
      "UPDATE `app`.`users` SET `name` = 'O''Neil', `note` = NULL WHERE `id` = 9223372036854775807;",
    );
  });

  it("主キーが無いと UPDATE は無効、マスク中は両方無効", async () => {
    const view = renderInspector({ pkIndices: [] });
    open();
    expect(
      (await screen.findByRole("menuitem", { name: t("gridCopyAsInsert") })).hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByText(t("gridCopyAsUpdate")).closest("button")?.hasAttribute("disabled")).toBe(true);
    view.unmount();
    renderInspector({ blockedByMask: true });
    open();
    expect(screen.getByText(t("gridCopyAsInsert")).closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  it("rowSql が無ければボタンを出さない", () => {
    renderWithProviders(
      <RowInspector
        columns={COLS}
        values={VALUES}
        columnKinds={["number", "string", "string"]}
        rowNumber={1}
        hasPrev={false}
        hasNext={false}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: t("rowInspectorCopySql") })).toBeNull();
  });
});
