import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * スキーマ健全性アドバイザ (#741) の失敗表示統一 (#848)。診断失敗時、裸の赤
 * テキストではなく共有 `EmptyState` (タイトル + 再試行ボタン) で表示され、
 * ボタンで `api.analyzeSchemaHealth` が再度呼ばれることを固定する。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      analyzeSchemaHealth: vi.fn(),
    },
  };
});

import { AdvisorPanel } from "../components/AdvisorPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdvisorPanel error state (#848)", () => {
  it("shows the shared EmptyState title on diagnosis failure, and retries on click", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockRejectedValueOnce(new Error("access denied"));

    renderWithProviders(
      <AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />,
    );

    fireEvent.click(screen.getByText(t("advisorRun")));

    await waitFor(() => {
      expect(
        screen.getByText(t("advisorError", { error: "Error: access denied" })),
      ).toBeInTheDocument();
    });
    expect(api.analyzeSchemaHealth).toHaveBeenCalledTimes(1);

    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 1,
      findings: [],
      skipped: [],
    });
    fireEvent.click(screen.getByRole("button", { name: t("advisorRetry") }));

    await waitFor(() => {
      expect(api.analyzeSchemaHealth).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(
        screen.queryByText(t("advisorError", { error: "Error: access denied" })),
      ).not.toBeInTheDocument();
    });
  });
});

describe("AdvisorPanel running skeleton (#1211)", () => {
  it("実行中は findings 表のスケルトンを出し、完了で実データに差し替える", async () => {
    let resolve: (r: Awaited<ReturnType<typeof api.analyzeSchemaHealth>>) => void = () => {};
    vi.mocked(api.analyzeSchemaHealth).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const { container } = renderWithProviders(
      <AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />,
    );
    fireEvent.click(screen.getByText(t("advisorRun")));

    await waitFor(() => {
      const rows = container.querySelectorAll("tbody > tr");
      expect(rows.length).toBeGreaterThan(0);
      rows.forEach((row) => expect(row.getAttribute("aria-hidden")).toBe("true"));
    });
    // シマーは aria-hidden なので、実行中であることは文言 + Spinner (status) で告知する。
    expect(screen.getByText(t("advisorRunning"))).toBeInTheDocument();

    resolve({
      driver: "mysql",
      tables_analyzed: 1,
      findings: [
        {
          rule: "missing_primary_key",
          severity: "medium",
          table: "orders",
          columns: [],
          context: [],
          statistical: false,
          fix_ddl: null,
        },
      ],
      skipped: [],
    });
    await waitFor(() => {
      expect(screen.queryByText(t("advisorRunning"))).not.toBeInTheDocument();
    });
    const rows = container.querySelectorAll("tbody > tr");
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute("aria-hidden")).toBeNull();
  });
});
