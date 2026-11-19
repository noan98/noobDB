import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const blockedMock = vi.fn();
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, transactionBlockedSessions: (...a: unknown[]) => blockedMock(...a) },
  };
});

import { TransactionStatus } from "../components/TransactionStatus";
import { makeTxEntry, type TxMeta } from "../txJournal";

const NOW = Date.now();
const meta = (ageMs: number, driver = "mysql"): TxMeta => ({
  startedAt: NOW - ageMs,
  entries: [
    makeTxEntry(
      "UPDATE t SET a = 1",
      driver,
      { ok: true, returnedRows: 0, affectedRows: 3, elapsedMs: 4 },
      NOW,
    ),
    makeTxEntry("SELECT * FROM t", driver, { ok: true, returnedRows: 9, affectedRows: 0, elapsedMs: 4 }, NOW),
  ],
});

describe("TransactionStatus (#2447)", () => {
  beforeEach(() => {
    blockedMock.mockReset();
    blockedMock.mockResolvedValue(0);
  });

  it("経過時間付きの TX バッジと変更の要約を出す", () => {
    renderWithProviders(
      <TransactionStatus sessionId="s1" driver="mysql" isProduction={false} meta={meta(334_000)} />,
    );
    expect(screen.getByTestId("tx-badge").textContent).toContain("5:");
    expect(screen.getByTestId("tx-badge").getAttribute("data-stale")).toBe("false");
    expect(screen.getByTestId("tx-changes-button").textContent).toBe(
      t("txChangesSummary", { statements: 1, rows: 3 }),
    );
  });

  it("本番は短いしきい値で放置警告になる", () => {
    renderWithProviders(
      <TransactionStatus sessionId="s1" driver="mysql" isProduction meta={meta(4 * 60_000)} />,
    );
    expect(screen.getByTestId("tx-badge").getAttribute("data-stale")).toBe("true");
  });

  it("ボタンで実行した文の一覧ポップオーバーを開く", () => {
    renderWithProviders(
      <TransactionStatus sessionId="s1" driver="mysql" isProduction={false} meta={meta(1000)} />,
    );
    fireEvent.click(screen.getByTestId("tx-changes-button"));
    expect(screen.getByTestId("tx-changes-popover")).toBeInTheDocument();
    expect(screen.getAllByTestId("tx-journal-entry")).toHaveLength(2);
  });

  it("MySQL / PostgreSQL ではブロック数を取得して表示する", async () => {
    blockedMock.mockResolvedValue(2);
    renderWithProviders(
      <TransactionStatus
        sessionId="s1"
        driver="postgres"
        isProduction={false}
        meta={meta(1000, "postgres")}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("tx-blocking").textContent).toBe(t("txBlockingCount", { count: 2 })),
    );
    expect(blockedMock).toHaveBeenCalledWith("s1");
  });

  it("ブロック数を取得できない (null) ときは非表示でなく「不明」と出す", async () => {
    blockedMock.mockResolvedValue(null);
    renderWithProviders(
      <TransactionStatus sessionId="s1" driver="mysql" isProduction={false} meta={meta(1000)} />,
    );
    await waitFor(() => expect(screen.getByTestId("tx-blocking").textContent).toBe(t("txBlockingUnknown")));
  });

  it("SQLite は照会せず「対象外」と明示する", () => {
    renderWithProviders(
      <TransactionStatus sessionId="s1" driver="sqlite" isProduction={false} meta={meta(1000, "sqlite")} />,
    );
    expect(screen.getByTestId("tx-blocking").textContent).toBe(t("txBlockingUnsupported"));
    expect(blockedMock).not.toHaveBeenCalled();
  });
});
