import { describe, it, expect, vi } from "vitest";
import { renderWithProviders, screen, fireEvent } from "./testUtils";
import { DumpModal } from "../components/DumpModal";
import { t } from "../i18n";
import { saveDumpPrefs } from "../inputMemory";

/**
 * DB ダンプモーダル (#604)。マウント時に Tauri 呼び出しを持たない (`dumpDatabase` は
 * 実行ボタン押下時のみ)。ダイアログとしてマウントでき、タイトルが可視であること・
 * 閉じるボタンで `onClose` が呼ばれることを固定する。
 */
describe("DumpModal render smoke (#604)", () => {
  it("mounts as a dialog and shows the dump title with the database name", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="appdb" driver="mysql" onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(t("dumpTitle", { database: "appdb" }))).toBeInTheDocument();
  });

  it("invokes onClose when the close control is activated", () => {
    const onClose = vi.fn();
    renderWithProviders(<DumpModal sessionId="s1" database="appdb" driver="mysql" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: t("dumpClose") }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  // SQLite はライブ接続から直接生成する (外部ツール不要) ので、外部ツール前提の
  // 注記ではなくネイティブ用の注記と、適用できるオプションを表示する。
  it("shows native-dump note and options for sqlite", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.getByText(t("dumpNoteNative"))).toBeInTheDocument();
    expect(screen.queryByText(t("dumpNote"))).not.toBeInTheDocument();
    expect(screen.getByText(t("dumpOptNoData"))).toBeInTheDocument();
    expect(screen.getByText(t("dumpOptAddDropTable"))).toBeInTheDocument();
    // mysqldump 専用のオプションは出さない。
    expect(screen.queryByText(t("dumpOptSingleTransaction"))).not.toBeInTheDocument();
    expect(screen.queryByText(t("dumpOptEvents"))).not.toBeInTheDocument();
  });

  // gzip (#1539): 全ドライバで選べ、切り替えると保存先の拡張子が .sql ⇔ .sql.gz に追従する。
  it("gzip toggle swaps the save path extension between .sql and .sql.gz", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    expect(pathInput.value.endsWith(".sql")).toBe(true);
    const gzip = screen.getByRole("switch", { name: t("dumpOptGzip") });
    fireEvent.click(gzip);
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
    fireEvent.click(gzip);
    expect(pathInput.value.endsWith(".sql")).toBe(true);
    expect(pathInput.value.endsWith(".gz")).toBe(false);
  });

  // #1624: ドライバ別の追加オプション。
  it("shows the mysql-only extra flags and the sqlite-only snapshot toggle per driver", () => {
    const { unmount } = renderWithProviders(
      <DumpModal sessionId="s1" database="app" driver="mysql" onClose={() => {}} />,
    );
    expect(screen.getByRole("switch", { name: t("dumpOptNoTablespaces") })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptGtidPurgedOff") })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptChecksum") })).not.toBeChecked();
    expect(screen.queryByRole("switch", { name: t("dumpOptSqliteSnapshot") })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    expect(screen.queryByRole("switch", { name: t("dumpOptNoTablespaces") })).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") })).toBeInTheDocument();
  });

  it("snapshot toggle swaps the save path extension to .db (and .db.gz with gzip)", () => {
    renderWithProviders(<DumpModal sessionId="s1" database="main" driver="sqlite" onClose={() => {}} />);
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    expect(pathInput.value.endsWith(".db")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptGzip") }));
    expect(pathInput.value.endsWith(".db.gz")).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: t("dumpOptSqliteSnapshot") }));
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
  });
});

// 前回のスイッチと保存先ディレクトリをプロファイルごとに復元する (#1631)。
describe("DumpModal 前回入力の記憶 (#1631)", () => {
  it("プロファイルに保存された gzip・保存先ディレクトリを初期値にする", () => {
    localStorage.clear();
    saveDumpPrefs("p1", { options: { gzip: true, noData: true }, dir: "/backups/db" });
    renderWithProviders(
      <DumpModal sessionId="s1" database="main" driver="sqlite" profileId="p1" onClose={() => {}} />,
    );
    const pathInput = screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement;
    expect(pathInput.value.startsWith("/backups/db/")).toBe(true);
    expect(pathInput.value.endsWith(".sql.gz")).toBe(true);
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).toBeChecked();
    expect(screen.getByRole("switch", { name: t("dumpOptNoData") })).toBeChecked();
  });

  it("別プロファイルや profileId なしでは復元しない", () => {
    localStorage.clear();
    saveDumpPrefs("p1", { options: { gzip: true }, dir: "/backups/db" });
    renderWithProviders(
      <DumpModal sessionId="s1" database="main" driver="sqlite" profileId="p2" onClose={() => {}} />,
    );
    expect((screen.getByLabelText(t("dumpSavePath")) as HTMLInputElement).value.startsWith("/")).toBe(false);
    expect(screen.getByRole("switch", { name: t("dumpOptGzip") })).not.toBeChecked();
  });
});
