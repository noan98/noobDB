import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { RowInspector, type RowInspectorEdit } from "../components/RowInspector";
import type { CellValue, Column } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { validateCellInput } from "../components/cellEdit";

// 行インスペクタのフォーム編集 (#1394) の UI 結線。判定は `rowInspectorEdit.test.ts` が
// 固定し、ここは「編集開始 → 入力 → 適用 / キャンセル / Cmd+Enter / Esc」と、
// 行の値が途中で変わったとき (自動リフレッシュ・グリッド Apply) の扱いを見る。

const COLS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "name", type_name: "VARCHAR" },
  { name: "age", type_name: "INT" },
];
const VALUES: CellValue[] = [1, "alice", 30];

function makeEdit(over: Partial<RowInspectorEdit> = {}): RowInspectorEdit {
  return {
    rowKey: "k1",
    editableColumns: [false, true, true],
    blockedReason: null,
    validate: (ci, raw) => validateCellInput(raw, COLS[ci].type_name, true),
    onApply: vi.fn(async () => true),
    ...over,
  };
}

function inspector(values: CellValue[], edit: RowInspectorEdit | undefined, onClose = () => {}, cols = COLS): ReactElement {
  return (
    <RowInspector
      columns={cols}
      values={values}
      columnKinds={cols.map(() => "string")}
      rowNumber={1}
      hasPrev={false}
      hasNext={false}
      onClose={onClose}
      edit={edit}
    />
  );
}

function renderForm(opts: { edit?: Partial<RowInspectorEdit> | null; onClose?: () => void; values?: CellValue[] }) {
  const edit = opts.edit === null ? undefined : makeEdit(opts.edit);
  const view = renderWithProviders(inspector(opts.values ?? VALUES, edit, opts.onClose));
  return { edit, rerender: (values: CellValue[]) => view.rerender(inspector(values, edit, opts.onClose)) };
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
    const { edit } = renderForm({});
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
    const { edit } = renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("age"), { target: { value: "abc" } });
    expect(
      (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(t("editInvalidNumber"));
    expect(edit?.onApply).not.toHaveBeenCalled();
  });

  it("Cmd/Ctrl+Enter で適用する", async () => {
    const { edit } = renderForm({});
    startEditing();
    const input = screen.getByLabelText("name");
    fireEvent.change(input, { target: { value: "bob" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(edit?.onApply).toHaveBeenCalledWith({ 1: "bob" }));
  });

  it("適用が失敗 (false) したら下書きを残す", async () => {
    const { edit } = renderForm({ edit: { onApply: vi.fn(async () => false) } });
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

  it("(A) 編集中に自動リフレッシュで行の値が変わると、適用できず編集し直しを促す", () => {
    const { edit, rerender } = renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("age"), { target: { value: "31" } });
    rerender(["1", "alice", 99] as CellValue[]);
    expect(
      (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(t("rowInspectorEditStale"))).toBeTruthy();
    expect(edit?.onApply).not.toHaveBeenCalled();
  });

  it("(B) インスペクタ編集中にグリッドで同じ行を適用 → インスペクタ適用は古い差分を送らない", () => {
    const { edit, rerender } = renderForm({});
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    // グリッド Apply で同じ行の age が 40 になった (結果行が更新された)
    rerender([1, "alice", 40]);
    expect(
      (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("name"), { key: "Enter", ctrlKey: true });
    expect(edit?.onApply).not.toHaveBeenCalled();
    // 編集し直すと、新しい値を基準に差分が作られる (name だけ、age は送らない)
    fireEvent.click(screen.getByRole("button", { name: t("rowInspectorEditCancel") }));
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    return waitFor(() => expect(edit?.onApply).toHaveBeenCalledWith({ 1: "bob" }));
  });

  it("改行を含む値は複数行欄になり、改行を保ったまま適用できる", async () => {
    const cols: Column[] = [
      { name: "id", type_name: "INT" },
      { name: "bio", type_name: "TEXT" },
    ];
    const onApply = vi.fn(async () => true);
    const edit = makeEdit({ editableColumns: [false, true], onApply, validate: () => null });
    renderWithProviders(inspector([1, "line1\nline2"], edit, () => {}, cols));
    startEditing();
    const area = screen.getByLabelText("bio") as HTMLTextAreaElement;
    expect(area.tagName).toBe("TEXTAREA");
    fireEvent.change(area, { target: { value: "a\nb\nc" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ 1: "a\nb\nc" }));
  });

  it("文字列 \"NULL\" を持つ列は、別の列だけ変えたとき触らない", async () => {
    const cols: Column[] = [
      { name: "code", type_name: "VARCHAR" },
      { name: "age", type_name: "INT" },
    ];
    const onApply = vi.fn(async () => true);
    const edit = makeEdit({ editableColumns: [true, true], onApply, validate: (ci, raw) => validateCellInput(raw, cols[ci].type_name, true) });
    renderWithProviders(inspector(["NULL", 5], edit, () => {}, cols));
    startEditing();
    fireEvent.change(screen.getByLabelText("age"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ 1: "6" }));
  });

  it("適用が reject しても適用中状態は解けて、下書きを残し再適用できる", async () => {
    const onApply = vi
      .fn<(e: Record<number, string>) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(true);
    renderForm({ edit: { onApply } });
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: t("editApplyButton") }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("bob");
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(2));
  });

  it("適用の実行中は Esc で下書きを捨てず、閉じもしない", () => {
    const onClose = vi.fn();
    const onApply = vi.fn(() => new Promise<boolean>(() => {}));
    renderForm({ edit: { onApply }, onClose });
    startEditing();
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "bob" } });
    fireEvent.click(screen.getByRole("button", { name: t("editApplyButton") }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("bob");
    expect(onClose).not.toHaveBeenCalled();
  });
});
