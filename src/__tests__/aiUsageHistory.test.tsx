import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen, waitFor } from "./testUtils";
import { t } from "../i18n";

const getAiUsageHistory = vi.fn();
const clearAiUsageHistory = vi.fn();

vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getAiUsageHistory: () => getAiUsageHistory(),
      clearAiUsageHistory: () => clearAiUsageHistory(),
    },
  };
});

import { AiUsageHistory } from "../components/AiUsageHistory";

const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const record = {
  day: today,
  task: "nl2sql",
  model: "claude-opus-5-5",
  calls: 2,
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  clearAiUsageHistory.mockResolvedValue(undefined);
});

describe("AiUsageHistory (#1540)", () => {
  it("空のときは空状態の文言を出し、消去ボタンは無効", async () => {
    getAiUsageHistory.mockResolvedValue([]);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findByText(t("aiLedgerEmpty"));
    expect(screen.getByRole("button", { name: t("aiLedgerClear") })).toBeDisabled();
  });

  it("合計・モデル別・タスク別と概算コストを表示する", async () => {
    getAiUsageHistory.mockResolvedValue([record]);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => `task:${x}`} />);
    await screen.findAllByText(/\$4\.00/);
    expect(screen.getByText(/Claude Opus 5\.5: 2 /)).toBeInTheDocument();
    expect(screen.getByText(/task:nl2sql: 2 /)).toBeInTheDocument();
  });

  it("確認のうえ消去すると台帳を空にして一覧を空にする", async () => {
    getAiUsageHistory.mockResolvedValue([record]);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findAllByText(/\$4\.00/);
    fireEvent.click(screen.getByRole("button", { name: t("aiLedgerClear") }));
    await screen.findByText(t("aiLedgerClearConfirmTitle"));
    const buttons = screen.getAllByRole("button", { name: t("aiLedgerClear") });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(clearAiUsageHistory).toHaveBeenCalledTimes(1));
    await screen.findByText(t("aiLedgerEmpty"));
  });

  it("既定の期間は今月で、先月以前の記録は「記録されたすべて」に切り替えるまで集計しない", async () => {
    getAiUsageHistory.mockResolvedValue([{ ...record, day: "2000-01-15", calls: 7 }]);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findByText(t("aiLedgerEmpty"));
    fireEvent.change(screen.getByLabelText(t("aiLedgerRange")), { target: { value: "all" } });
    await screen.findAllByText(/7 /);
  });

  it("日別は最新 7 日だけ表示し、残りは「さらに N 日分を表示」で開いて畳める (#1608)", async () => {
    // 2000 年の 10 日分 (全期間で見る)。
    const days = Array.from({ length: 10 }, (_, i) => ({ ...record, day: `2000-01-${String(i + 1).padStart(2, "0")}`, calls: 1 }));
    getAiUsageHistory.mockResolvedValue(days);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findByText(t("aiLedgerEmpty"));
    fireEvent.change(screen.getByLabelText(t("aiLedgerRange")), { target: { value: "all" } });
    await screen.findByText(/2000-01-10: 1 /);
    expect(screen.queryByText(/2000-01-01: 1 /)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("aiLedgerDayMore", { count: 3 }) }));
    expect(screen.getByText(/2000-01-01: 1 /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("aiLedgerDayLess", { count: 7 }) }));
    expect(screen.queryByText(/2000-01-01: 1 /)).toBeNull();
  });

  it("日別が 7 日以下なら展開ボタンを出さない (#1608)", async () => {
    getAiUsageHistory.mockResolvedValue([record]);
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findAllByText(/\$4\.00/);
    expect(screen.queryByRole("button", { name: /さらに|Show \d+ more/ })).toBeNull();
  });

  it("読み込みに失敗したらエラーを表示する", async () => {
    getAiUsageHistory.mockRejectedValue(new Error("boom"));
    renderWithProviders(<AiUsageHistory taskLabel={(x) => x} />);
    await screen.findByText(/boom/);
  });
});
