import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { t } from "../i18n";

/**
 * ストアドプロシージャ / 関数の実行フォーム (#1003)。マウント時に
 * `api.getRoutineSignature` を呼ぶので実 Tauri なしで描画できるようモックする。
 * モーダル自身は SQL を実行せず、生成 SQL を `onRun` で親 (通常の実行ゲート) へ渡す。
 */
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getRoutineSignature: vi.fn(),
    },
  };
});

import { api } from "../api/tauri";
import { RunRoutineModal } from "../components/RunRoutineModal";

const getRoutineSignature = api.getRoutineSignature as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

function renderModal(overrides: Partial<Parameters<typeof RunRoutineModal>[0]> = {}) {
  const onRun = vi.fn();
  const onSendToEditor = vi.fn();
  renderWithProviders(
    <RunRoutineModal
      sessionId="s1"
      driver="mysql"
      database="shop"
      kind="procedure"
      name="add_order"
      id={null}
      txActive={false}
      onRun={onRun}
      onSendToEditor={onSendToEditor}
      onCancel={() => {}}
      {...overrides}
    />,
  );
  return { onRun, onSendToEditor };
}

describe("RunRoutineModal (#1003)", () => {
  it("シグネチャを取得し、入力値をエスケープした CALL を onRun へ渡す", async () => {
    getRoutineSignature.mockResolvedValue({
      kind: "procedure",
      name: "add_order",
      parameters: [
        { name: "id", mode: "in", data_type: "int" },
        { name: "note", mode: "in", data_type: "varchar(20)" },
      ],
      returns_set: false,
      return_type: null,
    });
    const { onRun } = renderModal();
    await waitFor(() => expect(getRoutineSignature).toHaveBeenCalledWith("s1", "shop", "procedure", "add_order", null));
    const idInput = await screen.findByLabelText(/^id ·/);
    fireEvent.change(idInput, { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText(/^note ·/), { target: { value: "it's" } });
    expect(screen.getByText("CALL `shop`.`add_order`(7, 'it''s')")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("runRoutineRun") }));
    expect(onRun).toHaveBeenCalledWith("CALL `shop`.`add_order`(7, 'it''s')");
  });

  it("型に合わない入力では実行ボタンを無効化する", async () => {
    getRoutineSignature.mockResolvedValue({
      kind: "function",
      name: "f",
      parameters: [{ name: "n", mode: "in", data_type: "int" }],
      returns_set: false,
      return_type: "int",
    });
    const { onRun } = renderModal({ kind: "function", name: "f" });
    const input = await screen.findByLabelText(/^n ·/);
    fireEvent.change(input, { target: { value: "abc" } });
    expect(screen.getByText(t("editInvalidNumber"))).toBeInTheDocument();
    const run = screen.getByRole("button", { name: t("runRoutineRun") });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(onRun).not.toHaveBeenCalled();
  });

  it("MySQL の OUT はトランザクション外では実行を止め、エディタへ送るだけ許す", async () => {
    getRoutineSignature.mockResolvedValue({
      kind: "procedure",
      name: "p",
      parameters: [{ name: "o", mode: "out", data_type: "int" }],
      returns_set: false,
      return_type: null,
    });
    const { onRun, onSendToEditor } = renderModal({ name: "p" });
    await screen.findByText(t("runRoutineNeedsTransaction"));
    expect(screen.getByRole("button", { name: t("runRoutineRun") })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: t("runRoutineSendToEditor") }));
    expect(onSendToEditor).toHaveBeenCalledWith("CALL `shop`.`p`(@`o`);\nSELECT @`o` AS `o`;");
    expect(onRun).not.toHaveBeenCalled();
  });

  it("取得エラー (非対応ドライバ等) を ErrorNote で表示する", async () => {
    getRoutineSignature.mockRejectedValue(new Error("stored routines are not supported for SQLite"));
    renderModal({ driver: "sqlite" });
    expect(await screen.findByRole("alert")).toHaveTextContent("not supported");
  });
});
