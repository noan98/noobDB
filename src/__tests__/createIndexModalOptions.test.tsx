import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";

/** CreateIndexModal の詳細オプション (#1892)。方言ごとの有効/無効とプレビュー SQL を確認する。 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const col = (name: string) => ({
    name,
    data_type: "int",
    nullable: true,
    key: "",
    default: null,
    extra: "",
    referenced_table: null,
    referenced_column: null,
  });
  return {
    ...actual,
    api: {
      ...actual.api,
      describeTable: vi.fn().mockResolvedValue([col("a"), col("b")]),
      checkDuplicateIndex: vi.fn().mockResolvedValue([]),
    },
  };
});

import { CreateIndexModal } from "../components/CreateIndexModal";
import type { DriverKind } from "../api/tauri";

function open(driver: DriverKind) {
  renderWithProviders(
    <CreateIndexModal
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

describe("CreateIndexModal 詳細オプション (#1892)", () => {
  it("PostgreSQL: メソッド / WHERE / INCLUDE がプレビューに反映される", async () => {
    open("postgres");
    fireEvent.click(await screen.findByLabelText("a"));
    fireEvent.change(screen.getByLabelText(/WHERE/), { target: { value: "a > 0" } });
    fireEvent.click(screen.getByLabelText(/Include b|b を INCLUDE/));
    await waitFor(() => expect(document.body.textContent).toContain('INCLUDE ("b") WHERE a > 0;'));
    fireEvent.change(screen.getByLabelText(/メソッド|Method/), { target: { value: "gin" } });
    await waitFor(() => expect(document.body.textContent).toContain('USING gin ("a") WHERE a > 0;'));
    expect(document.body.textContent).not.toContain(`INCLUDE ("b")`);
  });

  it("SQLite: メソッド / INCLUDE は無効で理由が出る。MySQL: WHERE が無効", async () => {
    open("sqlite");
    await screen.findByLabelText("a");
    expect(screen.getByTestId("create-index-reason-method")).toBeInTheDocument();
    expect(screen.getByTestId("create-index-reason-include")).toBeInTheDocument();
  });

  it("MySQL: WHERE 欄は無効", async () => {
    open("mysql");
    await screen.findByLabelText("a");
    expect(screen.getByLabelText(/WHERE/)).toBeDisabled();
    expect(screen.getByTestId("create-index-reason-where")).toBeInTheDocument();
  });
});
