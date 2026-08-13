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

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listFlightRecords: (...args: unknown[]) => listFlightRecords(...(args as [string | null])),
      clearFlightRecords: (...args: unknown[]) => clearFlightRecords(...(args as [string | null])),
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
    renderWithProviders(
      <FlightRecorderPanel profileId="p-test" sessionId={null} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("flightRecorderClearAction") })).toBeInTheDocument(),
    );

    await user.click(screen.getByRole("button", { name: t("flightRecorderClearAction") }));

    const dialogs = await screen.findAllByRole("dialog");
    const confirmDialog = within(dialogs[dialogs.length - 1]);
    await user.click(confirmDialog.getByRole("button", { name: t("flightRecorderClearAction") }));

    await waitFor(() => expect(clearFlightRecords).toHaveBeenCalledWith("p-test"));
    await waitFor(() =>
      expect(screen.getByText(t("flightRecorderEmptyTitle"))).toBeInTheDocument(),
    );
  });

  it("記録が空のときは全消去アクションを表示しない", async () => {
    listFlightRecords.mockResolvedValue([]);
    renderWithProviders(
      <FlightRecorderPanel profileId="p-test" sessionId={null} onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(screen.getByText(t("flightRecorderEmptyTitle"))).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: t("flightRecorderClearAction") }),
    ).not.toBeInTheDocument();
  });
});
