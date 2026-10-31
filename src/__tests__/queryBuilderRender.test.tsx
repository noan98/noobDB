import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
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
      runLookupQuery: vi.fn(),
    },
  };
});

import { QueryBuilder } from "../components/QueryBuilder";

/** WHERE は既定でオフなので、「条件を追加」を押して最初の条件行を出す。 */
const enableWhere = () =>
  fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDatabases).mockResolvedValue(["testdb"]);
  vi.mocked(api.listTables).mockResolvedValue(["users"]);
  vi.mocked(api.describeTable).mockResolvedValue(COLUMNS);
});

describe("QueryBuilder validation (改善 2)", () => {
  it("starts with WHERE off, so the empty condition row does not block Run", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    expect(screen.getByRole("checkbox", { name: t("qbWhereToggle") })).not.toBeChecked();
    expect(screen.queryByPlaceholderText(t("qbColumn"))).toBeNull();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled();
    });
  });

  it("disables Run when WHERE is enabled with no filled condition", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    enableWhere();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled();
    });
  });

  it("enables Run once a WHERE condition column is filled in", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    enableWhere();
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

/**
 * 有効になった「全カラムを追加」ボタンを返す。
 *
 * このボタンは列 (listDatabases → listTables → describeTable の 3 段の非同期取得) が
 * 届くまで無効で、無効の間だけ Tooltip の `focusableWrapper` (フォーカス可能な
 * `<span>` 包み) の中に置かれる。列が届くと包みが外れて `<button>` が別の DOM ノードに
 * 作り直されるため、列の到着前に `findByRole` で掴んだ参照は document から切り離され、
 * 無効のまま二度と変わらない (負荷で列の到着が遅れた CI でだけ落ちていた原因)。
 * そのため「有効なボタンが document にある」ことを、毎回取り直しながら待つ。
 */
async function findEnabledAddAllButton(): Promise<HTMLElement> {
  return waitFor(() => {
    const btn = screen.getByRole("button", { name: t("qbAddAllColumns") });
    expect(btn).toBeEnabled();
    return btn;
  });
}

describe("QueryBuilder INSERT full column expansion + required marks", () => {
  it("expands all non-auto-generated columns via '全カラムを追加' and marks required ones", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "INSERT" }));
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    const addAllBtn = await findEnabledAddAllButton();
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

    const addAllBtn = await findEnabledAddAllButton();
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
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
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
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
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
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
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

// コピー確認 UI の共通化 (#1158)。以前は unmount 時のタイマー cleanup が
// 無く、unmount 後に setState されるリスクがあった。共通フック
// (`useCopyFeedback`) 経由になったことで、コピー直後にモーダルを閉じても
// タイマーが安全に破棄されることを固定する。
describe("QueryBuilder SQL プレビューのコピー確認 (#1158)", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  it("コピー後にアイコンが check に切り替わり、共通 Icon コンポーネント経由で描画される", async () => {
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: t("qbCopy") }));

    const copiedButton = await screen.findByRole("button", { name: t("qbCopied") });
    // 生の inline <svg> (旧実装は viewBox="0 0 16 16" を手書きしていた) ではなく
    // `components/Icon.tsx` が描く tabler アイコン (viewBox="0 0 24 24") 経由で
    // あること (UI 規約 §5)。
    const svg = copiedButton.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("コピー確認表示中にモーダルを閉じて (unmount) もタイマーが原因の例外は起きない", async () => {
    const { unmount } = renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(api.listTables).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: t("qbCopy") }));
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbCopied") })).toBeInTheDocument());

    expect(() => unmount()).not.toThrow();
  });
});

describe("QueryBuilder WHERE の AND / OR とグループ (#1540)", () => {
  it("2 行目以降に AND/OR 選択と括弧トグルがあり、実行 SQL に反映される", async () => {
    const onExecute = vi.fn();
    renderWithProviders(
      <QueryBuilder
        sessionId="s1"
        driver="mysql"
        defaultDatabase="testdb"
        defaultTable="users"
        onExecute={onExecute}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    // 先頭行には結合セレクタも括弧トグルも無い。
    expect(screen.queryByLabelText(t("qbWhereConnector"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    const cols = screen.getAllByPlaceholderText(t("qbColumn"));
    expect(cols).toHaveLength(3);
    ["id", "name", "active"].forEach((c, i) => {
      fireEvent.change(cols[i], { target: { value: c } });
    });
    // 文字列列は値入力が候補つきの入力に差し替わる (#1627) ので、列を決めたあとで取り直す。
    const vals = screen.getAllByPlaceholderText(t("qbValue"));
    fireEvent.change(vals[0], { target: { value: "1" } });
    fireEvent.change(vals[1], { target: { value: "x" } });
    const connectors = screen.getAllByLabelText(t("qbWhereConnector"));
    expect(connectors).toHaveLength(2);
    fireEvent.change(connectors[1], { target: { value: "OR" } });
    const groupBtns = screen.getAllByRole("button", { name: t("qbWhereGroupTip") });
    fireEvent.click(groupBtns[0]);
    fireEvent.click(groupBtns[1]);
    expect(groupBtns[0]).toHaveAttribute("aria-pressed", "true");

    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute.mock.calls[0][0]).toContain("WHERE `id` = 1 AND `name` = 'x' OR `active`");
  });
  it("DELETE / UPDATE で括弧なしの AND と OR が混在すると優先順位の注意を出し、SELECT では出さない", async () => {
    renderWithProviders(
      <QueryBuilder
        sessionId="s1"
        driver="mysql"
        defaultDatabase="testdb"
        defaultTable="users"
        onExecute={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    const cols = screen.getAllByPlaceholderText(t("qbColumn"));
    ["id", "name", "active"].forEach((c, i) => fireEvent.change(cols[i], { target: { value: c } }));
    const connectors = screen.getAllByLabelText(t("qbWhereConnector"));
    fireEvent.change(connectors[0], { target: { value: "AND" } });
    fireEvent.change(connectors[1], { target: { value: "OR" } });
    // SELECT では出ない。
    expect(screen.queryByTestId("qb-and-or-precedence")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "DELETE" }));
    expect(await screen.findByTestId("qb-and-or-precedence")).toHaveTextContent(t("qbWhereAndOrPrecedence"));
    fireEvent.click(screen.getByRole("button", { name: "UPDATE" }));
    expect(await screen.findByTestId("qb-and-or-precedence")).toBeInTheDocument();
  });
});

describe("QueryBuilder 読み込みエラー (#1602)", () => {
  it("別のテーブルの読み込みに成功したら、前回のエラーバナーを消す", async () => {
    vi.mocked(api.listTables).mockResolvedValue(["users", "orders"]);
    vi.mocked(api.describeTable).mockRejectedValueOnce("describe failed").mockResolvedValue(COLUMNS);
    renderWithProviders(
      <QueryBuilder sessionId="s1" driver="mysql" onExecute={() => {}} onClose={() => {}} />,
    );
    await screen.findByText(/describe failed/);
    fireEvent.change(screen.getByLabelText(t("qbTable")), { target: { value: "orders" } });
    await waitFor(() => expect(screen.queryByText(/describe failed/)).not.toBeInTheDocument());
  });
});

describe("QueryBuilder の BETWEEN / OFFSET / 値の候補 (#1627)", () => {
  const renderSelect = (onExecute = vi.fn(), driver = "mysql") =>
    renderWithProviders(
      <QueryBuilder
        sessionId="s1"
        driver={driver}
        defaultDatabase="testdb"
        defaultTable="users"
        onExecute={onExecute}
        onClose={() => {}}
      />,
    );

  it("BETWEEN を選ぶと値入力が 2 つになり、両方そろうまで実行できない", async () => {
    const onExecute = vi.fn();
    renderSelect(onExecute);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "id" } });
    // 演算子の入力欄 (既定値 "=") に BETWEEN を入れる。
    const op = screen
      .getAllByRole("combobox")
      .find((el) => el.tagName === "INPUT" && (el as HTMLInputElement).value === "=") as HTMLElement;
    fireEvent.change(op, { target: { value: "BETWEEN" } });
    fireEvent.change(screen.getByPlaceholderText(t("qbBetweenFrom")), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: t("qbExecute") })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(t("qbBetweenTo")), { target: { value: "20" } });
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute.mock.calls[0][0]).toContain("`id` BETWEEN 10 AND 20");
  });

  it("OFFSET を入れると LIMIT n OFFSET m になり、LIMIT を切ると注意を出す", async () => {
    const onExecute = vi.fn();
    renderSelect(onExecute);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "id" } });
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText(t("qbOffset")), { target: { value: "200" } });
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled());
    expect(screen.queryByText(t("qbOffsetNeedsLimit"))).toBeNull();
    fireEvent.click(screen.getByLabelText(t("qbLimitToggle")));
    expect(screen.getByText(t("qbOffsetNeedsLimit"))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(t("qbLimitToggle")));
    fireEvent.change(screen.getByLabelText(t("qbOffset")), { target: { value: "x" } });
    expect(screen.getByText(t("qbOffsetInvalid"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t("qbOffset")), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: t("qbExecute") }));
    expect(onExecute.mock.calls[0][0]).toContain("LIMIT 100 OFFSET 200;");
  });

  it("文字列列の値入力にフォーカスすると候補を 1 回だけ取り、選べる", async () => {
    vi.mocked(api.runLookupQuery).mockResolvedValue({
      columns: [{ name: "name", type_name: "varchar" }],
      rows: [["bob"], ["alice"], [null]],
      rows_affected: null,
      elapsed_ms: 1,
    } as never);
    const onExecute = vi.fn();
    renderSelect(onExecute);
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "name" } });
    const value = () => screen.getByPlaceholderText(t("qbValue"));
    expect(api.runLookupQuery).not.toHaveBeenCalled();
    fireEvent.focus(value());
    await waitFor(() => expect(api.runLookupQuery).toHaveBeenCalledTimes(1));
    const call = vi.mocked(api.runLookupQuery).mock.calls[0][0];
    expect(call.sql).toBe("SELECT DISTINCT `name` FROM `testdb`.`users` WHERE `name` IS NOT NULL LIMIT 50");
    expect(call.rowCap).toBe(50);
    // 並べ替えたうえで候補に出る。
    const alice = await screen.findByRole("option", { name: "alice" });
    const bob = screen.getByRole("option", { name: "bob" });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
    expect(alice.compareDocumentPosition(bob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(bob.closest("[role=listbox]") as HTMLElement).queryAllByRole("option")).toHaveLength(2);
    fireEvent.mouseDown(bob);
    fireEvent.click(bob);
    await waitFor(() => expect((value() as HTMLInputElement).value).toBe("bob"));
    // 再フォーカスしても取り直さない。
    fireEvent.blur(value());
    fireEvent.focus(value());
    expect(api.runLookupQuery).toHaveBeenCalledTimes(1);
  });

  it("数値列・IN 演算子では候補を取りに行かない", async () => {
    renderSelect();
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "id" } });
    fireEvent.focus(screen.getByPlaceholderText(t("qbValue")));
    expect(api.runLookupQuery).not.toHaveBeenCalled();
  });

  it("候補の取得に失敗しても自由入力のまま使える", async () => {
    vi.mocked(api.runLookupQuery).mockRejectedValue(new Error("denied"));
    renderSelect();
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    // WHERE は既定でオフ。「条件を追加」で最初の条件行を出す。
    enableWhere();
    fireEvent.change(screen.getByPlaceholderText(t("qbColumn")), { target: { value: "name" } });
    fireEvent.focus(screen.getByPlaceholderText(t("qbValue")));
    await waitFor(() => expect(api.runLookupQuery).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByPlaceholderText(t("qbValue")), { target: { value: "zed" } });
    await waitFor(() => expect(screen.getByRole("button", { name: t("qbExecute") })).not.toBeDisabled());
  });
  it("条件行を削除しても残った行の入力値は取り違えない (出入りアニメ用の安定キー, #1936)", async () => {
    renderSelect();
    await waitFor(() => expect(api.describeTable).toHaveBeenCalled());
    enableWhere();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("qbAddCondition")) }));
    const values = screen.getAllByPlaceholderText(t("qbValue"));
    fireEvent.change(values[0], { target: { value: "first" } });
    fireEvent.change(values[1], { target: { value: "second" } });
    fireEvent.click(screen.getAllByRole("button", { name: t("qbRemove") })[0]);
    await waitFor(() => expect(screen.getAllByPlaceholderText(t("qbValue"))).toHaveLength(1));
    expect(screen.getByPlaceholderText(t("qbValue"))).toHaveValue("second");
  });
});
