import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, renderWithProviders, screen } from "./testUtils";
import type { Column, QueryResult } from "../api/tauri";
import { GridReplaceModal } from "../components/GridReplaceModal";
import { COUNT_PREVIEW_DEBOUNCE_MS } from "../useCountPreviews";
import { t } from "../i18n";

const columns = [{ name: "url", type_name: "varchar(255)" }] as unknown as Column[];

function result(n: number): QueryResult {
  return {
    columns: [],
    rows: [[n]],
    rows_affected: 0,
    elapsed_ms: 1,
    server_messages: [],
  } as unknown as QueryResult;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function renderModal(lookup: ((sql: string, cap: number) => Promise<QueryResult>) | undefined) {
  return renderWithProviders(
    <GridReplaceModal
      columns={columns}
      rows={[]}
      pkIndices={[]}
      colIdx={0}
      driver="mysql"
      database="app"
      table="users"
      editableColumns={[true]}
      onApplyColumn={() => {}}
      onLookupQuery={lookup}
      onApplyInGrid={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("GridReplaceModal: 列全体モードの対象行数 (#1536)", () => {
  it("入力をデバウンスして COUNT(*) を 1 回だけ発行し、対象行数を表示する", async () => {
    const lookup = vi.fn().mockResolvedValue(result(42));
    renderModal(lookup);
    fireEvent.change(screen.getByLabelText(t("gridReplaceFind")), { target: { value: "h" } });
    fireEvent.change(screen.getByLabelText(t("gridReplaceFind")), { target: { value: "http://" } });
    expect(lookup).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    // 件数 (COUNT) と、変更前 → 変更後のサンプル (#1626) の 2 本だけ。
    expect(lookup).toHaveBeenCalledTimes(2);
    const sqls = lookup.mock.calls.map((c) => c[0] as string);
    expect(sqls).toContain("SELECT COUNT(*) FROM `app`.`users` WHERE REGEXP_LIKE(`url`, 'http://', 'i')");
    const sample = sqls.find((q) => q.startsWith("SELECT `url`, "));
    expect(sample).toMatch(/REGEXP_REPLACE\(`url`, .*\) FROM `app`.`users` WHERE REGEXP_LIKE\(.*\) LIMIT 5$/);
    expect(lookup.mock.calls.find((c) => c[0] === sample)?.[1]).toBe(5);
    expect(screen.getByTestId("grid-replace-sample")).toBeTruthy();
    expect(screen.getByTestId("grid-replace-count")).toHaveTextContent(
      t("gridReplaceColumnCount", { count: "42" }),
    );
  });

  it("onLookupQuery が無ければ件数は出さない", async () => {
    renderModal(undefined);
    fireEvent.change(screen.getByLabelText(t("gridReplaceFind")), { target: { value: "x" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COUNT_PREVIEW_DEBOUNCE_MS + 10);
    });
    expect(screen.queryByTestId("grid-replace-count")).toBeNull();
  });
});
