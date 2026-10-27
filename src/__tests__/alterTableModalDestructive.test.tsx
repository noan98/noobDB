import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext } from "../api/tauri";

/**
 * AlterTableModal の破壊的変更の表示 (#1529)。DROP COLUMN などを含むときは
 * 警告帯を出し、実行を dangerOutline (左) / キャンセルを primary (右) の破壊的
 * パターンへ切り替え、Cmd/Ctrl+Enter での実行は止める。含まないときは従来どおり。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
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
        name: "memo",
        data_type: "text",
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
    checks: [],
    generated: [],
    table_names: ["t"],
    warnings: [],
  };
  return { ...actual, api: { ...actual.api, alterTableContext: vi.fn().mockResolvedValue(ctx) } };
});

import { AlterTableModal } from "../components/AlterTableModal";

function renderModal(onRun = vi.fn()) {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver="mysql"
      database="db"
      table="t"
      readOnly={false}
      onRun={onRun}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
  return onRun;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AlterTableModal 破壊的変更 (#1529)", () => {
  it("DROP COLUMN を含むと警告帯を出し、実行ボタンを dangerOutline の左側に置く", async () => {
    renderModal();
    const dropButtons = await screen.findAllByRole("button", { name: t("alterTableDrop") });
    expect(screen.queryByText(t("alterTableDestructiveBody"))).toBeNull();

    fireEvent.click(dropButtons[1]);

    expect(await screen.findByText(t("alterTableDestructiveTitle", { count: 1 }))).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("DROP COLUMN");

    const run = screen.getByRole("button", { name: t("alterTableRun") });
    // ヘッダの × も同名なので、フッターのもの (最後) を取る。
    const close = screen.getAllByRole("button", { name: t("createTableClose") }).at(-1) as HTMLElement;
    // 実行は非強調 (dangerOutline) で閉じるより前 (左)、閉じるが primary。
    expect(run.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(run.className).not.toBe(close.className);
  });

  it("破壊的変更があるとき Cmd/Ctrl+Enter では実行されない (ボタンのクリックは実行できる)", async () => {
    const onRun = renderModal();
    const dropButtons = await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(dropButtons[1]);
    await screen.findByText(t("alterTableDestructiveTitle", { count: 1 }));

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("alterTableRun") }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("破壊的変更が無い通常の変更では警告帯が出ず、Cmd/Ctrl+Enter で実行できる", async () => {
    const onRun = renderModal();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    const inputs = screen.getAllByLabelText(new RegExp(`${t("createTableColType")}: memo`));
    fireEvent.change(inputs[0], { target: { value: "varchar(10)" } });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeEnabled();
    });
    expect(screen.queryByText(t("alterTableDestructiveBody"))).toBeNull();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onRun).toHaveBeenCalledOnce();
  });
});

describe("AlterTableModal インデックス行の不備 (#1532)", () => {
  it("追加直後の空行にはエラーを出さず、触った後に行ごとに出す。不完全な間は実行しない", async () => {
    const onRun = renderModal();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    const inputs = screen.getAllByLabelText(new RegExp(`${t("createTableColType")}: memo`));
    fireEvent.change(inputs[0], { target: { value: "varchar(10)" } });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeEnabled();
    });

    fireEvent.click(screen.getByRole("button", { name: t("alterTableAddIndex") }));
    // 行ごとのエラーは伏せたまま、止まっている理由は出る。
    expect(await screen.findByText(t("alterTableIndexIncompleteBlocked"))).toBeInTheDocument();
    expect(screen.queryByText(t("alterTableIndexNameRequired"))).toBeNull();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onRun).not.toHaveBeenCalled();
    // 実行を試みた後は行のエラーも出る。
    expect(await screen.findByText(t("alterTableIndexNameRequired"))).toBeInTheDocument();
    expect(screen.getByText(t("alterTableIndexColumnsRequired"))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(t("alterTableIndexNamePlaceholder")), {
      target: { value: "idx_memo" },
    });
    expect(screen.queryByText(t("alterTableIndexNameRequired"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("alterTableRun") }));
    expect(onRun).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("checkbox").at(-1) as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByText(t("alterTableIndexIncompleteBlocked"))).toBeNull();
    });
    expect(screen.queryByText(t("alterTableIndexColumnsRequired"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("alterTableRun") }));
    expect(onRun).toHaveBeenCalledOnce();
  });

  it("名前欄のフォーカスを外すとその行のエラーが出る", async () => {
    renderModal();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(screen.getByRole("button", { name: t("alterTableAddIndex") }));
    const name = screen.getByLabelText(t("alterTableIndexNamePlaceholder"));
    expect(screen.queryByText(t("alterTableIndexNameRequired"))).toBeNull();
    fireEvent.blur(name);
    expect(await screen.findByText(t("alterTableIndexNameRequired"))).toBeInTheDocument();
  });

  it("名前を入力して空に戻すと、blur なしでもその行のエラーが出る", async () => {
    renderModal();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(screen.getByRole("button", { name: t("alterTableAddIndex") }));
    const name = screen.getByLabelText(t("alterTableIndexNamePlaceholder"));
    fireEvent.change(name, { target: { value: "x" } });
    expect(screen.queryByText(t("alterTableIndexNameRequired"))).toBeNull();
    fireEvent.change(name, { target: { value: "" } });
    expect(await screen.findByText(t("alterTableIndexNameRequired"))).toBeInTheDocument();
  });

  it("破壊的変更があっても、不完全なインデックス行がある間は実行ボタンで実行されない", async () => {
    const onRun = renderModal();
    const dropButtons = await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(dropButtons[1]);
    await screen.findByText(t("alterTableDestructiveTitle", { count: 1 }));
    fireEvent.click(screen.getByRole("button", { name: t("alterTableAddIndex") }));
    expect(await screen.findByText(t("alterTableIndexIncompleteBlocked"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("alterTableRun") }));
    expect(onRun).not.toHaveBeenCalled();
  });
});
