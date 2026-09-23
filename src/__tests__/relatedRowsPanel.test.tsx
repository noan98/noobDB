import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { RowInspector } from "../components/RowInspector";
import type { Column, QueryResult } from "../api/tauri";
import { setLocale, t } from "../i18n";
import { setColumnMaskEnabled, setColumnMaskPatterns } from "../settings";
import { DEFAULT_MASK_PATTERNS, MASK_PLACEHOLDER } from "../components/columnMask";
import { RELATED_ROWS_PAGE, resolveRelatedEntries } from "../relatedRows";
import type { IncomingFk } from "../fkNavigation";

// 行インスペクタの「関連」タブ (master-detail、#1028) の UI 結線。
// SQL 生成・判定は `relatedRows.test.ts` が固定し、ここは「タブ → 展開 → 内部クエリ
// → 子行の描画 (マスク込み) → さらに読み込む / グリッドで開く」を見る。

const PARENT_COLS: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "email", type_name: "VARCHAR" },
];
const PARENT_ROW = [42, "alice@example.com"];
const INCOMING: IncomingFk[] = [
  { table: "orders", column: "user_id", referencedColumn: "id" },
  { table: "logins", column: "user_email", referencedColumn: "email" },
];

function childResult(n: number): QueryResult {
  return {
    columns: [
      { name: "order_id", type_name: "INT" },
      { name: "user_id", type_name: "INT" },
      { name: "api_token", type_name: "VARCHAR" },
    ],
    rows: Array.from({ length: n }, (_, i) => [i + 1, 42, `tok-${i}`]),
    rows_affected: 0,
    elapsed_ms: 1,
  };
}

function renderInspector(opts: {
  runQuery: (sql: string) => Promise<QueryResult>;
  onOpenInGrid?: (sql: string) => void;
  masked?: (ci: number) => boolean;
}) {
  const entries = resolveRelatedEntries(
    INCOMING,
    PARENT_COLS.map((c) => c.name),
    PARENT_ROW,
    opts.masked ?? (() => false),
  );
  return renderWithProviders(
    <RowInspector
      columns={PARENT_COLS}
      values={PARENT_ROW}
      columnKinds={["number", "string"]}
      rowNumber={1}
      hasPrev={false}
      hasNext={false}
      onClose={() => {}}
      related={{
        entries,
        driver: "mysql",
        database: "shop",
        runQuery: opts.runQuery,
        onOpenInGrid: opts.onOpenInGrid,
      }}
    />,
  );
}

describe("RowInspector の関連タブ (#1028)", () => {
  beforeEach(() => {
    setLocale("en");
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(DEFAULT_MASK_PATTERNS);
  });
  afterEach(() => {
    setColumnMaskEnabled(true);
    setColumnMaskPatterns(DEFAULT_MASK_PATTERNS);
  });

  it("related が無ければタブを出さない", () => {
    renderWithProviders(
      <RowInspector
        columns={PARENT_COLS}
        values={PARENT_ROW}
        columnKinds={["number", "string"]}
        rowNumber={1}
        hasPrev={false}
        hasNext={false}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByRole("radio", { name: /Related/ })).toBeNull();
  });

  it("展開すると LIMIT 付きの内部クエリで子行を取り、機微カラムは伏せ字にする", async () => {
    const runQuery = vi.fn().mockResolvedValue(childResult(2));
    renderInspector({ runQuery });

    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const header = screen.getByRole("button", { name: /orders\.user_id/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(runQuery).not.toHaveBeenCalled();

    fireEvent.click(header);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() =>
      expect(runQuery).toHaveBeenCalledWith(
        `SELECT * FROM \`shop\`.\`orders\` WHERE \`user_id\` = 42 LIMIT ${RELATED_ROWS_PAGE + 1}`,
      ),
    );
    const table = await screen.findByRole("table", {
      name: t("relatedRowsTableAria", { table: "orders" }),
    });
    expect(table.textContent).toContain("order_id");
    expect(table.textContent).not.toContain("tok-0");
    expect(table.textContent).toContain(MASK_PLACEHOLDER);
    expect(screen.getByText(t("relatedRowsCount", { count: 2 }))).toBeTruthy();
  });

  it("マスク機能オフなら子行の値をそのまま出す", async () => {
    setColumnMaskEnabled(false);
    const runQuery = vi.fn().mockResolvedValue(childResult(1));
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));
    expect(await screen.findByText("tok-0")).toBeTruthy();
  });

  it("上限を超える子行は「さらに読み込む」で上限を増やして取り直す", async () => {
    const runQuery = vi
      .fn()
      .mockResolvedValueOnce(childResult(RELATED_ROWS_PAGE + 1))
      .mockResolvedValueOnce(childResult(RELATED_ROWS_PAGE + 3));
    const onOpenInGrid = vi.fn();
    renderInspector({ runQuery, onOpenInGrid });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));

    expect(
      await screen.findByText(t("relatedRowsCountMore", { count: RELATED_ROWS_PAGE })),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("relatedRowsLoadMore") }));
    await waitFor(() =>
      expect(runQuery).toHaveBeenLastCalledWith(
        expect.stringMatching(new RegExp(`LIMIT ${RELATED_ROWS_PAGE * 2 + 1}$`)),
      ),
    );
    expect(
      await screen.findByText(t("relatedRowsCount", { count: RELATED_ROWS_PAGE + 3 })),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("relatedRowsOpen") }));
    expect(onOpenInGrid).toHaveBeenCalledWith(
      "SELECT * FROM `shop`.`orders` WHERE `user_id` = 42",
    );
  });

  it("キー列がマスク中の関連は展開できず、クエリも投げない", () => {
    const runQuery = vi.fn();
    renderInspector({ runQuery, masked: (ci) => ci === 1 });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const header = screen.getByRole("button", { name: /logins\.user_email/ });
    expect((header as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("relatedRowsBlockedMasked"))).toBeTruthy();
    fireEvent.click(header);
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("取得エラーを表示する", async () => {
    const runQuery = vi.fn().mockRejectedValue("permission denied");
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("permission denied");
  });
});
