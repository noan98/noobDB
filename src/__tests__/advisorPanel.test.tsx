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
      table_plans: [],
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
          fix_ddl_online: null,
        },
      ],
      skipped: [],
      table_plans: [],
    });
    await waitFor(() => {
      expect(screen.queryByText(t("advisorRunning"))).not.toBeInTheDocument();
    });
    const rows = container.querySelectorAll("tbody > tr");
    expect(rows.length).toBe(1);
    expect(rows[0].getAttribute("aria-hidden")).toBeNull();
  });
});

describe("AdvisorPanel 既定の並び (#1469)", () => {
  const mk = (table: string, severity: "high" | "medium" | "low") => ({
    rule: "missing_primary_key" as const,
    severity,
    table,
    columns: [],
    context: [],
    statistical: false,
    fix_ddl: null,
    fix_ddl_online: null,
  });

  it("初期表示で重要度の高い指摘が上に並び、同重要度はバックエンドの順を保つ", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 4,
      findings: [mk("t_low", "low"), mk("t_med1", "medium"), mk("t_high", "high"), mk("t_med2", "medium")],
      skipped: [],
      table_plans: [],
    });
    const { container } = renderWithProviders(
      <AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />,
    );
    fireEvent.click(screen.getByText(t("advisorRun")));
    await waitFor(() => expect(container.querySelectorAll("tbody > tr").length).toBe(4));
    const text = Array.from(container.querySelectorAll("tbody > tr")).map((r) => r.textContent ?? "");
    const order = ["t_high", "t_med1", "t_med2", "t_low"].map((n) => text.findIndex((x) => x.includes(n)));
    expect(order).toEqual([0, 1, 2, 3]);
    // 既定の重要度順はヘッダの aria-sort にも昇順として出る。
    expect(container.querySelector('th[aria-sort="ascending"]')).not.toBeNull();
  });
});

describe("AdvisorPanel オンライン版の修正 DDL (#1534)", () => {
  const finding = (online: string | null) => ({
    rule: "fk_missing_index" as const,
    severity: "high" as const,
    table: "orders",
    columns: ["user_id"],
    context: ["users"],
    statistical: false,
    fix_ddl: 'CREATE INDEX "idx_orders_user_id" ON "orders" ("user_id");',
    fix_ddl_online: online,
  });

  it("オンライン版があれば通常版と並べ、PostgreSQL ではトランザクション外で実行する旨を添える", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "postgres",
      tables_analyzed: 1,
      findings: [finding('CREATE INDEX CONCURRENTLY "idx_orders_user_id" ON "orders" ("user_id");')],
      skipped: [],
      table_plans: [],
    });
    const onInsertSql = vi.fn();
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={onInsertSql} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    await waitFor(() => expect(screen.getByText(t("advisorFixOnline"))).toBeInTheDocument());
    expect(screen.getByText(t("advisorFixStandard"))).toBeInTheDocument();
    expect(screen.getByText(t("advisorFixOnlineNotePostgres"))).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: new RegExp(t("advisorInsertFix")) })).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", {
        name: `${t("advisorInsertFix")} (${t("advisorFixOnline")})`,
      }),
    );
    expect(onInsertSql).toHaveBeenCalledWith(
      'CREATE INDEX CONCURRENTLY "idx_orders_user_id" ON "orders" ("user_id");',
    );
  });

  it("オンライン版が無い (SQLite) ときは従来どおり通常版だけを出す", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "sqlite",
      tables_analyzed: 1,
      findings: [finding(null)],
      skipped: [],
      table_plans: [],
    });
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("advisorInsertFix") })).toBeInTheDocument(),
    );
    expect(screen.queryByText(t("advisorFixOnline"))).toBeNull();
    expect(screen.queryByText(t("advisorFixStandard"))).toBeNull();
  });
});

describe("AdvisorPanel テーブル別のまとめ DDL (#1540)", () => {
  const plan = {
    table: "orders",
    change_count: 2,
    ddl: "ALTER TABLE `orders`\n  DROP INDEX `a_dup`,\n  ADD INDEX `idx_orders_user_id` (`user_id`);",
    ddl_online:
      "ALTER TABLE `orders`\n  DROP INDEX `a_dup`,\n  ADD INDEX `idx_orders_user_id` (`user_id`),\n  ALGORITHM=INPLACE, LOCK=NONE;",
  };
  const finding = {
    rule: "fk_missing_index" as const,
    severity: "high" as const,
    table: "orders",
    columns: ["user_id"],
    context: ["users"],
    statistical: false,
    fix_ddl: "CREATE INDEX `idx_orders_user_id` ON `orders` (`user_id`);",
    fix_ddl_online: null,
  };

  it("計画がなければセクションを出さない", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 1,
      findings: [finding],
      skipped: [],
      table_plans: [],
    });
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));
    await waitFor(() => expect(screen.getByRole("button", { name: t("advisorInsertFix") })).toBeInTheDocument());
    expect(screen.queryByTestId("advisor-table-plans")).toBeNull();
  });

  it("計画を標準版 / オンライン版で並べ、挿入できる。全テーブル分の一括挿入はテーブル名のコメント付き", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 2,
      findings: [finding],
      skipped: [],
      table_plans: [plan, { ...plan, table: "items", ddl: "ALTER TABLE `items`\n  DROP INDEX `x`;", ddl_online: null }],
    });
    const onInsertSql = vi.fn();
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={onInsertSql} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    const section = await screen.findByTestId("advisor-table-plans");
    expect(section).toHaveTextContent(t("advisorPlansTitle"));
    expect(section).toHaveTextContent(t("advisorPlanChanges", { count: "2" }));

    fireEvent.click(screen.getByRole("button", { name: new RegExp(t("advisorPlansInsertAll")) }));
    expect(onInsertSql).toHaveBeenLastCalledWith(
      `-- orders\n${plan.ddl}\n\n-- items\nALTER TABLE \`items\`\n  DROP INDEX \`x\`;`,
    );
  });
});
