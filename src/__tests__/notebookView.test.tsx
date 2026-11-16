import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";

const mocks = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  writeTextFile: vi.fn(),
  readTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
vi.mock("../api/tauri", async (orig) => {
  const actual = await orig<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, writeTextFile: mocks.writeTextFile, readTextFile: mocks.readTextFile },
  };
});
// CodeMirror は jsdom で重いので、本文の入出力だけを持つ代替にする。
vi.mock("../components/QueryEditor", () => ({
  QueryEditor: ({ initialSql, onChange }: { initialSql?: string; onChange?: (s: string) => void }) => (
    <textarea
      aria-label="sql-editor"
      defaultValue={initialSql}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

// セル数の上限の検査は、上限まで描画すると jsdom で遅い (CI で 5 秒を超えた) ので、上限を小さくして試す。
// 本当の上限値と読み込み側との一致は notebook.test.ts の checkNotebookLimits のテストが押さえる。
const { TEST_MAX_CELLS } = vi.hoisted(() => ({ TEST_MAX_CELLS: 4 }));
vi.mock("../notebook", async (orig) => {
  const actual = await orig<typeof import("../notebook")>();
  return {
    ...actual,
    MAX_NOTEBOOK_CELLS: TEST_MAX_CELLS,
    checkNotebookLimits: (doc: Parameters<typeof actual.checkNotebookLimits>[0]) =>
      doc.cells.length > TEST_MAX_CELLS
        ? { kind: "cells" as const, limit: TEST_MAX_CELLS }
        : actual.checkNotebookLimits(doc),
  };
});

import { NotebookView } from "../components/NotebookView";
import { MAX_NOTEBOOK_CELLS, newMarkdownCell, newSqlCell, createEmptyNotebook } from "../notebook";
import { replaceNotebook, getNotebookState, markNotebookSaved, updateNotebook } from "../notebookStore";
import { NotebookRunError } from "../notebookExec";

const OUT = {
  columns: [
    { name: "id", type_name: "int" },
    { name: "email", type_name: "text" },
  ],
  rows: [[1, "a@b.c"]],
  totalRows: 500,
  rowsAffected: 0,
  hasColumns: true,
  elapsedMs: 7,
  serverMessages: undefined,
  readOnly: true,
  schemaMayChange: false,
};

function setup(over: Partial<React.ComponentProps<typeof NotebookView>> = {}) {
  const onRunSql = vi.fn().mockResolvedValue(OUT);
  const props = {
    sessionId: "s1",
    profile: makeProfile(),
    schemaForDatabase: () => null,
    transactionActive: false,
    emergencyMode: false,
    onRunSql,
    onOpenInEditor: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  renderWithProviders(<NotebookView {...props} />);
  return { props, onRunSql };
}

function seed(...cells: ReturnType<typeof newSqlCell | typeof newMarkdownCell>[]) {
  const d = createEmptyNotebook(null);
  d.cells = cells;
  replaceNotebook(d, null);
}

describe("NotebookView (#2380)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("すべて実行で SQL セルが順に実行され、スナップショットが切り詰め表示つきで残る", async () => {
    seed(newMarkdownCell("# 説明"), newSqlCell("SELECT 1"), newSqlCell("SELECT 2"));
    const { onRunSql } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(2));
    expect(onRunSql.mock.calls.map((c) => c[0])).toEqual(["SELECT 1", "SELECT 2"]);
    // 上限 (既定 200) を渡している
    expect(onRunSql.mock.calls[0][1]).toMatchObject({ rowCap: 200 });
    const meta = await screen.findAllByTestId("notebook-snapshot-meta");
    expect(meta).toHaveLength(2);
    // 総行数 500 に対して保存は 1 行だけ → 切り詰めの案内が出る
    expect(screen.getAllByText(t("notebookTruncated", { shown: 1, total: 500 }))).toHaveLength(2);
    // マスキング既定 (email 列) は伏せ字で保持される
    expect(getNotebookState().doc.cells[1]).toMatchObject({ snapshot: { maskedColumns: ["email"] } });
  });

  it("確認を取りやめたら (null) 結果は残さず、後続も実行しない", async () => {
    seed(newSqlCell("DELETE FROM t"), newSqlCell("SELECT 2"));
    const onRunSql = vi.fn().mockResolvedValue(null);
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
    expect(getNotebookState().doc.cells.every((c) => c.kind !== "sql" || c.snapshot === null)).toBe(true);
  });

  it("失敗したセルはエラーを結果として残し、そこで止まる", async () => {
    seed(newSqlCell("SELECT bad"), newSqlCell("SELECT 2"));
    const onRunSql = vi.fn().mockRejectedValue(new NotebookRunError("syntax error", false, false, false));
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    expect(await screen.findByText(t("notebookError", { error: "syntax error" }))).toBeTruthy();
    expect(onRunSql).toHaveBeenCalledTimes(1);
  });

  it("未接続では実行できない", () => {
    seed(newSqlCell("SELECT 1"));
    setup({ sessionId: null });
    const btn = screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("書き込み文を含むセルには印が付く", () => {
    seed(newSqlCell("DELETE FROM t"), newSqlCell("SELECT 1"));
    setup();
    expect(screen.getAllByTestId("notebook-writes-badge")).toHaveLength(1);
  });

  it("セルを下へ動かすと並びが変わり、削除でセルが消える", async () => {
    const a = newSqlCell("SELECT 1");
    const b = newMarkdownCell("note");
    seed(a, b);
    setup();
    fireEvent.click(screen.getAllByRole("button", { name: t("notebookMoveDown") })[0]);
    expect(getNotebookState().doc.cells.map((c) => c.id)).toEqual([b.id, a.id]);
    fireEvent.click(screen.getAllByRole("button", { name: t("notebookDelete") })[0]);
    expect(getNotebookState().doc.cells.map((c) => c.id)).toEqual([a.id]);
  });

  it("保存は .noobnb をファイルへ書き、秘密情報を含まない (マスクも掛かる)", async () => {
    const sql = newSqlCell("SELECT 1");
    seed(sql);
    mocks.save.mockResolvedValue("/tmp/x.noobnb");
    mocks.writeTextFile.mockResolvedValue(10);
    setup({ profile: makeProfile({ id: "p9", name: "検証" }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await screen.findByTestId("notebook-snapshot-meta");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("notebookSave") }));
    });
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalled());
    const [path, body] = mocks.writeTextFile.mock.calls[0];
    expect(path).toBe("/tmp/x.noobnb");
    const file = JSON.parse(body as string);
    expect(file.version).toBe(1);
    expect(file.connection).toEqual({ profileId: "p9", name: "検証" });
    expect(body).not.toContain("a@b.c");
    expect(body).not.toMatch(/password|passphrase/i);
    expect(getNotebookState().dirty).toBe(false);
  });

  it("保存済みの接続が現在と違うときは、確認するまで実行しない (取りやめで未実行)", async () => {
    const d = createEmptyNotebook({ profileId: "other", name: "本番DB" });
    d.cells = [newSqlCell("SELECT 1")];
    replaceNotebook(d, null);
    const { onRunSql } = setup({ profile: makeProfile({ id: "cur", name: "検証" }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await screen.findByRole("button", { name: t("notebookRebindConfirm") });
    const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
    await act(async () => {
      fireEvent.click(cancels[cancels.length - 1]);
    });
    expect(onRunSql).not.toHaveBeenCalled();
    expect(getNotebookState().doc.connection).toEqual({ profileId: "other", name: "本番DB" });
  });

  it("接続の付け替えを確認したら実行し、その時点で現在の接続を記録する", async () => {
    const d = createEmptyNotebook({ profileId: "other", name: "本番DB" });
    d.cells = [newSqlCell("SELECT 1")];
    replaceNotebook(d, null);
    const { onRunSql } = setup({ profile: makeProfile({ id: "cur", name: "検証" }) });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: t("notebookRebindConfirm") }));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
    expect(getNotebookState().doc.connection).toEqual({ profileId: "cur", name: "検証" });
  });

  it("トランザクション中も停止ボタンは有効 (文と文の間で止まる)", async () => {
    seed(newSqlCell("SELECT 1"));
    const onRunSql = vi.fn().mockReturnValue(new Promise(() => {}));
    setup({ onRunSql, transactionActive: true });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    const stop = await screen.findByRole("button", { name: new RegExp(t("notebookStop")) });
    expect((stop as HTMLButtonElement).disabled).toBe(false);
  });

  it("上限 (8 MiB) を超える文書は保存せず案内する", async () => {
    const d = createEmptyNotebook(null);
    d.cells = [newMarkdownCell("あ".repeat(3 * 1024 * 1024))];
    replaceNotebook(d, null);
    mocks.save.mockResolvedValue("/tmp/big.noobnb");
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("notebookSave") }));
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("個別セルの実行と「ここから下」でも接続の確認が出る", async () => {
    const d = createEmptyNotebook({ profileId: "other", name: "本番DB" });
    d.cells = [newSqlCell("SELECT 1"), newSqlCell("SELECT 2")];
    replaceNotebook(d, null);
    const { onRunSql } = setup({ profile: makeProfile({ id: "cur", name: "検証" }) });
    for (const name of [t("notebookRunCell"), t("notebookRunFrom")]) {
      await act(async () => {
        fireEvent.click(screen.getAllByRole("button", { name: new RegExp(name) })[0]);
      });
      await screen.findByRole("button", { name: t("notebookRebindConfirm") });
      const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
      await act(async () => {
        fireEvent.click(cancels[cancels.length - 1]);
      });
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: t("notebookRebindConfirm") })).toBeNull(),
      );
    }
    expect(onRunSql).not.toHaveBeenCalled();
  });

  it("「エディタで開く」はノートブックの実行先 DB を渡す (未指定なら null)", async () => {
    const d = createEmptyNotebook(null);
    d.database = "audit";
    d.cells = [newSqlCell("SELECT 1")];
    replaceNotebook(d, null);
    const { props } = setup();
    fireEvent.click(screen.getByRole("button", { name: t("notebookOpenInEditor") }));
    expect(props.onOpenInEditor).toHaveBeenLastCalledWith("SELECT 1", expect.any(String), "audit");
    act(() => updateNotebook((x) => ({ ...x, database: null })));
    fireEvent.click(screen.getByRole("button", { name: t("notebookOpenInEditor") }));
    expect(props.onOpenInEditor).toHaveBeenLastCalledWith("SELECT 1", expect.any(String), null);
  });

  it("保存の書き込み中に文書が編集されたら、保存済みにせず dirty のまま残す", async () => {
    seed(newSqlCell("SELECT 1"));
    updateNotebook((x) => x); // dirty にする
    mocks.save.mockResolvedValue("/tmp/race.noobnb");
    let finish: (n: number) => void = () => {};
    mocks.writeTextFile.mockReturnValue(new Promise<number>((r) => (finish = r)));
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("notebookSave") }));
    });
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalled());
    // 書き込み中は新規 / 開くを押せない
    expect((screen.getByRole("button", { name: t("notebookNew") }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: t("notebookOpen") }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => updateNotebook((x) => ({ ...x, title: "保存中に変えた" })));
    await act(async () => {
      finish(10);
    });
    expect(getNotebookState().dirty).toBe(true);
    expect(getNotebookState().doc.title).toBe("保存中に変えた");
  });

  it("保存の完了時に文書が入れ替わっていたら、古いパスを新しい文書へ付けない", () => {
    seed(newSqlCell("SELECT 1"));
    const started = getNotebookState();
    const fresh = createEmptyNotebook(null);
    replaceNotebook(fresh, null);
    markNotebookSaved("/tmp/old.noobnb", { epoch: started.epoch, revision: started.revision });
    expect(getNotebookState().filePath).toBeNull();
    expect(getNotebookState().doc).toBe(fresh);
  });

  it("何も変わらなければ保存済みになりパスが付く", () => {
    seed(newSqlCell("SELECT 1"));
    updateNotebook((x) => x);
    const s = getNotebookState();
    markNotebookSaved("/tmp/ok.noobnb", { epoch: s.epoch, revision: s.revision });
    expect(getNotebookState()).toMatchObject({ dirty: false, filePath: "/tmp/ok.noobnb" });
  });

  it("セルが読み込み上限を超える文書は保存せずエラーにする", async () => {
    const d = createEmptyNotebook(null);
    d.cells = Array.from({ length: MAX_NOTEBOOK_CELLS + 1 }, () => newSqlCell("SELECT 1"));
    replaceNotebook(d, null);
    mocks.save.mockResolvedValue("/tmp/many.noobnb");
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("notebookSave") }));
    });
    await screen.findByText(t("notebookTooManyCells", { limit: MAX_NOTEBOOK_CELLS.toLocaleString() }));
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("セルの追加も上限で止まる", async () => {
    const d = createEmptyNotebook(null);
    d.cells = Array.from({ length: MAX_NOTEBOOK_CELLS }, () => newSqlCell("SELECT 1"));
    replaceNotebook(d, null);
    setup();
    fireEvent.click(screen.getAllByRole("button", { name: t("notebookAddSql") })[0]);
    await screen.findByText(t("notebookTooManyCells", { limit: MAX_NOTEBOOK_CELLS.toLocaleString() }));
    expect(getNotebookState().doc.cells).toHaveLength(MAX_NOTEBOOK_CELLS);
  });
});
