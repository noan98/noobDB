import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen, waitFor, within } from "./testUtils";
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
  const profile = over.profile ?? makeProfile();
  const props = {
    sessionId: "s1",
    profile,
    profiles: [profile],
    openConnections: over.sessionId === null ? [] : [{ sessionId: "s1", profile }],
    schemaForDatabase: () => null,
    transactionActive: false,
    emergencyMode: false,
    onRunSql,
    onOpenInEditor: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const view = renderWithProviders(<NotebookView {...props} />);
  // アクティブ接続の切り替えなど、props を差し替えて描画し直す。
  const rerender = (next: Partial<React.ComponentProps<typeof NotebookView>>) =>
    view.rerender(<NotebookView {...props} {...next} />);
  return { props, onRunSql, rerender, unmount: view.unmount };
}

function seed(...cells: ReturnType<typeof newSqlCell | typeof newMarkdownCell>[]) {
  const d = createEmptyNotebook(null);
  d.cells = cells;
  replaceNotebook(d, null);
}

// jsdom には scrollIntoView が無いので、テストごとに差し込み、終わったら元に戻す。
const originalScrollIntoView = Element.prototype.scrollIntoView;
function stubScrollIntoView() {
  const fn = vi.fn();
  Element.prototype.scrollIntoView = fn;
  return fn;
}

describe("NotebookView (#2380)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (originalScrollIntoView) Element.prototype.scrollIntoView = originalScrollIntoView;
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
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

  it("実行後に SQL を編集すると「古い結果」の目印が出て、再実行で消える (#2420)", async () => {
    seed(newSqlCell("SELECT 1"));
    const { onRunSql, props } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await screen.findByTestId("notebook-snapshot-meta");
    expect(screen.queryByTestId("notebook-stale")).toBeNull();
    // 実行時の SQL と接続が結果に残る
    expect(getNotebookState().doc.cells[0]).toMatchObject({
      snapshot: { sql: "SELECT 1", connection: { profileId: props.profile?.id } },
    });
    // 空白だけの変更は古い扱いにならない
    fireEvent.change(screen.getByLabelText("sql-editor"), { target: { value: "SELECT 1;  " } });
    expect(screen.queryByTestId("notebook-stale")).toBeNull();
    fireEvent.change(screen.getByLabelText("sql-editor"), { target: { value: "SELECT 2" } });
    expect((await screen.findByTestId("notebook-stale-badge")).textContent).toBe(t("notebookStaleBadge"));
    expect(screen.getByTestId("notebook-stale-count").textContent).toBe(
      t("notebookStaleCount", { count: 1 }),
    );
    fireEvent.click(screen.getByTestId("notebook-stale-diff-toggle"));
    expect(screen.getByTestId("notebook-stale-diff").textContent).toBe("- SELECT 1\n+ SELECT 2");
    await act(async () => {
      fireEvent.click(screen.getByTestId("notebook-stale-rerun"));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(2));
    expect(onRunSql.mock.calls[1][0]).toBe("SELECT 2");
    await waitFor(() => expect(screen.queryByTestId("notebook-stale")).toBeNull());
  });

  it("古い結果があるノートブックの書き出しは確認を出し、取りやめれば書き出さない (#2420)", async () => {
    const c = newSqlCell("SELECT 2");
    seed(c);
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await screen.findByTestId("notebook-snapshot-meta");
    fireEvent.change(screen.getByLabelText("sql-editor"), { target: { value: "SELECT 3" } });
    mocks.save.mockResolvedValue("/tmp/out.md");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookExportMd")) }));
    await screen.findByText(t("notebookExportStaleTitle"));
    fireEvent.click(screen.getAllByRole("button", { name: t("confirmDefaultCancel") }).at(-1) as HTMLElement);
    await waitFor(() => expect(screen.queryByText(t("notebookExportStaleTitle"))).toBeNull());
    expect(mocks.writeTextFile).not.toHaveBeenCalled();
  });

  it("既定接続の実行中に DB 欄が編集されても、記録される DB は実行開始時の値 (成功・エラーとも)", async () => {
    for (const fail of [false, true]) {
      seed(newSqlCell("SELECT 1"));
      updateNotebook((d) => ({ ...d, database: "before" }));
      let release: (v: unknown) => void = () => {};
      const onRunSql = vi.fn().mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            release = () => (fail ? reject(new NotebookRunError("boom", false, false, false)) : resolve(OUT));
          }),
      );
      const { unmount } = setup({ onRunSql });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalled());
      expect(onRunSql.mock.calls[0][1]).toMatchObject({ database: "before" });
      act(() => updateNotebook((d) => ({ ...d, database: "after" })));
      await act(async () => release(null));
      await waitFor(() => {
        const c = getNotebookState().doc.cells[0];
        expect(c.kind === "sql" && c.snapshot?.database).toBe("before");
      });
      unmount();
    }
  });

  it("書き出し確認で「このまま書き出す」を押すと、古い結果の注記つきで書き出す (#2420)", async () => {
    seed(newSqlCell("SELECT 2"));
    setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await screen.findByTestId("notebook-snapshot-meta");
    fireEvent.change(screen.getByLabelText("sql-editor"), { target: { value: "SELECT 3" } });
    mocks.save.mockResolvedValue("/tmp/out.md");
    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookExportMd")) }));
    fireEvent.click(await screen.findByRole("button", { name: t("notebookExportStaleConfirm") }));
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledTimes(1));
    expect(mocks.writeTextFile.mock.calls[0][1]).toContain(t("notebookExportStaleNote"));
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

  it("全実行中は実行中セルだけ data-running が付き、n / m と追従スクロールが出る (#2449)", async () => {
    seed(newSqlCell("SELECT 1"), newSqlCell("SELECT 2"));
    const scroll = stubScrollIntoView();
    let release: (v: unknown) => void = () => {};
    const onRunSql = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
    expect(document.querySelectorAll("[data-running]")).toHaveLength(1);
    expect(document.querySelector("[data-running]")?.getAttribute("data-notebook-cell-id")).toBe(
      getNotebookState().doc.cells[0].id,
    );
    expect(screen.getByTestId("notebook-run-count").textContent).toContain("1");
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ block: "nearest" }));
    // 手でスクロールしたら、次のセルへ移っても追従しない
    scroll.mockClear();
    fireEvent.wheel(screen.getByTestId("notebook-scroll-host"));
    await act(async () => release(OUT));
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(2));
    expect(scroll).not.toHaveBeenCalled();
    await act(async () => release(OUT));
    await waitFor(() => expect(document.querySelector("[data-running]")).toBeNull());
  });

  it("失敗で止まったら、停止位置を role=status で伝え、そのセルへ着地する (#2449)", async () => {
    seed(newSqlCell("SELECT 1"), newSqlCell("SELECT bad"), newSqlCell("SELECT 3"));
    const scroll = stubScrollIntoView();
    const onRunSql = vi
      .fn()
      .mockResolvedValueOnce(OUT)
      .mockRejectedValueOnce(new NotebookRunError("syntax error", false, false, false));
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    const outcome = await screen.findByTestId("notebook-run-stopped");
    const msg = t("notebookStoppedFailed", { index: 2, total: 3, done: 1 });
    expect(outcome.textContent).toContain(msg);
    expect(within(outcome).getByRole("status").textContent).toContain(msg);
    expect(onRunSql).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    const target = scroll.mock.contexts.at(-1) as HTMLElement;
    expect(target.getAttribute("data-notebook-cell-id")).toBe(getNotebookState().doc.cells[1].id);
  });

  it("全実行中の進捗 n / m はスクロール領域の外 (ヘッダ側) にあり、完了すると消える (#2449)", async () => {
    seed(newSqlCell("SELECT 1"), newSqlCell("SELECT 2"));
    stubScrollIntoView();
    let release: (v: unknown) => void = () => {};
    const onRunSql = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    const progress = await screen.findByTestId("notebook-run-progress");
    expect(screen.getByTestId("notebook-scroll-host").contains(progress)).toBe(false);
    await act(async () => release(OUT));
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(2));
    await act(async () => release(OUT));
    await waitFor(() => expect(screen.queryByTestId("notebook-run-progress")).toBeNull());
    expect(screen.queryByTestId("notebook-run-stopped")).toBeNull();
  });

  it("中止で止まったら、中止の文言と停止位置が出る (#2449)", async () => {
    seed(newSqlCell("SELECT 1"), newSqlCell("SELECT 2"));
    stubScrollIntoView();
    const onRunSql = vi
      .fn()
      .mockResolvedValueOnce(OUT)
      .mockRejectedValueOnce(new NotebookRunError("cancelled", false, false, true));
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
    });
    const outcome = await screen.findByTestId("notebook-run-stopped");
    expect(outcome.textContent).toContain(t("notebookStoppedCancelled", { index: 2, total: 2, done: 1 }));
  });

  it("単独セルの実行では、進捗も停止表示も出さない (#2449)", async () => {
    seed(newSqlCell("SELECT bad"));
    stubScrollIntoView();
    const onRunSql = vi.fn().mockRejectedValue(new NotebookRunError("syntax error", false, false, false));
    setup({ onRunSql });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("notebookRunCell") }));
    });
    await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
    await screen.findByText(t("notebookError", { error: "syntax error" }));
    expect(screen.queryByTestId("notebook-run-progress")).toBeNull();
    expect(screen.queryByTestId("notebook-run-stopped")).toBeNull();
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
  describe("セル単位の接続 (#2396)", () => {
    const cur = makeProfile({ id: "cur", name: "検証", driver: "postgres" });
    const prod = makeProfile({ id: "prod", name: "本番DB", driver: "mysql", is_production: true });
    const lite = makeProfile({ id: "lite", name: "ローカル", driver: "sqlite" });
    const open = (p: typeof prod, sessionId: string) => ({ sessionId, profile: p });

    it("接続を選ぶとセルに保存され、プロファイル ID と表示名だけが入る", async () => {
      seed(newSqlCell("SELECT 1"));
      setup({ profile: cur, profiles: [cur, prod, lite], openConnections: [open(cur, "s1")] });
      await act(async () => {
        fireEvent.click(screen.getByRole("combobox", { name: t("notebookCellConn") }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("option", { name: "本番DB" }));
      });
      const cell = getNotebookState().doc.cells[0];
      expect(cell).toMatchObject({ connection: { profileId: "prod", name: "本番DB" } });
      expect(Object.keys((cell as { connection: object }).connection).sort()).toEqual(["name", "profileId"]);
    });

    it("別の接続のセルは確認 (本番は警告つき) を通してから、その接続を指定して実行する", async () => {
      const c = newSqlCell("SELECT 1");
      c.connection = { profileId: "prod", name: "本番DB" };
      seed(c);
      const { onRunSql } = setup({
        profile: cur,
        profiles: [cur, prod],
        openConnections: [open(cur, "s1"), open(prod, "s2")],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: t("notebookCellConnConfirm") }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
      expect(onRunSql.mock.calls[0][1]).toMatchObject({
        connection: { profileId: "prod", sessionId: "s2", name: "本番DB" },
        database: null,
      });
      // 既定の接続の付け替え確認は出さない (既定で動くセルが無い)
      expect(screen.queryByRole("button", { name: t("notebookRebindConfirm") })).toBeNull();
    });

    it("別接続の確認を取りやめたら実行しない", async () => {
      const c = newSqlCell("DELETE FROM t");
      c.connection = { profileId: "prod", name: "本番DB" };
      seed(c);
      const { onRunSql } = setup({
        profile: cur,
        profiles: [cur, prod],
        openConnections: [open(cur, "s1"), open(prod, "s2")],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await screen.findByRole("button", { name: t("notebookCellConnConfirm") });
      const cancels = screen.getAllByRole("button", { name: t("confirmDefaultCancel") });
      await act(async () => {
        fireEvent.click(cancels[cancels.length - 1]);
      });
      expect(onRunSql).not.toHaveBeenCalled();
    });

    it("未指定のセルは現在の接続を明示して実行する (省略しない)", async () => {
      seed(newSqlCell("SELECT 1"));
      const { onRunSql } = setup({ profile: cur, profiles: [cur, prod], openConnections: [open(cur, "s1")] });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
      expect(onRunSql.mock.calls[0][1]).toMatchObject({
        connection: { profileId: "cur", sessionId: "s1" },
      });
    });

    it("開いていない接続のセルは実行できない (理由を示し、すべて実行は 1 つも流さない)", async () => {
      const a = newSqlCell("SELECT 1");
      const b = newSqlCell("SELECT 2");
      b.connection = { profileId: "lite", name: "ローカル" };
      seed(a, b);
      const { onRunSql } = setup({ profile: cur, profiles: [cur, lite], openConnections: [open(cur, "s1")] });
      expect(screen.getByTestId("notebook-cell-conn-note").textContent).toContain(
        t("notebookCellConnNotOpen", { name: "ローカル" }),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      expect(onRunSql).not.toHaveBeenCalled();
    });

    it("保存されたプロファイルが無いセルは、見つからない旨を表示して実行しない", () => {
      const c = newSqlCell("SELECT 1");
      c.connection = { profileId: "gone", name: "消えた接続" };
      seed(c);
      const { onRunSql } = setup({ profile: cur, profiles: [cur], openConnections: [open(cur, "s1")] });
      expect(screen.getByTestId("notebook-cell-conn-note").textContent).toContain(
        t("notebookCellConnMissing", { name: "消えた接続" }),
      );
      const run = screen.getAllByRole("button", { name: t("notebookRunCell") })[0] as HTMLButtonElement;
      expect(run.disabled).toBe(true);
      expect(onRunSql).not.toHaveBeenCalled();
    });

    it("現在の接続が無くても、開いている別接続のセルは実行できる", async () => {
      const c = newSqlCell("SELECT 1");
      c.connection = { profileId: "lite", name: "ローカル" };
      seed(c);
      const { onRunSql } = setup({
        sessionId: null,
        profile: null,
        profiles: [lite],
        openConnections: [open(lite, "s3")],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: t("notebookCellConnConfirm") }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
    });

    it("実行中にアクティブ接続が切り替わっても、確認済みの接続 + セッションで流す (すべて実行)", async () => {
      const a = newSqlCell("SELECT 1");
      a.connection = { profileId: "prod", name: "本番DB" };
      const b = newSqlCell("SELECT 2");
      seed(a, b);
      let release: (v: unknown) => void = () => {};
      const first = new Promise((r) => {
        release = r;
      });
      const onRunSql = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(OUT);
      const view = setup({
        onRunSql,
        profile: cur,
        profiles: [cur, prod],
        openConnections: [open(cur, "s1"), open(prod, "s2")],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: t("notebookCellConnConfirm") }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
      // 実行中は接続を変えられない
      for (const sel of screen.getAllByRole("combobox", { name: t("notebookCellConn"), hidden: true })) {
        expect((sel as HTMLButtonElement).disabled).toBe(true);
      }
      // アクティブ接続を B (本番) へ切り替える
      view.rerender({ profile: prod, sessionId: "s2" });
      await act(async () => {
        release(OUT);
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(2));
      expect(onRunSql.mock.calls[0][1].connection).toMatchObject({ profileId: "prod", sessionId: "s2" });
      // 既定のセルは開始時点の現在の接続 (A) に固定される
      expect(onRunSql.mock.calls[1][1].connection).toMatchObject({ profileId: "cur", sessionId: "s1" });
    });

    it("確認のあとにセルの接続が変えられたら、確認なしでは流さず止める", async () => {
      const a = newSqlCell("SELECT 1");
      const b = newSqlCell("SELECT 2");
      seed(a, b);
      let release: (v: unknown) => void = () => {};
      const first = new Promise((r) => {
        release = r;
      });
      const onRunSql = vi
        .fn()
        .mockImplementationOnce(() => first)
        .mockResolvedValue(OUT);
      setup({
        onRunSql,
        profile: cur,
        profiles: [cur, prod],
        openConnections: [open(cur, "s1"), open(prod, "s2")],
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await waitFor(() => expect(onRunSql).toHaveBeenCalledTimes(1));
      // UI を迂回してストアを直接書き換えても、ループが検知して止める
      await act(async () => {
        updateNotebook((d) => ({
          ...d,
          cells: d.cells.map((c) =>
            c.id === b.id && c.kind === "sql"
              ? { ...c, connection: { profileId: "prod", name: "本番DB" } }
              : c,
          ),
        }));
        release(OUT);
      });
      await screen.findByText(t("notebookCellConnChanged"));
      expect(onRunSql).toHaveBeenCalledTimes(1);
    });

    it("「エディタで開く」: 別の接続を指すセルは無効 (黙って現在の接続へ移さない)、現在の接続のセルは開ける", () => {
      const a = newSqlCell("SELECT 1");
      a.connection = { profileId: "prod", name: "本番DB" };
      const b = newSqlCell("SELECT 2");
      seed(a, b);
      const { props } = setup({
        profile: cur,
        profiles: [cur, prod],
        openConnections: [open(cur, "s1"), open(prod, "s2")],
      });
      const [btnOther, btnCurrent] = screen.getAllByRole("button", {
        name: t("notebookOpenInEditor"),
      }) as HTMLButtonElement[];
      expect(btnOther.disabled).toBe(true);
      expect(btnCurrent.disabled).toBe(false);
      fireEvent.click(btnOther);
      expect(props.onOpenInEditor).not.toHaveBeenCalled();
      fireEvent.click(btnCurrent);
      expect(props.onOpenInEditor).toHaveBeenCalledWith("SELECT 2", expect.any(String), null);
    });

    it("エラーメッセージに引用された資格情報リテラルは、スナップショットに残す前に伏せる", async () => {
      seed(newSqlCell("CREATE USER bob IDENTIFIED BY 'hunter2secret'"));
      const onRunSql = vi
        .fn()
        .mockRejectedValue(
          new NotebookRunError("syntax error near 'hunter2secret' at line 1", false, false, false),
        );
      setup({ onRunSql, profile: makeProfile({ driver: "mysql" }) });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(t("notebookRunAll")) }));
      });
      await waitFor(() => {
        const cell = getNotebookState().doc.cells[0];
        expect(cell.kind === "sql" && cell.snapshot?.error).toBe("syntax error near '********' at line 1");
      });
    });
  });
});
