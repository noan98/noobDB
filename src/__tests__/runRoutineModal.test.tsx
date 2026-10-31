import { describe, it, expect, vi, beforeEach } from "vitest";
import { chooseListboxOption, renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
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
import {
  clearRoutineArgMemory,
  loadRoutineArgSets,
  routineArgsScope,
  saveRoutineArgSets,
} from "../inputMemory";

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
    await waitFor(() =>
      expect(getRoutineSignature).toHaveBeenCalledWith("s1", "shop", "procedure", "add_order", null),
    );
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

  it("IME 変換中の Enter では実行せず、通常の Enter で実行する (#1515)", async () => {
    getRoutineSignature.mockResolvedValue({
      kind: "procedure",
      name: "add_order",
      parameters: [{ name: "note", mode: "in", data_type: "varchar(20)" }],
      returns_set: false,
      return_type: null,
    });
    const { onRun } = renderModal();
    const input = await screen.findByLabelText(/^note ·/);
    fireEvent.change(input, { target: { value: "さくら" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onRun).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it("複数引数では最後の欄以外の Enter は次の欄へ移るだけで実行しない (#1604)", async () => {
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
    const first = await screen.findByLabelText(/^id ·/);
    const second = screen.getByLabelText(/^note ·/);
    fireEvent.change(first, { target: { value: "7" } });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(onRun).not.toHaveBeenCalled();
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

describe("RunRoutineModal の引数履歴 (#1631)", () => {
  const signature = {
    kind: "procedure",
    name: "add_order",
    parameters: [
      { name: "id", mode: "in", data_type: "int" },
      { name: "api_token", mode: "in", data_type: "varchar(20)" },
    ],
    returns_set: false,
    return_type: null,
  };
  const scope = routineArgsScope("p1", "shop", "procedure", "add_order", null);

  it("履歴から選ぶと引数欄が埋まる", async () => {
    clearRoutineArgMemory();
    saveRoutineArgSets(scope, [["7", "x"]]);
    getRoutineSignature.mockResolvedValue(signature);
    renderModal({ profileId: "p1" });
    const select = await screen.findByLabelText(t("runRoutineHistoryLabel"));
    chooseListboxOption(select, "0");
    expect((screen.getByLabelText(/^id ·/) as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText(/^api_token ·/) as HTMLInputElement).value).toBe("x");
  });

  it("実行すると履歴に残るが、マスク対象の引数名の値は残さず、ディスクにも書かない", async () => {
    clearRoutineArgMemory();
    localStorage.clear();
    getRoutineSignature.mockResolvedValue(signature);
    const { onRun } = renderModal({ profileId: "p1" });
    fireEvent.change(await screen.findByLabelText(/^id ·/), { target: { value: "9" } });
    fireEvent.change(screen.getByLabelText(/^api_token ·/), { target: { value: "s3cret" } });
    fireEvent.click(screen.getByRole("button", { name: t("runRoutineRun") }));
    expect(onRun).toHaveBeenCalled();
    expect(loadRoutineArgSets(scope)).toEqual([["9", ""]]);
    expect(localStorage.length).toBe(0);
  });

  it("履歴が無ければ選択欄を出さない", async () => {
    clearRoutineArgMemory();
    getRoutineSignature.mockResolvedValue(signature);
    renderModal({ profileId: "p1" });
    await screen.findByLabelText(/^id ·/);
    expect(screen.queryByLabelText(t("runRoutineHistoryLabel"))).not.toBeInTheDocument();
  });
});
