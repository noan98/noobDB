import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext, SqliteRebuildPlan } from "../api/tauri";

/**
 * SQLite の構造エディタ (#1888): 型 / NOT NULL / DEFAULT の変更と FK / CHECK の追加・削除は
 * ALTER ではなくテーブル再作成で行う。バックエンドが組み立てた再作成 SQL を `rebuildTable` 文として
 * 出し、リスクを注意枠で見せる。生成が終わるまで・失敗したときは実行できない。
 */
const plan: SqliteRebuildPlan = {
  sql: 'PRAGMA foreign_keys=OFF;\nCREATE TABLE "__noobdb_rebuild_t" ("id" INTEGER);\nPRAGMA foreign_keys=ON;',
  warnings: ["t: インデックス 1 件を作り直します。"],
  risks: [{ kind: "type_affinity", target: "memo" }],
};

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
      {
        name: "id",
        data_type: "INTEGER",
        nullable: false,
        key: "PRI",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
      {
        name: "memo",
        data_type: "TEXT",
        nullable: true,
        key: "",
        default: null,
        extra: "",
        referenced_table: null,
        referenced_column: null,
      },
    ],
    table_comment: "",
    foreign_keys: [
      {
        table: "t",
        column: "id",
        referenced_table: "parent",
        referenced_column: "id",
        constraint_name: "t:0",
      },
    ],
    checks: [{ name: "", definition: "CHECK (id > 0)" }],
    table_names: ["t", "parent"],
    warnings: [],
  };
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn().mockResolvedValue(ctx),
      planSqliteTableRebuild: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { AlterTableModal } from "../components/AlterTableModal";

function renderModal(onRun = vi.fn()) {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver="sqlite"
      database="main"
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
  vi.mocked(api.planSqliteTableRebuild).mockResolvedValue(plan);
});

describe("AlterTableModal SQLite のテーブル再作成 (#1888)", () => {
  it("型の変更を再作成として扱い、生成した SQL とリスクを出して実行できる", async () => {
    const onRun = renderModal();
    const typeInput = (await screen.findAllByLabelText(new RegExp(`${t("createTableColType")}: memo`)))[0];
    fireEvent.change(typeInput, { target: { value: "INTEGER" } });

    expect(await screen.findByText(t("alterTableRebuildTitle"))).toBeInTheDocument();
    // 生成が終わると SQL とリスク・警告が出る。
    expect(
      await screen.findByText(t("alterTableRebuildRiskTypeAffinity", { target: "memo" })),
    ).toBeInTheDocument();
    expect(screen.getByText("t: インデックス 1 件を作り直します。")).toBeInTheDocument();
    expect(screen.getByText(/__noobdb_rebuild_t/)).toBeInTheDocument();
    expect(api.planSqliteTableRebuild).toHaveBeenCalledWith(
      "s1",
      "main",
      "t",
      expect.objectContaining({
        columns: expect.arrayContaining([
          expect.objectContaining({ original: "memo", data_type: "INTEGER", drop: false }),
        ]),
      }),
    );

    const run = screen.getByRole("button", { name: t("alterTableRun") });
    await waitFor(() => expect(run).toBeEnabled());
    // 再作成は破壊的なので Cmd/Ctrl+Enter では実行されず、ボタンのクリックで実行する。
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(onRun).toHaveBeenCalledOnce();
    expect(onRun.mock.calls[0][0]).toEqual([{ sql: plan.sql, kind: "rebuildTable", destructive: true }]);
  });

  it("再現できない構文が失われるときは danger の帯で構文名を出す", async () => {
    vi.mocked(api.planSqliteTableRebuild).mockResolvedValue({
      ...plan,
      risks: [...plan.risks, { kind: "lost_syntax", target: "COLLATE" }],
    });
    renderModal();
    const typeInput = (await screen.findAllByLabelText(new RegExp(`${t("createTableColType")}: memo`)))[0];
    fireEvent.change(typeInput, { target: { value: "INTEGER" } });
    const notice = await screen.findByTestId("alter-rebuild-lost");
    expect(notice).toHaveTextContent("COLLATE");
    expect(notice).toHaveTextContent(t("alterTableRebuildLostTitle"));
  });

  it("バックエンドのエラーコードを翻訳して出す", async () => {
    vi.mocked(api.planSqliteTableRebuild).mockRejectedValue(
      new Error("invalid input: rebuild_error:other_table_trigger:trg_x"),
    );
    renderModal();
    const typeInput = (await screen.findAllByLabelText(new RegExp(`${t("createTableColType")}: memo`)))[0];
    fireEvent.change(typeInput, { target: { value: "INTEGER" } });
    expect(await screen.findByText(new RegExp("trg_x"))).toBeInTheDocument();
    expect(screen.queryByText(/rebuild_error/)).toBeNull();
  });

  it("生成中は実行できない", async () => {
    vi.mocked(api.planSqliteTableRebuild).mockReturnValue(new Promise(() => {}));
    renderModal();
    const typeInput = (await screen.findAllByLabelText(new RegExp(`${t("createTableColType")}: memo`)))[0];
    fireEvent.change(typeInput, { target: { value: "INTEGER" } });
    expect(await screen.findByText(t("alterTableRebuildPlanning"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeDisabled();
  });

  it("生成に失敗するとエラーを出して実行できない", async () => {
    vi.mocked(api.planSqliteTableRebuild).mockRejectedValue(new Error("boom"));
    renderModal();
    const typeInput = (await screen.findAllByLabelText(new RegExp(`${t("createTableColType")}: memo`)))[0];
    fireEvent.change(typeInput, { target: { value: "INTEGER" } });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeDisabled();
  });

  it("既存の FK / CHECK を削除対象に選ぶと再作成の入力に載る", async () => {
    renderModal();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(screen.getByRole("switch", { name: t("alterTableDropFk", { name: "t:0" }) }));
    fireEvent.click(
      screen.getByRole("switch", { name: t("alterTableDropCheck", { name: "CHECK (id > 0)" }) }),
    );
    await waitFor(() => expect(api.planSqliteTableRebuild).toHaveBeenCalled());
    const edit = vi.mocked(api.planSqliteTableRebuild).mock.calls.at(-1)?.[3];
    expect(edit?.dropped_foreign_keys).toEqual([{ columns: ["id"], ref_table: "parent" }]);
    expect(edit?.dropped_checks).toEqual(["CHECK (id > 0)"]);
  });

  it("再作成が要らない編集 (列の削除だけ) ではバックエンドを呼ばない", async () => {
    renderModal();
    const dropButtons = await screen.findAllByRole("button", { name: t("alterTableDrop") });
    fireEvent.click(dropButtons[1]);
    await screen.findByText(t("alterTableDestructiveTitle", { count: 1 }));
    expect(screen.queryByText(t("alterTableRebuildTitle"))).toBeNull();
    expect(api.planSqliteTableRebuild).not.toHaveBeenCalled();
  });
});
