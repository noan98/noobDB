import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "./testUtils";
import { t } from "../i18n";
import type { WriteCaptureSummary } from "../api/tauri";

/**
 * DML フライトレコーダの全消去アクション (#910)。`clear_flight_records` は
 * 既にバックエンド/`tauri.ts` ラッパーとも実装済みで、このパネルからの導線が
 * 欠けていた分を埋める。危険確認 (`useConfirm`, tone "danger") を経ること、
 * 確認後に一覧が空になること、記録が元々空のときは全消去アクション自体を
 * 出さないことを固定する。
 */

const ENTRY: WriteCaptureSummary = {
  id: 1,
  profile_id: "p-test",
  driver: "mysql",
  database: "appdb",
  table: "users",
  kind: "update",
  sql: "UPDATE users SET name = 'a' WHERE id = 1",
  rows_affected: 1,
  captured_at: "2026-01-01T00:00:00Z",
  undone: false,
};

const listFlightRecords = vi.fn();
const clearFlightRecords = vi.fn();
const previewUndo = vi.fn();
const previewRedo = vi.fn();
const undoFlightRecord = vi.fn();
const redoFlightRecord = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listFlightRecords: (...args: unknown[]) => listFlightRecords(...(args as [string | null])),
      clearFlightRecords: (...args: unknown[]) => clearFlightRecords(...(args as [string | null])),
      previewUndo: (...args: unknown[]) => previewUndo(...args),
      previewRedo: (...args: unknown[]) => previewRedo(...args),
      undoFlightRecord: (...args: unknown[]) => undoFlightRecord(...args),
      redoFlightRecord: (...args: unknown[]) => redoFlightRecord(...args),
    },
  };
});

import { FlightRecorderPanel } from "../components/FlightRecorderPanel";

beforeEach(() => {
  vi.clearAllMocks();
  listFlightRecords.mockResolvedValue([ENTRY]);
  clearFlightRecords.mockResolvedValue(1);
});

describe("FlightRecorderPanel 全消去 (#910)", () => {
  it("危険確認を経て clearFlightRecords を呼び、一覧が空になる", async () => {
    const user = userEvent.setup();
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId={null} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("flightRecorderClearAction") })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: t("flightRecorderClearAction") }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirmDialog = within(dialogs[dialogs.length - 1]);
    await user.click(confirmDialog.getByRole("button", { name: t("flightRecorderClearAction") }));

    await waitFor(() => expect(clearFlightRecords).toHaveBeenCalledWith("p-test"));
    await waitFor(() => expect(screen.getByText(t("flightRecorderEmptyTitle"))).toBeInTheDocument());
  });

  it("記録が空のときは全消去アクションを表示しない", async () => {
    listFlightRecords.mockResolvedValue([]);
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId={null} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText(t("flightRecorderEmptyTitle"))).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: t("flightRecorderClearAction") })).not.toBeInTheDocument();
  });
});

/**
 * 取り消し済みの記録の「やり直し (Redo)」ボタン (#1536)。Undo と同じ「プレビュー → 確認 → 適用」の
 * 流れで、呼ぶ IPC だけが違うことを固定する。
 */
describe("FlightRecorderPanel Undo / Redo (#1536)", () => {
  const PREVIEW = { statements: ["UPDATE users SET name = 'a' WHERE id = 1"], conflicts: [] };
  const OUTCOME = { applied: true, rowsAffected: 1, conflicts: [] };

  async function clickAndConfirm(user: ReturnType<typeof userEvent.setup>, buttonName: string) {
    await user.click(await screen.findByRole("button", { name: buttonName }));
    const dialogs = await screen.findAllByRole("dialog");
    const dialog = within(dialogs[dialogs.length - 1]);
    await user.click(dialog.getByRole("button", { name: t("flightRecorderApply") }));
  }

  it("取り消し済みの行は「やり直し」になり、previewRedo → redoFlightRecord を呼ぶ (Undo 系は呼ばない)", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([{ ...ENTRY, undone: true }]);
    previewRedo.mockResolvedValue(PREVIEW);
    redoFlightRecord.mockResolvedValue(OUTCOME);
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: t("flightRecorderUndoAction") })).not.toBeInTheDocument();
    await clickAndConfirm(user, t("flightRecorderRedoAction"));

    await waitFor(() => expect(redoFlightRecord).toHaveBeenCalledWith("s1", 1, false));
    expect(previewRedo).toHaveBeenCalledWith("s1", 1);
    expect(previewUndo).not.toHaveBeenCalled();
    expect(undoFlightRecord).not.toHaveBeenCalled();
  });

  it("未取り消しの行は「巻き戻し」のままで、previewUndo → undoFlightRecord を呼ぶ", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([ENTRY]);
    previewUndo.mockResolvedValue(PREVIEW);
    undoFlightRecord.mockResolvedValue(OUTCOME);
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    expect(screen.queryByRole("button", { name: t("flightRecorderRedoAction") })).not.toBeInTheDocument();
    await clickAndConfirm(user, t("flightRecorderUndoAction"));

    await waitFor(() => expect(undoFlightRecord).toHaveBeenCalledWith("s1", 1, false));
    expect(redoFlightRecord).not.toHaveBeenCalled();
  });

  it("やり直しで衝突があれば force で適用する", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([{ ...ENTRY, undone: true }]);
    previewRedo.mockResolvedValue({
      statements: PREVIEW.statements,
      conflicts: [{ key: ["1"], expected: [], current: null }],
    });
    redoFlightRecord.mockResolvedValue(OUTCOME);
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: t("flightRecorderRedoAction") }));
    const dialogs = await screen.findAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]).getByRole("button", { name: t("flightRecorderForceApply") }),
    );
    await waitFor(() => expect(redoFlightRecord).toHaveBeenCalledWith("s1", 1, true));
  });
});

/**
 * #1600: 目的の状態が既に成立している取り消しは適用 API を呼んで記録を取り消し済みにし、
 * 強制適用は確認後に増えた競合があれば中止する。
 */
describe("FlightRecorderPanel 取り消しの整合 (#1600)", () => {
  it("文も競合も無い (既に成立) ときは undoFlightRecord を呼んで記録を取り消し済みにする", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([ENTRY]);
    previewUndo.mockResolvedValue({ statements: [], conflicts: [], warnings: [] });
    undoFlightRecord.mockResolvedValue({ applied: true, rowsAffected: 0, conflicts: [], warnings: [] });
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: t("flightRecorderUndoAction") }));

    await waitFor(() => expect(undoFlightRecord).toHaveBeenCalledWith("s1", 1, false));
    // 確認ダイアログは出さない。
    expect(screen.queryByRole("button", { name: t("flightRecorderApply") })).not.toBeInTheDocument();
  });

  it("警告があるときは適用 API を呼ばない (主キー不明などで取り消し済みにしない)", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([ENTRY]);
    previewUndo.mockResolvedValue({
      statements: [],
      conflicts: [],
      warnings: ["主キー列を特定できませんでした"],
    });
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: t("flightRecorderUndoAction") }));
    await waitFor(() => expect(previewUndo).toHaveBeenCalled());
    expect(undoFlightRecord).not.toHaveBeenCalled();
  });

  it("確認後に表示されていない競合が増えたら強制適用せず中止する", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([ENTRY]);
    const conflictA = { key: [1], expected: [], current: null };
    const conflictB = { key: [2], expected: [], current: null };
    previewUndo
      .mockResolvedValueOnce({
        statements: ["UPDATE users SET name = 'a' WHERE id = 1"],
        conflicts: [conflictA],
        warnings: [],
      })
      .mockResolvedValueOnce({
        statements: ["UPDATE users SET name = 'a' WHERE id = 1"],
        conflicts: [conflictA, conflictB],
        warnings: [],
      });
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: t("flightRecorderUndoAction") }));
    const dialogs = await screen.findAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]).getByRole("button", { name: t("flightRecorderForceApply") }),
    );

    await waitFor(() => expect(previewUndo).toHaveBeenCalledTimes(2));
    expect(undoFlightRecord).not.toHaveBeenCalled();
  });
});

describe("FlightRecorderPanel 強制適用の再確認 (#1600)", () => {
  it("同じキーで current の値だけが変わった場合も強制適用せず中止する", async () => {
    const user = userEvent.setup();
    listFlightRecords.mockResolvedValue([ENTRY]);
    const stmts = ["UPDATE users SET name = 'a' WHERE id = 1"];
    previewUndo
      .mockResolvedValueOnce({
        statements: stmts,
        conflicts: [{ key: [1], expected: [1, "a"], current: [1, "b"] }],
        warnings: [],
      })
      .mockResolvedValueOnce({
        statements: stmts,
        conflicts: [{ key: [1], expected: [1, "a"], current: [1, "c"] }],
        warnings: [],
      });
    renderWithProviders(<FlightRecorderPanel profileId="p-test" sessionId="s1" onClose={() => {}} />);

    await user.click(await screen.findByRole("button", { name: t("flightRecorderUndoAction") }));
    const dialogs = await screen.findAllByRole("dialog");
    await user.click(
      within(dialogs[dialogs.length - 1]).getByRole("button", { name: t("flightRecorderForceApply") }),
    );

    await waitFor(() => expect(previewUndo).toHaveBeenCalledTimes(2));
    expect(undoFlightRecord).not.toHaveBeenCalled();
  });
});
