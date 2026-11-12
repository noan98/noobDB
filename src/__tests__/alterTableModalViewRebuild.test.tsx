import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext, ViewRebuildPlan } from "../api/tauri";

/** PostgreSQL の型変更で依存ビューを作り直す手順 (#2268)。 */
const planFn = vi.hoisted(() => vi.fn());

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  const ctx: AlterTableContext = {
    columns: [
      {
        name: "age",
        data_type: "integer",
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
      tableRowEstimate: vi.fn(async () => 10),
      runLookupQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
      viewRebuildPlan: (...a: unknown[]) => planFn(...a),
    },
  };
});

import { AlterTableModal } from "../components/AlterTableModal";

const withViews = (over: Partial<ViewRebuildPlan> = {}): ViewRebuildPlan => ({
  views: [
    { schema: "public", name: "v1", kind: "view", size_bytes: null, est_rows: null },
    { schema: "public", name: "mv2", kind: "materialized_view", size_bytes: 8192, est_rows: 100 },
  ],
  drop_statements: ['DROP MATERIALIZED VIEW "public"."mv2";', 'DROP VIEW "public"."v1";'],
  create_statements: [
    'CREATE VIEW "public"."v1" AS\nSELECT age FROM t;',
    'CREATE MATERIALIZED VIEW "public"."mv2" AS\nSELECT age FROM v1\nWITH NO DATA;',
  ],
  restore_statements: ['GRANT SELECT ON "public"."v1" TO "reader";'],
  blockers: [],
  referenced_columns: ["age"],
  ...over,
});

function renderModal(onRun = vi.fn()) {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver="postgres"
      database="public"
      table="t"
      readOnly={false}
      onRun={onRun}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
  return onRun;
}

async function changeType(value: string) {
  const input = await screen.findByLabelText(`${t("createTableColType")}: age`, {}, { timeout: 4000 });
  fireEvent.change(input, { target: { value } });
}

beforeEach(() => {
  planFn.mockReset();
});

describe("AlterTableModal 依存ビューの作り直し (#2268)", () => {
  it("依存が無ければ従来どおり (案内なし・SQL は ALTER のみ)", async () => {
    planFn.mockResolvedValue({
      views: [],
      drop_statements: [],
      create_statements: [],
      restore_statements: [],
      blockers: [],
      referenced_columns: [],
    });
    renderModal();
    await changeType("bigint");
    await waitFor(() => expect(planFn).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("sql-preview")).toHaveTextContent(/ALTER COLUMN/));
    expect(screen.queryByTestId("view-rebuild")).toBeNull();
    expect(screen.getByTestId("sql-preview")).not.toHaveTextContent(/DROP VIEW/);
  });

  it("型を変えない編集では問い合わせない", async () => {
    renderModal();
    await screen.findByLabelText(`${t("createTableColType")}: age`, {}, { timeout: 4000 });
    expect(planFn).not.toHaveBeenCalled();
  });

  it("選ぶと DROP → ALTER → CREATE → 復元がプレビューと実行に並ぶ", async () => {
    planFn.mockResolvedValue(withViews());
    renderModal();
    await changeType("bigint");
    expect(await screen.findByTestId("view-rebuild", undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(planFn).toHaveBeenCalledWith("s1", "public", "t", ["age"], true);
    // 既定では作り直さない。
    expect(screen.getByTestId("sql-preview")).not.toHaveTextContent(/DROP VIEW/);
    fireEvent.click(screen.getByLabelText(t("viewRebuildToggle", { count: 2 })));
    await waitFor(() => expect(screen.getByTestId("sql-preview")).toHaveTextContent(/DROP VIEW/));
    const sql = screen.getByTestId("sql-preview").textContent ?? "";
    expect(sql.indexOf("DROP MATERIALIZED VIEW")).toBeLessThan(sql.indexOf("DROP VIEW"));
    expect(sql.indexOf("DROP VIEW")).toBeLessThan(sql.indexOf("ALTER TABLE"));
    expect(sql.indexOf("ALTER TABLE")).toBeLessThan(sql.indexOf("CREATE VIEW"));
    expect(sql.indexOf("CREATE MATERIALIZED VIEW")).toBeLessThan(sql.indexOf("GRANT SELECT"));
    // マテビューの再計算警告と WITH NO DATA の選択。
    expect(screen.getByTestId("view-rebuild-matview-warning")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(t("viewRebuildNoData")));
    await waitFor(() => expect(planFn).toHaveBeenLastCalledWith("s1", "public", "t", ["age"], false));
  });

  it("RLS ポリシーなどの止める依存があると理由を出して適用できない", async () => {
    planFn.mockResolvedValue(
      withViews({ blockers: [{ kind: "policy", description: "policy p on table t" }] }),
    );
    renderModal();
    await changeType("bigint");
    const box = await screen.findByTestId("view-rebuild-blocked", undefined, { timeout: 3000 });
    expect(box).toHaveTextContent("policy p on table t");
    await waitFor(() => expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeDisabled());
  });

  it("依存ビューが無ければ、止める依存があっても適用を止めない (FK / CHECK 付き列の退行防止)", async () => {
    planFn.mockResolvedValue({
      views: [],
      drop_statements: [],
      create_statements: [],
      restore_statements: [],
      blockers: [{ kind: "other", description: "constraint c on table t" }],
      referenced_columns: [],
    });
    renderModal();
    await changeType("bigint");
    await waitFor(() => expect(planFn).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeEnabled());
    expect(screen.queryByTestId("view-rebuild-blocked")).toBeNull();
  });

  it("作り直すビューが参照する列を同じ ALTER でリネームすると衝突として止める", async () => {
    planFn.mockResolvedValue(withViews());
    renderModal();
    await changeType("bigint");
    await screen.findByTestId("view-rebuild", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByLabelText(t("viewRebuildToggle", { count: 2 })));
    fireEvent.change(screen.getByLabelText(`${t("alterTableNewName")}: age`), {
      target: { value: "age2" },
    });
    expect(await screen.findByTestId("view-rebuild-rename")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: t("alterTableRun") })).toBeDisabled());
  });
});
