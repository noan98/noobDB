import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext } from "../api/tauri";
import type { DdlRunOptions, DdlRunReport } from "../components/onlineDdlRunner";

/** AlterTableModal に組み込んだ段階トラック (#2263): 計画 → 進捗 → 失敗通知。 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
      {
        name: "age",
        data_type: "int",
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
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn().mockResolvedValue(ctx),
      tableRowEstimate: vi.fn(async () => 5_000_000),
      runLookupQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    },
  };
});

import { AlterTableModal } from "../components/AlterTableModal";

describe("AlterTableModal の段階トラック (#2263)", () => {
  it("段階実行の計画を出し、失敗すると通知内のトラックで失敗した段階を示す", async () => {
    const onRun = vi.fn(async (_s: unknown, options?: DdlRunOptions): Promise<DdlRunReport | undefined> => {
      if (!options) return undefined;
      options.onProgress?.(0, options.plan.steps.length);
      options.onProgress?.(1, options.plan.steps.length);
      return {
        ok: false,
        totalSteps: options.plan.steps.length,
        completedSteps: 1,
        failedStep: options.plan.steps[1],
        failedIndex: 1,
        error: "boom",
        lockTimeout: false,
        invalidIndexLeft: null,
        remainingSql: "",
        cleanupSql: "",
      };
    });
    renderWithProviders(
      <AlterTableModal
        sessionId="s1"
        driver="postgres"
        database="db"
        table="t"
        readOnly={false}
        onRun={onRun}
        onSendToEditor={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.click(
      await screen.findByLabelText(t("alterTableNotNullAria", { column: "age" }), {}, { timeout: 4000 }),
    );
    fireEvent.click(await screen.findByLabelText(t("onlineStagedToggle")));

    // 実行前: 計画としてトラックが出る (3 段階すべて未実行)。
    const plan = await screen.findByTestId("ddl-stage-track");
    expect(plan).toHaveAttribute("data-state", "plan");
    expect(
      within(plan)
        .getAllByTestId("ddl-stage")
        .map((e) => e.getAttribute("data-status")),
    ).toEqual(["pending", "pending", "pending"]);

    fireEvent.click(screen.getByRole("button", { name: t("alterTableRun") }));

    // 失敗後: ErrorNote の外にトラックが出て、2 段階目が失敗、3 段階目は未実行のまま。
    const report = await screen.findByTestId("ddl-run-report");
    await waitFor(() =>
      expect(screen.getByTestId("ddl-stage-track")).toHaveAttribute("data-state", "failed"),
    );
    const track = screen.getByTestId("ddl-stage-track");
    expect(report.contains(track)).toBe(false);
    expect(
      within(track)
        .getAllByTestId("ddl-stage")
        .map((e) => e.getAttribute("data-status")),
    ).toEqual(["done", "failed", "pending"]);
    expect(within(track).getByTestId("ddl-stage-applied")).toBeInTheDocument();
  });
});
