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

describe("QueryBuilder INSERT full column expansion + required marks", () => {
  it("expands all non-auto-generated columns via '全カラムを追加' and marks required ones", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "INSERT" }));
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    const addAllBtn = await screen.findByRole("button", { name: t("qbAddAllColumns") });
    await waitFor(() => expect(addAllBtn).not.toBeDisabled());
    fireEvent.click(addAllBtn);

    expect(screen.getByDisplayValue("id")).toBeInTheDocument();
    expect(screen.getByDisplayValue("name")).toBeInTheDocument();
    expect(screen.getByDisplayValue("active")).toBeInTheDocument();

    // `id` と `active` は NOT NULL かつ default なし (auto_increment でもない) の
    // 必須カラム。`name` は nullable なので必須マークは付かない — 2 件のみ。
    expect(screen.getAllByLabelText(t("qbRequiredColumn"))).toHaveLength(2);
  });

  it("preserves an already-entered value for a column that gets expanded", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "INSERT" }));
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "name" } });
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), { target: { value: "Alice" } });

    const addAllBtn = await screen.findByRole("button", { name: t("qbAddAllColumns") });
    await waitFor(() => expect(addAllBtn).not.toBeDisabled());
    fireEvent.click(addAllBtn);

    expect(screen.getByDisplayValue("Alice")).toBeInTheDocument();
  });
});

describe("QueryBuilder insert into editor", () => {
  it("does not render the button when onInsertToEditor is not provided", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: t("qbInsertToEditor") })).not.toBeInTheDocument();
  });

  it("persists the snapshot and hands the built SQL to onInsertToEditor without executing", async () => {
    const onInsertToEditor = vi.fn();
    const onPersist = vi.fn();
    const onExecute = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(
      <QueryBuilder
        sessionId="s1"
        driver="mysql"
        onExecute={onExecute}
        onPersist={onPersist}
        onInsertToEditor={onInsertToEditor}
        onClose={onClose}
      />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    const btn = screen.getByRole("button", { name: t("qbInsertToEditor") });
    // WHERE が空のプレースホルダのままでも「エディタに挿入」はブロックしない
    // (実行しない用途なので、Run/Dry Run と違い未完成の SQL でも許可する)。
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);

    expect(onInsertToEditor).toHaveBeenCalledTimes(1);
    expect(onInsertToEditor.mock.calls[0][0]).toContain("SELECT");
    expect(onPersist).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables the button when no table is selected", async () => {
    vi.mocked(api.listTables).mockResolvedValueOnce([]);
    const onInsertToEditor = vi.fn();
    renderWithProviders(
      <QueryBuilder
        sessionId="s1"
        driver="mysql"
        onExecute={() => {}}
        onInsertToEditor={onInsertToEditor}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());
    const btn = screen.getByRole("button", { name: t("qbInsertToEditor") });
    expect(btn).toBeDisabled();
  });
});

describe("QueryBuilder ORDER BY (SELECT only)", () => {
  it("starts with no sort rows and adds one via '+ Add sort'", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    expect(screen.getByText(t("qbNoOrderBy"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: `+ ${t("qbAddOrderBy")}` }));
    expect(screen.queryByText(t("qbNoOrderBy"))).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ASC" })).toBeInTheDocument();
  });

  it("is not shown for non-SELECT query kinds", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "UPDATE" }));
    expect(screen.queryByText(t("qbOrderBy"))).not.toBeInTheDocument();
  });
});

describe("QueryBuilder ComboSelect column picker (datalist 脱却)", () => {
  it("shows PK / NOT NULL / FK badges and the column's data type as detail", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    const columnInput = screen.getByPlaceholderText(t("qbColumn"));
    fireEvent.focus(columnInput);

    const idOption = await screen.findByRole("option", { name: /id/ });
    expect(idOption).toHaveTextContent("PK");
    expect(idOption).toHaveTextContent(t("qbBadgeNotNull"));
    expect(idOption).toHaveTextContent("int");
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
