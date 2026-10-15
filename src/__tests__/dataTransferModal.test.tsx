import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { makeProfile } from "./fixtures/componentFixtures";
import { t } from "../i18n";
import type { TransferDoneEvent, TransferStreamHandlers } from "../api/tauri";

/**
 * 接続間データ転送の範囲指定・列指定 (#1623)。転送本体はバックエンドが担うので IPC は
 * モックし、「プレビューが返した列を編集できる」「指定が transfer_data のリクエストへ載る」
 * 「件数照合の食い違いを完了時に知らせる」を固定する。
 */
const handlers: { current: TransferStreamHandlers | null } = { current: null };
const notify = vi.fn();

vi.mock("../components/Toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/Toast")>();
  return {
    ...actual,
    useToast: () => ({
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warning: vi.fn(),
      notify,
      dismiss: vi.fn(),
    }),
  };
});

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    listenTransferStream: vi.fn(async (_id: string, h: TransferStreamHandlers) => {
      handlers.current = h;
      return () => {};
    }),
    api: {
      ...actual.api,
      connect: vi.fn().mockResolvedValue({ session_id: "target-session" }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      listDatabases: vi.fn().mockResolvedValue(["app"]),
      listTables: vi.fn().mockResolvedValue([]),
      previewTransfer: vi.fn().mockResolvedValue({
        columns: [],
        sourceColumns: [
          { name: "id", sourceType: "INT", targetType: "BIGINT" },
          { name: "secret", sourceType: "TEXT", targetType: "LONGTEXT" },
          { name: "flag", sourceType: "BIT(1)", targetType: "BOOLEAN" },
        ],
        lossy: [],
      }),
      transferData: vi.fn().mockResolvedValue(undefined),
      cancelStream: vi.fn().mockResolvedValue({ cancelled: true, deliveredRows: 0 }),
    },
  };
});

import { api } from "../api/tauri";
import { DataTransferModal } from "../components/DataTransferModal";

const profiles = [makeProfile({ id: "p2", name: "staging", driver: "mysql", read_only: false })];

async function setup() {
  const user = userEvent.setup();
  renderWithProviders(
    <DataTransferModal
      sourceSessionId="src"
      sourceProfileId="p1"
      source={{ kind: "table", database: "shop", table: "users" }}
      profiles={profiles}
      onClose={() => {}}
    />,
  );
  await user.selectOptions(screen.getByLabelText(t("transferTargetProfile")), "p2");
  await screen.findAllByTestId("transfer-column-row");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.current = null;
});

describe("DataTransferModal の列・範囲指定 (#1623)", () => {
  it("プレビューの全列を並べ、既定では列指定なしで転送する", async () => {
    const user = await setup();
    expect(screen.getAllByTestId("transfer-column-row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: t("transferExecute") }));
    await waitFor(() => expect(api.transferData).toHaveBeenCalled());
    const req = vi.mocked(api.transferData).mock.calls[0][1];
    expect(req.columns).toEqual([]);
    expect(req.whereClause).toBeNull();
    expect(req.limitRows).toBeNull();
  });

  it("除外・改名・型上書き・WHERE・試験転送がリクエストに載る", async () => {
    const user = await setup();
    await user.click(screen.getByRole("checkbox", { name: t("transferColumnInclude", { column: "secret" }) }));
    await user.type(screen.getByLabelText(t("transferColumnRename", { column: "flag" })), "is_on");
    await user.selectOptions(screen.getByLabelText(t("transferColumnType", { column: "flag" })), "integer");
    await user.type(screen.getByLabelText(t("transferWhereLabel")), "id > 10");
    await user.click(screen.getByRole("checkbox", { name: t("transferTrialLabel") }));
    await user.clear(screen.getByLabelText(t("transferTrialRows")));
    await user.type(screen.getByLabelText(t("transferTrialRows")), "25");

    await user.click(screen.getByRole("button", { name: t("transferExecute") }));
    await waitFor(() => expect(api.transferData).toHaveBeenCalled());
    const req = vi.mocked(api.transferData).mock.calls[0][1];
    expect(req.columns).toEqual([
      { source: "secret", exclude: true },
      { source: "flag", name: "is_on", type: { kind: "integer" } },
    ]);
    expect(req.whereClause).toBe("id > 10");
    expect(req.limitRows).toBe(25);
  });

  it("試験転送の行数が不正なら実行できない", async () => {
    const user = await setup();
    await user.click(screen.getByRole("checkbox", { name: t("transferTrialLabel") }));
    await user.clear(screen.getByLabelText(t("transferTrialRows")));
    await user.type(screen.getByLabelText(t("transferTrialRows")), "0");
    expect(screen.getByText(t("transferTrialInvalid"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("transferExecute") })).toBeDisabled();
  });

  it("件数照合の食い違いは完了時に警告で知らせる", async () => {
    const user = await setup();
    await user.click(screen.getByRole("button", { name: t("transferExecute") }));
    await waitFor(() => expect(handlers.current).not.toBeNull());
    const done: TransferDoneEvent = {
      streamId: "s",
      rows: 3,
      elapsedMs: 5,
      warnings: ["row count mismatch"],
      integrityWarnings: ["row count mismatch"],
    };
    handlers.current?.onDone?.(done);
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: t("transferIntegrityWarning", { detail: "row count mismatch" }),
          severity: "warning",
        }),
      ),
    );
  });
});
