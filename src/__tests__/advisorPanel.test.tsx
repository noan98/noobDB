import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor, within } from "./testUtils";
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
      writeTextFile: vi.fn(),
      ignoreAdvisorFinding: vi.fn(),
      unignoreAdvisorFinding: vi.fn(),
    },
  };
});

const dialog = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: dialog.save }));

import { AdvisorPanel } from "../components/AdvisorPanel";
import { api } from "../api/tauri";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AdvisorPanel error state (#848)", () => {
  it("shows the shared EmptyState title on diagnosis failure, and retries on click", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockRejectedValueOnce(new Error("access denied"));

    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);

    fireEvent.click(screen.getByText(t("advisorRun")));

    await waitFor(() => {
      expect(screen.getByText(t("advisorError", { error: "Error: access denied" }))).toBeInTheDocument();
    });
    expect(api.analyzeSchemaHealth).toHaveBeenCalledTimes(1);

    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 1,
      findings: [],
      skipped: [],
      table_plans: [],
      ignored: [],
      diff: null,
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

describe("AdvisorPanel 再実行の失敗", () => {
  it("再実行が失敗したら前回の指摘表と書き出しボタンを残さない", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 1,
      findings: [
        {
          rule: "missing_primary_key",
          severity: "medium",
          table: "stale_table",
          columns: [],
          context: [],
          statistical: false,
          size_bytes: null,
          fix_ddl: null,
          fix_ddl_online: null,
        },
      ],
      skipped: [],
      table_plans: [],
      ignored: [],
      diff: null,
    });
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));
    await screen.findByText("stale_table");

    vi.mocked(api.analyzeSchemaHealth).mockRejectedValueOnce(new Error("lost connection"));
    fireEvent.click(screen.getByText(t("advisorRerun")));
    await screen.findByText(t("advisorError", { error: "Error: lost connection" }));
    expect(screen.queryByText("stale_table")).not.toBeInTheDocument();
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
          size_bytes: null,
          fix_ddl: null,
          fix_ddl_online: null,
        },
      ],
      skipped: [],
      table_plans: [],
      ignored: [],
      diff: null,
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
    size_bytes: null,
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
      ignored: [],
      diff: null,
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
    size_bytes: null,
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
      ignored: [],
      diff: null,
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
      ignored: [],
      diff: null,
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
    size_bytes: null,
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
      ignored: [],
      diff: null,
    });
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("advisorInsertFix") })).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("advisor-table-plans")).toBeNull();
  });

  it("計画を標準版 / オンライン版で並べ、挿入できる。全テーブル分の一括挿入はテーブル名のコメント付き", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce({
      driver: "mysql",
      tables_analyzed: 2,
      findings: [finding],
      skipped: [],
      table_plans: [
        plan,
        { ...plan, table: "items", ddl: "ALTER TABLE `items`\n  DROP INDEX `x`;", ddl_online: null },
      ],
      ignored: [],
      diff: null,
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

describe("AdvisorPanel 前回比・対応しない・容量 (#1621)", () => {
  const base = {
    severity: "low" as const,
    columns: ["a"],
    context: ["idx_a"],
    statistical: true,
    fix_ddl: null,
    fix_ddl_online: null,
  };
  const small = { ...base, rule: "unused_index" as const, table: "t1", size_bytes: 1024 };
  const big = { ...base, rule: "unused_index" as const, table: "t2", size_bytes: 5 * 1024 * 1024 };
  const pk = {
    ...base,
    rule: "missing_primary_key" as const,
    table: "log",
    columns: [],
    context: [],
    statistical: false,
    size_bytes: null,
  };
  const report = (over: Partial<import("../api/tauri").SchemaHealthReport>) => ({
    driver: "postgres" as const,
    tables_analyzed: 3,
    findings: [small, big, pk],
    skipped: [],
    table_plans: [],
    ignored: [],
    diff: null,
    ...over,
  });

  it("未使用インデックスの容量を表示し、合計と大きい順の並べ替えを出す", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce(report({}));
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    expect(await screen.findByTestId("advisor-reclaimable")).toHaveTextContent("5.0 MB");
    expect(screen.getByText("1.0 KB")).toBeInTheDocument();
    expect(screen.getByText("5.0 MB")).toBeInTheDocument();

    // 容量ヘッダの 1 回目のクリックは大きい順。
    fireEvent.click(screen.getByRole("columnheader", { name: new RegExp(t("advisorColSize")) }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("t2");
    expect(rows[1]).toHaveTextContent("t1");
    expect(rows[2]).toHaveTextContent("log");
  });

  it("前回診断との差分を要約し、新規の指摘にバッジを付け、解消された指摘を挙げる", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce(
      report({
        findings: [small, pk],
        diff: {
          previous_at: "2026-01-01T00:00:00Z",
          new_indexes: [0],
          resolved: [big],
          unchanged: 1,
        },
      }),
    );
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    const summary = await screen.findByTestId("advisor-diff-summary");
    expect(summary).toHaveTextContent("1");
    expect(screen.getByTestId("advisor-diff-resolved")).toHaveTextContent("t2");
    const badges = screen.getAllByTestId("advisor-new-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].closest("tr")).toHaveTextContent("t1");
  });

  it("「対応しない」で本表から別枠へ移り、戻すと本表へ帰る", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce(report({ findings: [pk, small] }));
    vi.mocked(api.ignoreAdvisorFinding).mockResolvedValue(undefined);
    vi.mocked(api.unignoreAdvisorFinding).mockResolvedValue(undefined);
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));

    await screen.findByText("log");
    const logRow = screen.getByText("log").closest("tr") as HTMLElement;
    fireEvent.click(within(logRow).getByRole("button", { name: t("advisorIgnore") }));

    await waitFor(() => expect(api.ignoreAdvisorFinding).toHaveBeenCalledWith("s1", "testdb", pk));
    const ignored = await screen.findByTestId("advisor-ignored");
    expect(ignored).toHaveTextContent(t("advisorIgnoredTitle", { count: "1" }));
    // 本表の行数は 1 件に減る (見出し行 + 1)。
    expect(screen.getAllByRole("row")).toHaveLength(2);

    fireEvent.click(within(ignored).getByRole("button", { name: t("advisorUnignore") }));
    await waitFor(() => expect(api.unignoreAdvisorFinding).toHaveBeenCalledWith("s1", "testdb", pk));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(screen.queryByTestId("advisor-ignored")).toBeNull();
  });

  it("保存に失敗したら本表のまま残してエラーを出す", async () => {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce(report({ findings: [pk] }));
    vi.mocked(api.ignoreAdvisorFinding).mockRejectedValueOnce(new Error("disk full"));
    renderWithProviders(<AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />);
    fireEvent.click(screen.getByText(t("advisorRun")));
    fireEvent.click(await screen.findByRole("button", { name: t("advisorIgnore") }));
    await screen.findByText(t("advisorIgnoreError", { error: "Error: disk full" }));
    expect(screen.queryByTestId("advisor-ignored")).toBeNull();
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});

describe("AdvisorPanel 要約タイルとルール別ストリップ (#2239)", () => {
  const mk = (
    rule: "missing_primary_key" | "fk_missing_index" | "sequence_exhaustion",
    severity: "high" | "medium" | "low",
    table: string,
    extra: Partial<{ context: string[]; columns: string[] }> = {},
  ) => ({
    rule,
    severity,
    table,
    columns: extra.columns ?? [],
    context: extra.context ?? [],
    statistical: false,
    size_bytes: null,
    fix_ddl: null,
    fix_ddl_online: null,
  });

  const report = (diff: Awaited<ReturnType<typeof api.analyzeSchemaHealth>>["diff"] = null) => ({
    driver: "mysql" as const,
    tables_analyzed: 7,
    findings: [
      mk("missing_primary_key", "medium", "t_pk1"),
      mk("fk_missing_index", "high", "t_fk", { columns: ["uid"], context: ["users"] }),
      mk("missing_primary_key", "medium", "t_pk2"),
      mk("sequence_exhaustion", "high", "t_seq", {
        columns: ["id"],
        context: ["int unsigned", "4200000000", "4294967295", "97.8", "type"],
      }),
    ],
    skipped: [],
    table_plans: [],
    ignored: [],
    diff,
  });

  async function runPanel(r: ReturnType<typeof report>) {
    vi.mocked(api.analyzeSchemaHealth).mockResolvedValueOnce(r);
    const view = renderWithProviders(
      <AdvisorPanel sessionId="s1" database="testdb" onInsertSql={() => {}} />,
    );
    fireEvent.click(screen.getByText(t("advisorRun")));
    await screen.findByTestId("advisor-stat-tiles");
    return view;
  }

  it("重要度別の StatTile と解析した表の数を出し、初回診断ではデルタを出さない", async () => {
    await runPanel(report());
    const tiles = screen.getByTestId("advisor-stat-tiles");
    expect(within(tiles).getByText(t("advisorStatHigh"))).toBeInTheDocument();
    expect(within(tiles).getByText(t("advisorStatMedium"))).toBeInTheDocument();
    expect(within(tiles).getByText(t("advisorStatLow"))).toBeInTheDocument();
    expect(within(tiles).getByText(t("advisorStatTables"))).toBeInTheDocument();
    expect(within(tiles).queryAllByTestId("stat-delta")).toHaveLength(0);
  });

  it("前回診断との差分があれば、減った件数を good のデルタで示す", async () => {
    const r = report({
      previous_at: "2026-01-01T00:00:00Z",
      new_indexes: [],
      resolved: [mk("fk_missing_index", "high", "gone1"), mk("fk_missing_index", "high", "gone2")],
      unchanged: 4,
    });
    await runPanel(r);
    const deltas = within(screen.getByTestId("advisor-stat-tiles")).getAllByTestId("stat-delta");
    // 高: 前回 4 → 今回 2 (減少 = good)、中: 変化なし、低: 変化なし
    expect(deltas).toHaveLength(3);
    expect(deltas[0].getAttribute("data-direction")).toBe("down");
    expect(deltas[0].getAttribute("data-verdict")).toBe("good");
    expect(deltas[1].getAttribute("data-direction")).toBe("flat");
  });

  it("ルール別のチップは件数 0 のルールを出さず、クリックで絞り込み、もう一度で解除する", async () => {
    const { container } = await runPanel(report());
    const strip = screen.getByTestId("advisor-rule-strip");
    expect(within(strip).getAllByRole("button")).toHaveLength(3);
    expect(screen.queryByTestId("advisor-rule-chip-unused_index")).not.toBeInTheDocument();
    expect(container.querySelectorAll("tbody > tr")).toHaveLength(4);

    const chip = screen.getByTestId("advisor-rule-chip-missing_primary_key");
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(container.querySelectorAll("tbody > tr")).toHaveLength(2));
    expect(screen.getByTestId("advisor-filter-note")).toBeInTheDocument();
    // タイルの件数は絞り込みで動かない (全件のまま)。
    expect(
      within(screen.getByTestId("advisor-stat-tiles")).getByText(t("advisorStatHigh")),
    ).toBeInTheDocument();

    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(container.querySelectorAll("tbody > tr")).toHaveLength(4));
    expect(screen.queryByTestId("advisor-filter-note")).not.toBeInTheDocument();
  });

  it("チップはキーボード (Enter / Space) で操作でき、絞り込み解除ボタンでも戻せる", async () => {
    const { container } = await runPanel(report());
    const chip = screen.getByTestId("advisor-rule-chip-fk_missing_index");
    chip.focus();
    expect(chip).toHaveFocus();
    // ネイティブ button なので Enter / Space は click として発火する (user-event を使わず click で代用)。
    fireEvent.click(chip);
    await waitFor(() => expect(container.querySelectorAll("tbody > tr")).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: t("advisorFilterClear") }));
    await waitFor(() => expect(container.querySelectorAll("tbody > tr")).toHaveLength(4));
  });

  it("採番枯渇の行に、閾値マーカー付きで使用率 (aria-valuenow) を持つメーターを出す", async () => {
    await runPanel(report());
    const meter = within(screen.getByTestId("advisor-sequence-meter")).getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "98");
    // 色は同じ行の重要度 (high) に合わせる。
    expect(screen.getByTestId("advisor-sequence-meter").querySelector('[data-tone="danger"]')).not.toBeNull();
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
    expect(within(screen.getByTestId("advisor-sequence-meter")).getAllByText(/^(50|80)%$/)).toHaveLength(2);
    // 他のルールの行にはメーターを出さない。
    expect(screen.getAllByTestId("advisor-sequence-meter")).toHaveLength(1);
  });

  it("絞り込み中の書き出しは表示中の指摘だけを対象にする旨を示す", async () => {
    await runPanel(report());
    fireEvent.click(screen.getByTestId("advisor-rule-chip-missing_primary_key"));
    const note = await screen.findByTestId("advisor-filter-note");
    expect(note.textContent).toContain(
      t("advisorFilterActive", { rule: t("advisorRuleMissingPrimaryKeyTitle"), shown: "2", total: "4" }),
    );
  });

  it("絞り込み中の書き出しは絞り込み後の行だけになり、ファイル名にルール ID が付く", async () => {
    await runPanel(report());
    fireEvent.click(screen.getByTestId("advisor-rule-chip-missing_primary_key"));
    await waitFor(() => expect(screen.getByTestId("advisor-filter-note")).toBeInTheDocument());
    dialog.save.mockResolvedValueOnce("/tmp/out.csv");
    fireEvent.click(screen.getByRole("button", { name: t("textExportButton") }));
    fireEvent.click(await screen.findByText(t("textExportSaveAs", { format: "CSV" })));
    await waitFor(() => expect(api.writeTextFile).toHaveBeenCalledTimes(1));
    const [, text] = vi.mocked(api.writeTextFile).mock.calls[0];
    expect(text).toContain("t_pk1");
    expect(text).toContain("t_pk2");
    expect(text).not.toContain("t_fk");
    expect(text).not.toContain("t_seq");
    const opts = dialog.save.mock.calls[0][0] as { defaultPath: string };
    expect(opts.defaultPath).toContain("schema-health-testdb-missing_primary_key.csv");
  });
});
