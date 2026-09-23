import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { RowInsertModal } from "../components/RowInsertModal";
import { SAMPLE_COLUMNS } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 行追加モーダル (#604)。マウント時に Tauri 呼び出しを持たない。カラム定義から
 * 入力フォームが例外なくマウントでき、確定ボタンが可視であること・閉じるボタンで
 * `onCancel` が呼ばれることを固定する。
 */
describe("RowInsertModal render smoke (#604)", () => {
  it("mounts as a dialog with an add-row action for the given columns", () => {
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("rowOpsInsertAdd"))).toBeInTheDocument();
  });

  it("invokes onCancel when the close control is activated", () => {
    const onCancel = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    // ヘッダとフッタの両方に「閉じる」ボタンがあるため、先頭 (ヘッダ) を叩く。
    fireEvent.click(screen.getAllByRole("button", { name: t("createTableClose") })[0]);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

/**
 * 行の複製 (#820)。既存行の値を種にモーダルを開くとき、`initialValues` の
 * 各列インデックスの値が対応する入力欄へそのまま反映され、未指定 (通常の
 * 「行を追加」) では従来どおり空欄で開くことを固定する。
 */
describe("RowInsertModal initialValues (#820)", () => {
  it("prefills inputs from initialValues and keeps them editable before confirming", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        initialValues={{ 0: "42", 1: "alice" }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const inputs = screen.getAllByRole("textbox");
    expect((inputs[0] as HTMLInputElement).value).toBe("42");
    expect((inputs[1] as HTMLInputElement).value).toBe("alice");

    fireEvent.click(screen.getByRole("button", { name: t("rowOpsInsertAdd") }));
    expect(onConfirm).toHaveBeenCalledWith({ 0: "42", 1: "alice" });
  });

  it("opens with empty inputs when initialValues is omitted", () => {
    renderWithProviders(
      <RowInsertModal
        table="users"
        columns={SAMPLE_COLUMNS}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    for (const input of screen.getAllByRole("textbox")) {
      expect((input as HTMLInputElement).value).toBe("");
    }
  });
});

/**
 * スマート値ピッカー (#1067)。FK / ENUM / CHECK 列の入力欄に候補 (`<datalist>`) と
 * 種別バッジが付き、候補取得は渡された読み取り専用 lookup 経由だけで行われ、
 * 選んだ値は従来どおり PendingInsertRow の文字列として確定されることを固定する。
 * lookup が失敗した列は候補なし = 従来のテキスト入力のまま。
 */
describe("RowInsertModal value picker (#1067)", () => {
  const tableColumns = [
    {
      name: "user_id",
      data_type: "bigint",
      nullable: false,
      key: "",
      default: null,
      extra: "",
      referenced_table: "users",
      referenced_column: "id",
    },
    {
      name: "size",
      data_type: "enum('S','M')",
      nullable: true,
      key: "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
    {
      name: "note",
      data_type: "text",
      nullable: true,
      key: "",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
  ];
  const columns = [
    { name: "user_id", type_name: "BIGINT" },
    { name: "size", type_name: "ENUM" },
    { name: "note", type_name: "TEXT" },
  ];

  it("offers FK and ENUM candidates through the lookup and confirms the chosen value", async () => {
    const lookup = vi.fn(async (sql: string) => {
      if (sql.includes("CHECK_CONSTRAINTS")) throw new Error("no such table");
      return {
        columns: [{ name: "id", type_name: "BIGINT" }],
        rows: [["9007199254740993"], [7]],
        rows_affected: 0,
        elapsed_ms: 1,
      };
    });
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="orders"
        columns={columns}
        driver="mysql"
        database="shop"
        tableColumns={tableColumns}
        lookup={lookup}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    // 型由来の ENUM は即時にバッジが付き、FK もメタだけで判定できる。
    expect(screen.getByTestId("value-picker-badge-size")).toHaveTextContent(t("valuePickerEnum"));
    expect(screen.getByTestId("value-picker-badge-user_id")).toHaveTextContent("users.id");
    expect(screen.queryByTestId("value-picker-badge-note")).toBeNull();

    const fkInput = document.body.querySelectorAll("input")[0] as HTMLInputElement;
    fireEvent.focus(fkInput);
    await waitFor(() => {
      const opts = [...document.body.querySelectorAll("datalist option")].map(
        (o) => (o as HTMLOptionElement).value,
      );
      expect(opts).toEqual(expect.arrayContaining(["9007199254740993", "7", "S", "M"]));
    });
    const fkSql = lookup.mock.calls.map((c) => c[0]).find((s) => s.includes("`users`"));
    expect(fkSql).toBe(
      "SELECT DISTINCT `id` FROM `shop`.`users` WHERE `id` IS NOT NULL ORDER BY `id` LIMIT 50",
    );
    expect(fkInput.getAttribute("list")).toBeTruthy();
    // テキスト列には候補を紐づけない (従来の入力のまま)。
    expect((document.body.querySelectorAll("input")[2] as HTMLInputElement).getAttribute("list")).toBeNull();

    fireEvent.change(fkInput, { target: { value: "9007199254740993" } });
    fireEvent.click(screen.getByText(t("rowOpsInsertAdd")));
    expect(onConfirm).toHaveBeenCalledWith({ 0: "9007199254740993" });
  });

  it("stays a plain text input when no lookup is given", () => {
    renderWithProviders(
      <RowInsertModal
        table="orders"
        columns={columns}
        tableColumns={tableColumns}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.body.querySelector("datalist")).toBeNull();
    expect(screen.queryByTestId("value-picker-badge-user_id")).toBeNull();
  });
});
