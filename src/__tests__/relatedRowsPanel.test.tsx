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

function countResult(n: number): QueryResult {
  return {
    columns: [{ name: "COUNT(*)", type_name: "BIGINT" }],
    rows: [[n]],
    rows_affected: 0,
    elapsed_ms: 1,
  };
}

/**
 * 件数用 COUNT (#1629) と子行取得を同じ `runQuery` で受けるモック。COUNT は `counts[子テーブル]`
 * (既定 2)、子行取得は `rows(呼び出し番号)` の結果を返す。
 */
function routedRunQuery(
  opts: { counts?: Record<string, number>; rows?: (call: number) => QueryResult } = {},
) {
  let call = 0;
  return vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT COUNT(*)")) {
      const table = /FROM `shop`\.`(\w+)`/.exec(sql)?.[1] ?? "";
      return countResult(opts.counts?.[table] ?? 2);
    }
    call += 1;
    return (opts.rows ?? (() => childResult(2)))(call);
  });
}

/** 子行取得 (`SELECT *`) の呼び出しだけ。 */
const rowCalls = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => String(c[0])).filter((sql) => sql.startsWith("SELECT * "));

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
    const runQuery = routedRunQuery();
    renderInspector({ runQuery });

    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const header = screen.getByRole("button", { name: /orders\.user_id/ });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    // 展開するまで子行は取らない (件数の COUNT だけ)。
    expect(rowCalls(runQuery)).toEqual([]);

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
    const runQuery = routedRunQuery({ rows: () => childResult(1) });
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));
    expect(await screen.findByText("tok-0")).toBeTruthy();
  });

  it("上限を超える子行は「さらに読み込む」で上限を増やして取り直す", async () => {
    const runQuery = routedRunQuery({
      rows: (call) => childResult(call === 1 ? RELATED_ROWS_PAGE + 1 : RELATED_ROWS_PAGE + 3),
    });
    const onOpenInGrid = vi.fn();
    renderInspector({ runQuery, onOpenInGrid });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));

    expect(await screen.findByText(t("relatedRowsCountMore", { count: RELATED_ROWS_PAGE }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("relatedRowsLoadMore") }));
    await waitFor(() =>
      expect(runQuery).toHaveBeenLastCalledWith(
        expect.stringMatching(new RegExp(`LIMIT ${RELATED_ROWS_PAGE * 2 + 1}$`)),
      ),
    );
    expect(await screen.findByText(t("relatedRowsCount", { count: RELATED_ROWS_PAGE + 3 }))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: t("relatedRowsOpen") }));
    expect(onOpenInGrid).toHaveBeenCalledWith("SELECT * FROM `shop`.`orders` WHERE `user_id` = 42");
  });

  it("キー列がマスク中の関連は展開できず、クエリも投げない", () => {
    const runQuery = routedRunQuery();
    renderInspector({ runQuery, masked: (ci) => ci === 1 });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const header = screen.getByRole("button", { name: /logins\.user_email/ });
    expect((header as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(t("relatedRowsBlockedMasked"))).toBeTruthy();
    fireEvent.click(header);
    expect(rowCalls(runQuery)).toEqual([]);
    // 件数の COUNT もマスク中の関連 (logins) には投げない。
    expect(runQuery.mock.calls.some((c) => String(c[0]).includes("`logins`"))).toBe(false);
  });

  it("取得エラーを表示する", async () => {
    const runQuery = vi.fn().mockRejectedValue("permission denied");
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("permission denied");
  });

  it("見出しに子行の件数を事前に出す (#1629)", async () => {
    const runQuery = routedRunQuery({ counts: { orders: 7, logins: 0 } });
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const orders = screen.getByRole("button", { name: /orders\.user_id/ });
    await waitFor(() => expect(orders.textContent).toContain(t("relatedRowsBadge", { count: 7 })));
    const logins = screen.getByRole("button", { name: /logins\.user_email/ });
    await waitFor(() => expect(logins.textContent).toContain(t("relatedRowsBadge", { count: 0 })));
    // 打ち切り付きの COUNT を 1 エントリにつき 1 回だけ投げる。
    const counts = runQuery.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => sql.startsWith("SELECT COUNT"));
    expect(counts).toHaveLength(2);
    expect(counts[0]).toContain("LIMIT 1001");
    expect(rowCalls(runQuery)).toEqual([]);
  });

  it("上限を超える件数は「超」で表示する (#1629)", async () => {
    const runQuery = routedRunQuery({ counts: { orders: 1001 } });
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    const orders = screen.getByRole("button", { name: /orders\.user_id/ });
    await waitFor(() => expect(orders.textContent).toContain(t("relatedRowsBadgeOver", { count: 1000 })));
  });

  it("件数の取得に失敗しても見出しは展開できる (#1629)", async () => {
    setColumnMaskEnabled(false);
    const runQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT COUNT(*)")) throw new Error("denied");
      return childResult(1);
    });
    renderInspector({ runQuery });
    fireEvent.click(screen.getByRole("radio", { name: t("inspectorTabRelated", { count: 2 }) }));
    await waitFor(() => expect(runQuery).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByTestId("related-count")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /orders\.user_id/ }));
    expect(await screen.findByText("tok-0")).toBeTruthy();
  });
});
