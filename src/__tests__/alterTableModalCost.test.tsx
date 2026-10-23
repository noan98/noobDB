import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext } from "../api/tauri";

/** AlterTableModal の書き換え / 長いロック警告 (#1771)。 */
const stats = vi.hoisted(() => ({ rows: 5_000_000 as number | null }));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
      {
        name: "age",
        data_type: "int",
        nullable: true,
        key: "",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
    table_comment: "",
    foreign_keys: [],
    table_names: ["t"],
    warnings: [],
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn().mockResolvedValue(ctx),
      tableRowEstimate: vi.fn(async () => stats.rows),
      runLookupQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    },
  };
});

import { AlterTableModal } from "../components/AlterTableModal";

function renderModal(driver: "mysql" | "postgres") {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver={driver}
      database="db"
      table="t"
      readOnly={false}
      onRun={() => {}}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
}

async function changeType(value: string) {
  const input = await screen.findByLabelText(`${t("createTableColType")}: age`, {}, { timeout: 4000 });
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  stats.rows = 5_000_000;
});

describe("AlterTableModal 書き換え警告 (#1771)", () => {
  it("MySQL: 大きなテーブルの型変更で警告と ALGORITHM/LOCK の切り替えが出る", async () => {
    renderModal("mysql");
    await changeType("bigint");
    expect(await screen.findByTestId("alter-cost-warning")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("alter-cost-rows")).toHaveTextContent("5,000,000"));
    expect(screen.queryByText(/ALGORITHM=INPLACE, LOCK=NONE;/)).toBeNull();
    fireEvent.click(
      screen.getByLabelText(t("alterCostOnlineToggle", { clause: "ALGORITHM=INPLACE, LOCK=NONE" })),
    );
    await waitFor(() => expect(screen.getByText(/, ALGORITHM=INPLACE, LOCK=NONE;/)).toBeInTheDocument());
  });

  it("PostgreSQL: 型変更で警告が出る (切り替えは出ない)", async () => {
    renderModal("postgres");
    await changeType("bigint");
    expect(await screen.findByTestId("alter-cost-warning")).toBeInTheDocument();
    expect(screen.queryByText(t("alterCostOnlineHint"))).toBeNull();
  });

  it("推定 0 行は不明として警告する", async () => {
    stats.rows = 0;
    renderModal("mysql");
    await changeType("bigint");
    expect(await screen.findByTestId("alter-cost-warning")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("alter-cost-rows")).toHaveTextContent(t("alterCostRowsUnknown")),
    );
  });

  it("小さなテーブルでは警告しない", async () => {
    stats.rows = 100;
    renderModal("mysql");
    await changeType("bigint");
    await waitFor(() => expect(screen.getByText(/CHANGE COLUMN/)).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("alter-cost-warning")).toBeNull());
  });

  it("書き換えを伴わない変更では警告しない", async () => {
    renderModal("mysql");
    const input = await screen.findByLabelText(`${t("createTableColType")}: age`, {}, { timeout: 4000 });
    fireEvent.change(input, { target: { value: "int" } });
    expect(screen.queryByTestId("alter-cost-warning")).toBeNull();
  });
});
