import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { AlterTableContext, SkippedProfile } from "../api/tauri";

/**
 * エラー・警告の文言統一と握りつぶしの解消 (#1614) のうち、画面を伴うもの。
 * 純関数側 (sqlHeadline / parseResponse / explainPlan) は各ユニットテストに足してある。
 */
const mocks = vi.hoisted(() => ({
  ctx: null as unknown,
  skipped: [] as unknown[],
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openMock, save: vi.fn() }));

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      alterTableContext: vi.fn(() => Promise.resolve(mocks.ctx)),
      listSkippedProfiles: vi.fn(() => Promise.resolve(mocks.skipped)),
      deleteSkippedProfile: vi.fn(() => Promise.resolve()),
      deleteProfile: vi.fn(() => Promise.resolve()),
    },
  };
});

import { api } from "../api/tauri";
import { AlterTableModal } from "../components/AlterTableModal";
import { SkippedProfilesNotice } from "../components/SkippedProfilesNotice";
import { WelcomeView } from "../components/WelcomeView";

const baseCtx: AlterTableContext = {
  columns: [
    {
      name: "id",
      data_type: "int",
      nullable: false,
      key: "PRI",
      default: null,
      extra: "",
      referenced_table: null,
      referenced_column: null,
    },
  ],
  table_comment: "",
  foreign_keys: [],
  checks: [],
  table_names: ["t"],
  warnings: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skipped = [];
});

function renderAlter() {
  renderWithProviders(
    <AlterTableModal
      sessionId="s1"
      driver="mysql"
      database="db"
      table="t"
      readOnly={false}
      onRun={() => {}}
      onSendToEditor={() => {}}
      onClose={() => {}}
    />,
  );
}

describe("AlterTableModal の付随情報の取得失敗 (#1614)", () => {
  it("コメント / FK の取得に失敗したら『表示が不完全』の警告帯を出す", async () => {
    mocks.ctx = { ...baseCtx, warnings: ["comments", "foreign_keys"] };
    renderAlter();
    const warn = await screen.findByTestId("alter-context-warning");
    expect(warn).toHaveTextContent(t("alterTableCtxItemComments"));
    expect(warn).toHaveTextContent(t("alterTableCtxItemForeignKeys"));
  });

  it("失敗が無ければ警告帯は出ない", async () => {
    mocks.ctx = baseCtx;
    renderAlter();
    await screen.findAllByRole("button", { name: t("alterTableDrop") });
    expect(screen.queryByTestId("alter-context-warning")).toBeNull();
  });
});

describe("SkippedProfilesNotice (#1614)", () => {
  const bad: SkippedProfile = {
    kind: "unparsable",
    index: 0,
    id: "bad00001",
    name: "broken",
    driver: "mysql",
    reason: "invalid type",
  };

  it("読み飛ばしたエントリが無ければ何も描画しない", async () => {
    renderWithProviders(<SkippedProfilesNotice refreshKey={0} onChanged={() => {}} />);
    await waitFor(() => expect(api.listSkippedProfiles).toHaveBeenCalled());
    expect(screen.queryByTestId("skipped-profiles-notice")).toBeNull();
  });

  it("件数と理由を出し、確認のうえ削除して一覧を読み直す", async () => {
    mocks.skipped = [bad];
    const onChanged = vi.fn();
    renderWithProviders(<SkippedProfilesNotice refreshKey={0} onChanged={onChanged} />);
    const notice = await screen.findByTestId("skipped-profiles-notice");
    expect(notice).toHaveTextContent(t("skippedProfilesTitle", { count: 1 }));
    expect(notice).toHaveTextContent("invalid type");

    fireEvent.click(screen.getByRole("button", { name: t("skippedProfileDelete") }));
    // 確認ダイアログの実行ボタン (破壊的確認は左に dangerOutline)。
    const buttons = await screen.findAllByRole("button", { name: t("skippedProfileDelete") });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.deleteSkippedProfile).toHaveBeenCalledWith(0, "bad00001"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("対応外ドライバのプロファイルは通常の削除コマンドで消す", async () => {
    mocks.skipped = [{ ...bad, kind: "unsupported_driver", driver: "duckdb", id: "old00001" }];
    renderWithProviders(<SkippedProfilesNotice refreshKey={0} onChanged={() => {}} />);
    await screen.findByTestId("skipped-profiles-notice");
    fireEvent.click(screen.getByRole("button", { name: t("skippedProfileDelete") }));
    const buttons = await screen.findAllByRole("button", { name: t("skippedProfileDelete") });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith("old00001"));
  });
});

describe("WelcomeView のファイル選択失敗 (#1614)", () => {
  it("ダイアログが reject したら無言にせずエラーを通知する", async () => {
    mocks.openMock.mockRejectedValueOnce(new Error("no dialog"));
    const onOpenSqlite = vi.fn();
    renderWithProviders(
      <WelcomeView onCreateConnection={() => {}} onOpenSqlite={onOpenSqlite} onStartTour={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("welcomeOpenSqliteTitle") }));
    expect(await screen.findByText(/no dialog/)).toBeInTheDocument();
    expect(onOpenSqlite).not.toHaveBeenCalled();
  });
});
