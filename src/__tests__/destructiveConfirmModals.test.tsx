import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { RegisterLocalTableModal } from "../components/RegisterLocalTableModal";
import { RenameTableDialog } from "../components/RenameTableDialog";

describe("RenameTableDialog (#1615)", () => {
  const sql = (n: string) => `ALTER TABLE users RENAME TO ${n};`;

  it("確定前に実行される SQL をプレビューする", () => {
    renderWithProviders(
      <RenameTableDialog
        table="users"
        existingTables={["users"]}
        buildSql={sql}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByText("ALTER TABLE users RENAME TO users;")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "people" } });
    expect(screen.getByText("ALTER TABLE users RENAME TO people;")).toBeTruthy();
  });

  it("既存テーブル名と大小無視で衝突したら警告して確定させない", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RenameTableDialog
        table="users"
        existingTables={["users", "Orders"]}
        buildSql={sql}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "orders" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("大小だけ変える改名は衝突扱いにしない", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RenameTableDialog
        table="users"
        existingTables={["users"]}
        buildSql={sql}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Users" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("Users");
  });
});

describe("RegisterLocalTableModal (#1615)", () => {
  it("衝突しない名前は Enter で確定できる", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RegisterLocalTableModal
        rowCount={3}
        existingTables={["a"]}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "fresh" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("fresh");
  });

  it("既存名と衝突すると Enter / Ctrl+Enter では確定せず、上書きボタンの明示クリックだけで確定する", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <RegisterLocalTableModal
        rowCount={3}
        existingTables={["Sales"]}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "sales" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Overwrite|上書き/ }));
    expect(onConfirm).toHaveBeenCalledWith("sales");
  });
});

describe("ParameterInputModal の引用符警告 (#1615)", () => {
  it("引用符で囲んだプレースホルダに警告を出し、数値型にすると消える", async () => {
    const { ParameterInputModal } = await import("../components/ParameterInputModal");
    renderWithProviders(
      <ParameterInputModal
        sql="SELECT * FROM t WHERE name = '{{name}}'"
        driver="mysql"
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/\{\{name\}\}.*(引用符|quotes)/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "number" } });
    expect(screen.queryByText(/\{\{name\}\}.*(引用符に囲まれて|wrapped in quotes)/)).toBeNull();
  });
});

describe("RowInsertModal の Enter (#1615)", () => {
  it("Enter は次の欄へ移るだけで確定せず、Ctrl+Enter で確定する", async () => {
    const { RowInsertModal } = await import("../components/RowInsertModal");
    const onConfirm = vi.fn();
    renderWithProviders(
      <RowInsertModal
        table="t"
        driver="mysql"
        columns={[
          { name: "a", type_name: "varchar" },
          { name: "b", type_name: "varchar" },
        ]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const [a, b] = screen.getAllByRole("textbox");
    a.focus();
    fireEvent.change(a, { target: { value: "x" } });
    fireEvent.keyDown(a, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(b);
    fireEvent.keyDown(b, { key: "Enter" });
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(b, { key: "Enter", ctrlKey: true });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
