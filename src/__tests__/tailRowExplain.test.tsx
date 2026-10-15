import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "./testUtils";
import { t } from "../i18n";
import { TailRow } from "../components/QueryInspectorPanel";

describe("TailRow の EXPLAIN ボタン (#1622)", () => {
  const base = (query: string) => ({
    key: "k1",
    user: "app",
    host: "h",
    application: null,
    database: "shop",
    duration_ms: 12,
    rows_examined: null,
    query,
    running: false,
    observed_at: null,
    observedAtMs: 1,
    fingerprint: "fp",
  });

  it("押すと観測した原文とデータベースを渡す", () => {
    const onExplain = vi.fn();
    renderWithProviders(
      <table>
        <tbody>
          <TailRow
            entry={base("SELECT * FROM orders WHERE id = 1") as never}
            showRowsExamined={false}
            nPlusOneCount={null}
            nPlusOneWindowMs={0}
            onCopy={vi.fn()}
            onExplain={onExplain}
          />
        </tbody>
      </table>,
    );
    fireEvent.click(screen.getByRole("button", { name: t("inspectorExplainSql") }));
    expect(onExplain).toHaveBeenCalledWith("SELECT * FROM orders WHERE id = 1", "shop");
  });

  it("権限不足の本文では無効、onExplain 未指定ならボタン自体を出さない", () => {
    const { rerender } = renderWithProviders(
      <table>
        <tbody>
          <TailRow
            entry={base("<insufficient privilege>") as never}
            showRowsExamined={false}
            nPlusOneCount={null}
            nPlusOneWindowMs={0}
            onCopy={vi.fn()}
            onExplain={vi.fn()}
          />
        </tbody>
      </table>,
    );
    expect(screen.getByRole("button", { name: t("inspectorExplainSql") })).toBeDisabled();
    rerender(
      <table>
        <tbody>
          <TailRow
            entry={base("SELECT 1") as never}
            showRowsExamined={false}
            nPlusOneCount={null}
            nPlusOneWindowMs={0}
            onCopy={vi.fn()}
          />
        </tbody>
      </table>,
    );
    expect(screen.queryByRole("button", { name: t("inspectorExplainSql") })).not.toBeInTheDocument();
  });
});
