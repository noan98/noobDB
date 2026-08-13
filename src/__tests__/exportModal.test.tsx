import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
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

import { ExportModal } from "../components/ExportModal";

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
