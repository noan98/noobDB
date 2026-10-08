import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { RowInspector, type RowInspectorEdit } from "../components/RowInspector";
import type { Column } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { validateCellInput } from "../components/cellEdit";

// 行インスペクタのフォーム編集 (#1394) の UI 結線。判定は `rowInspectorEdit.test.ts` が
// 固定し、ここは「編集開始 → 入力 → 適用 / キャンセル / Cmd+Enter / Esc」と、
// 編集不可のときの表示を見る。

const COLS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "age", type_name: "INT" },
];
const VALUES = [1, "alice", 30];

function renderForm(opts: {
  edit?: Partial<RowInspectorEdit> | null;
  onClose?: () => void;
}) {
  const edit: RowInspectorEdit | undefined =
    opts.edit === null
      ? undefined
      : {
          rowKey: "k1",
          editableColumns: [false, true, true],
          blockedReason: null,
          validate: (ci, raw) => validateCellInput(raw, COLS[ci].type_name, true),
          onApply: vi.fn(async () => true),
          ...opts.edit,
        };
  renderWithProviders(
    <RowInspector
      columns={COLS}
      values={VALUES}
      columnKinds={["number", "string", "number"]}
      rowNumber={1}
      hasPrev={false}
      hasNext={false}
      onClose={opts.onClose ?? (() => {})}
      edit={edit}
    />,
  );
  return edit;
}

const pencil = () => screen.queryByRole("button", { name: t("rowInspectorEdit") });
const startEditing = () => fireEvent.click(pencil() as HTMLElement);

describe("RowInspector のフォーム編集 (#1394)", () => {
  beforeEach(() => {
    setLocale("en");
  });

  it("edit が無ければ編集ボタンを出さない (閲覧専用)", () => {
    renderForm({ edit: null });
    expect(pencil()).toBeNull();
  });

  it("編集可能な列が 1 つも無ければ編集ボタンを出さない", () => {
    renderForm({ edit: { editableColumns: [false, false, false] } });
    expect(pencil()).toBeNull();
  });

  it("編集開始で編集可能な列だけ入力欄になり、PK は値のまま", () => {
    renderForm({});
    startEditing();
    expect(screen.getByLabelText("name")).toBeTruthy();
    expect(screen.getByLabelText("age")).toBeTruthy();
    expect(screen.queryByLabelText("id")).toBeNull();
  });

  it("変更して適用すると、変わった列だけを onApply に渡す", async () => {
    const edit = renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("age"), { target: { value: "31" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(edit?.onApply).toHaveBeenCalledWith({ 2: "31" }));
  });

  it("変更が無ければ適用ボタンは無効", () => {
    renderForm({});
    startEditing();
    expect(
      (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("検証エラーの欄があると適用できず、エラー文を出す", () => {
    const edit = renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("age"), { target: { value: "abc" } });
    expect(
      (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(t("editInvalidNumber"));
    expect(edit?.onApply).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter で適用する", async () => {
    const edit = renderForm({});
    startEditing();
    const input = screen.getByLabelText("name");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(edit?.onApply).toHaveBeenCalledWith({ 1: "bob" }));
  });

  it("適用が失敗 (false) したら下書きを残す", async () => {
    const edit = renderForm({ edit: { onApply: vi.fn(async () => false) } });
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(edit?.onApply).toHaveBeenCalled());
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("bob");
  });

  it("キャンセルで下書きを捨てて閲覧に戻る", () => {
    renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t("rowInspectorEditCancel") }));
    expect(screen.queryByLabelText("name")).toBeNull();
    expect(screen.getByText("alice")).toBeTruthy();
  });

  it("Esc は編集中なら下書きだけ捨て、閉じない", () => {
    const onClose = vi.fn();
    renderForm({ onClose });
    startEditing();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByLabelText("name")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("行がブロックされていると編集ボタンは無効で理由を示す", () => {
    renderForm({ edit: { blockedReason: "rowInspectorEditBlockedPending" } });
    expect((pencil() as HTMLButtonElement).disabled).toBe(true);
  });
});
