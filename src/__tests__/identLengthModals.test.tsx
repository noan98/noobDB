import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { RenameTableDialog } from "../components/RenameTableDialog";

// 長すぎる識別子はモーダルの確定を止める (#2384)。PostgreSQL は黙って切り詰めるため特に重要。
function renderRename(driver: string) {
  const onConfirm = vi.fn();
  renderWithProviders(
    <RenameTableDialog
      driver={driver}
      table="users"
      existingTables={[]}
      buildSql={(n) => `ALTER TABLE users RENAME TO ${n};`}
      onConfirm={onConfirm}
      onCancel={() => {}}
    />,
  );
  return onConfirm;
}

describe("識別子の長さ検査 (#2384)", () => {
  it("PostgreSQL: 日本語 22 文字 (66 バイト) は確定できずエラーを出す", () => {
    const onConfirm = renderRename("postgres");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "あ".repeat(22) } });
    expect(screen.getByTestId("ident-too-long")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("PostgreSQL: 21 文字 (63 バイト) は確定できる", () => {
    const onConfirm = renderRename("postgres");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "あ".repeat(21) } });
    expect(screen.queryByTestId("ident-too-long")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledWith("あ".repeat(21));
  });

  it("SQLite: 長い名前も確定できる", () => {
    const onConfirm = renderRename("sqlite");
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "a".repeat(200) } });
    expect(screen.queryByTestId("ident-too-long")).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalled();
  });
});
