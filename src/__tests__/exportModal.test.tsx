import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { SAMPLE_COLUMNS, SAMPLE_ROWS, makeColumn } from "./fixtures/componentFixtures";
import { t } from "../i18n";

/**
 * 結果エクスポートモーダル (#604)。マウント effect が `@tauri-apps/api/path` の
 * `downloadDir` / `join` で既定パスを埋めるためモックする (書き出しは Export 押下時のみ)。
 * ダイアログとしてマウントでき、タイトルが可視であること・閉じるボタンで `onClose`
 * が呼ばれることを固定する。
 */
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: vi.fn().mockResolvedValue("/home/user/Downloads"),
  join: vi.fn().mockResolvedValue("/home/user/Downloads/export.csv"),
}));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      writeBinaryFile: vi.fn().mockResolvedValue(123),
    },
  };
});

import { ExportModal } from "../components/ExportModal";
import { api, type TableColumnInfo } from "../api/tauri";
import { MASK_PLACEHOLDER } from "../components/columnMask";

describe("ExportModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the export title", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database="appdb"
        table="users"
        driver="mysql"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("exportTitle"))).toBeInTheDocument();
  });

  it("invokes onClose from the header close control", () => {
    const onClose = vi.fn();
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("exportClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

/**
 * 矩形選択範囲のエクスポート (#917)。`selection` prop が渡されたときだけ
 * 「選択範囲」スコープを提示し、既定でそれを選択する。整形は既存の
 * `buildExportContent` を経由するため二重実装しない — ここではプレビューが
 * 選択部分集合 (グリッド全体ではなく) を反映することだけを確認する。
 */
describe("ExportModal 選択範囲スコープ (#917)", () => {
  const SELECTION = {
    columns: [makeColumn("name", "varchar")],
    rows: [["alice"], ["bob"]] as const,
  };

  it("selection が無ければ「選択範囲」の選択肢を出さない (従来どおり)", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText(t("exportScopeSelection"))).not.toBeInTheDocument();
    // プレビューはグリッド全体 (2 列とも) を反映する。
    expect(screen.getByLabelText(t("exportPreview")).textContent).toContain("id,name");
  });

  it("selection があれば「選択範囲」スコープを提示し、既定で選択する", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        selection={{ columns: SELECTION.columns, rows: SELECTION.rows as unknown as (typeof SAMPLE_ROWS) }}
        onClose={() => {}}
      />,
    );
    const radio = screen.getByRole("radio", { name: new RegExp(t("exportScopeSelection")) });
    expect(radio).toBeChecked();
    // プレビューは選択範囲の部分集合 (name 列のみ・2 行) を反映し、全体の
    // id 列は含まない。
    const preview = screen.getByLabelText(t("exportPreview")).textContent ?? "";
    expect(preview).toContain("name");
    expect(preview).not.toContain("id,name");
    expect(preview).toContain("alice");
    expect(preview).toContain("bob");
  });

  it("選択範囲スコープでは選択部分集合の件数を表示する", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        selection={{ columns: SELECTION.columns, rows: SELECTION.rows as unknown as (typeof SAMPLE_ROWS) }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(t("exportRowCount", { rows: 2 }))).toBeInTheDocument();
  });

  it("スコープを「現在のグリッドのみ」に切り替えるとプレビューがグリッド全体に戻る", () => {
    renderWithProviders(
      <ExportModal
        columns={SAMPLE_COLUMNS}
        rows={SAMPLE_ROWS}
        database={null}
        table={null}
        selection={{ columns: SELECTION.columns, rows: SELECTION.rows as unknown as (typeof SAMPLE_ROWS) }}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(t("exportScopeCurrent")) }));
    const preview = screen.getByLabelText(t("exportPreview")).textContent ?? "";
    expect(preview).toContain("id,name");
  });
});

/**
 * 調査バンドル (#745)。`bundle` 文脈が渡されたときだけ形式に現れ、保存前に
 * 持ち出す件数と伏せ字化される列を明示し、`write_binary_file` で自己完結 HTML を書く。
 */
describe("ExportModal 調査バンドル (#745)", () => {
  const COLS = [makeColumn("id", "int"), makeColumn("user_email", "varchar")];
  const ROWS = [
    [1, "alice@example.com"],
    [2, "bob@example.com"],
  ];
  const MASK = { enabled: true, patterns: ["email"], overrides: {} };

  function renderBundle() {
    const describeFn = vi.fn().mockResolvedValue([
      { name: "id", data_type: "int", nullable: false, key: "PRI", default: null, extra: "" },
    ] as unknown as TableColumnInfo[]);
    const loadPlan = vi.fn().mockResolvedValue({
      columns: [makeColumn("EXPLAIN", "json")],
      rows: [['{"plan":1}']],
      rows_affected: 0,
      elapsed_ms: 1,
    });
    renderWithProviders(
      <ExportModal
        columns={COLS}
        rows={ROWS}
        database="appdb"
        table="users"
        driver="mysql"
        bundle={{
          sql: "SELECT * FROM users",
          profileName: "prod",
          host: "db.internal",
          executedAt: Date.UTC(2026, 0, 1),
          describe: describeFn,
          loadPlan,
        }}
        elapsedMs={12}
        maskConfig={MASK}
        onClose={() => {}}
      />,
    );
    return { describeFn, loadPlan };
  }

  function lastWrittenHtml(): { path: string; html: string } {
    const calls = vi.mocked(api.writeBinaryFile).mock.calls;
    const [path, bytes] = calls[calls.length - 1];
    return { path, html: new TextDecoder().decode(bytes) };
  }

  it("bundle 文脈が無ければ形式に出さない", () => {
    renderWithProviders(
      <ExportModal columns={COLS} rows={ROWS} database={null} table={null} onClose={() => {}} />,
    );
    expect(screen.queryByRole("radio", { name: t("exportFormatBundle") })).not.toBeInTheDocument();
  });

  it("選ぶと持ち出し件数と伏せ字列を明示し、プレビューはマスク済み HTML", () => {
    renderBundle();
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatBundle") }));
    const warning = screen.getByTestId("export-bundle-warning");
    expect(warning.textContent).toContain(t("exportBundleDataWarning", { rows: 2, cols: 2 }));
    expect(warning.textContent).toContain(t("exportBundleMasked", { count: 1, names: "user_email" }));
    const preview = screen.getByLabelText(t("exportPreview")).textContent ?? "";
    expect(preview).toContain("<!DOCTYPE html>");
    expect(preview).toContain(MASK_PLACEHOLDER);
    expect(preview).not.toContain("alice@example.com");
    // ホスト名は既定で含めない。
    expect(preview).not.toContain("db.internal");
    expect(screen.getByRole("checkbox", { name: t("exportBundleIncludeHost") })).not.toBeChecked();
  });

  it("保存すると write_binary_file に .html を書き、スキーマを同梱し EXPLAIN は既定で実行しない", async () => {
    vi.mocked(api.writeBinaryFile).mockClear();
    const { describeFn, loadPlan } = renderBundle();
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatBundle") }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("exportBundleIncludeHost") }));
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.writeBinaryFile).toHaveBeenCalled());
    const { path, html } = lastWrittenHtml();
    expect(path.endsWith(".html")).toBe(true);
    expect(describeFn).toHaveBeenCalledWith("appdb", "users");
    expect(loadPlan).not.toHaveBeenCalled();
    expect(html).toContain(t("bundleSectionSchema"));
    expect(html).toContain("db.internal");
    expect(html).not.toContain("alice@example.com");
  });

  it("実行計画を選ぶと EXPLAIN を取得して同梱する", async () => {
    vi.mocked(api.writeBinaryFile).mockClear();
    const { loadPlan } = renderBundle();
    fireEvent.click(screen.getByRole("radio", { name: t("exportFormatBundle") }));
    fireEvent.click(screen.getByRole("checkbox", { name: t("exportBundleIncludePlan") }));
    fireEvent.click(screen.getByRole("button", { name: t("exportExecute") }));
    await waitFor(() => expect(api.writeBinaryFile).toHaveBeenCalled());
    expect(loadPlan).toHaveBeenCalled();
    const { html } = lastWrittenHtml();
    expect(html).toContain(t("bundleSectionPlan"));
    expect(html).toContain("&quot;plan&quot;: 1");
  });
});
