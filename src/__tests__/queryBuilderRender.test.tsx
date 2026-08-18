import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { TableColumnInfo } from "../api/tauri";

/**
 * Query Builder のフォーム改修 (改善 1〜3) の描画テスト。
 * `describeTable` をモックしてカラムメタデータ (型/NOT NULL) を差し込み、
 * 型対応の値入力・実行前バリデーション・WHERE なしバンドが実際に表示に
 * 反映されることを固定する (純粋ロジックの単体テストは
 * `QueryBuilder.test.ts` を参照)。
 */
// `vi.mock` の factory はファイル先頭へ hoist されるため、参照する定数は
// `vi.hoisted` 経由で作る (通常の `const` だと TDZ エラーになる)。
const { COLUMNS } = vi.hoisted(() => {
  const columns: TableColumnInfo[] = [
    {
      name: "id",
      data_type: "int",
      nullable: false,
      key: "PRI",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
    {
      name: "name",
      data_type: "varchar",
      nullable: true,
      key: "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
    {
      name: "active",
      data_type: "boolean",
      nullable: false,
      key: "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
  ];
  return { COLUMNS: columns };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listDatabases: vi.fn().mockResolvedValue(["testdb"]),
      listTables: vi.fn().mockResolvedValue(["users"]),
      describeTable: vi.fn().mockResolvedValue(COLUMNS),
    },
  };
});

import { QueryBuilder } from "../components/QueryBuilder";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDatabases).mockResolvedValue(["testdb"]);
  vi.mocked(api.listTables).mockResolvedValue(["users"]);
  vi.mocked(api.describeTable).mockResolvedValue(COLUMNS);
});

describe("QueryBuilder validation (改善 2)", () => {
  it("disables Run when WHERE is enabled with no filled condition", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled();
    });
  });

  it("enables Run once a WHERE condition column is filled in", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled();
    });
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), {
      target: { value: "id" },
    });
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), {
      target: { value: "1" },
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled();
    });
  });

  it("shows an inline warning when LIMIT is not numeric, without blocking Run", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    const limitInput = screen.getByDisplayValue("100");
    fireEvent.change(limitInput, { target: { value: "abc" } });
    expect(screen.getByText(t("qbLimitInvalid"))).toBeInTheDocument();
  });
});

describe("QueryBuilder no-WHERE band (改善 3)", () => {
  it("shows the warning band for DELETE once WHERE is disabled", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    expect(screen.queryByText(t("qbNoWhereBand"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: t("qbWhereToggle") }));
    expect(screen.getByText(t("qbNoWhereBand"))).toBeInTheDocument();
  });

  it("does not show the band for SELECT, or while WHERE is still enabled", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByText(t("qbNoWhereBand"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    expect(screen.queryByText(t("qbNoWhereBand"))).not.toBeInTheDocument();
  });
});

describe("QueryBuilder type-aware value input (改善 1)", () => {
  it("offers a true/false/NULL select for a boolean WHERE column", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), {
      target: { value: "active" },
    });
    const nullOption = await screen.findByRole("option", { name: t("qbBoolNull") });
    expect(nullOption).toBeInTheDocument();
  });

  it("warns when NULL is picked for a NOT NULL boolean column", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), {
      target: { value: "active" },
    });
    const nullOption = await screen.findByRole("option", { name: t("qbBoolNull") });
    const boolSelect = nullOption.closest("select");
    expect(boolSelect).not.toBeNull();
    fireEvent.change(boolSelect as HTMLSelectElement, { target: { value: "NULL" } });
    expect(screen.getByText(t("qbNotNullWarning"))).toBeInTheDocument();
  });
});
