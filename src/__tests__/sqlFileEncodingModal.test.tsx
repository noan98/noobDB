import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderWithProviders, screen, fireEvent, waitFor } from "./testUtils";
import { SqlFileEncodingModal } from "../components/SqlFileEncodingModal";
import { t } from "../i18n";

/**
 * SQL ファイルの文字コード指定モーダル (#1535)。#1627 で、開くときの判定結果と候補ごとの
 * 先頭行のプレビュー、保存時の改行コード選択を足した。
 */
const { openMock, previewMock } = vi.hoisted(() => ({ openMock: vi.fn(), previewMock: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, save: vi.fn() }));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return { ...actual, api: { ...actual.api, previewSqlFileEncodings: previewMock } };
});

beforeEach(() => {
  openMock.mockReset();
  previewMock.mockReset();
});

describe("SqlFileEncodingModal: 開く (#1627)", () => {
  it("判定結果と候補の先頭行を並べ、選んだ文字コードでファイルを開く", async () => {
    openMock.mockResolvedValue("/tmp/a.sql");
    previewMock.mockResolvedValue({
      detected: "shift_jis",
      detectError: null,
      candidates: [
        { encoding: "utf-8", valid: false, lines: ["SELECT '�';"] },
        { encoding: "shift_jis", valid: true, lines: ["SELECT '日本語';"] },
      ],
    });
    const onConfirmFile = vi.fn();
    renderWithProviders(
      <SqlFileEncodingModal
        mode="open"
        onConfirm={vi.fn()}
        onConfirmFile={onConfirmFile}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("sqlFileEncodingPreviewPick") }));
    await screen.findByText(t("sqlFileEncodingDetected", { encoding: "Shift_JIS" }));
    expect(screen.getByText("SELECT '日本語';")).toBeInTheDocument();
    expect(screen.getByText(t("sqlFileEncodingInvalidBytes"))).toBeInTheDocument();
    // 既定は判定結果。
    fireEvent.click(
      screen.getByRole("button", { name: t("sqlFileEncodingOpenWith", { encoding: "Shift_JIS" }) }),
    );
    expect(onConfirmFile).toHaveBeenCalledWith("/tmp/a.sql", "shift_jis");
  });

  it("候補を選び直すと、その文字コードで開く", async () => {
    openMock.mockResolvedValue("/tmp/a.sql");
    previewMock.mockResolvedValue({
      detected: "shift_jis",
      detectError: null,
      candidates: [
        { encoding: "utf-8", valid: true, lines: ["x"] },
        { encoding: "shift_jis", valid: true, lines: ["y"] },
      ],
    });
    const onConfirmFile = vi.fn();
    renderWithProviders(
      <SqlFileEncodingModal
        mode="open"
        onConfirm={vi.fn()}
        onConfirmFile={onConfirmFile}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("sqlFileEncodingPreviewPick") }));
    await screen.findByRole("radiogroup");
    fireEvent.click(screen.getByRole("radio", { name: /UTF-8/ }));
    fireEvent.click(
      screen.getByRole("button", { name: t("sqlFileEncodingOpenWith", { encoding: "UTF-8" }) }),
    );
    expect(onConfirmFile).toHaveBeenCalledWith("/tmp/a.sql", "utf-8");
  });

  it("判定できなかったときは警告を出し、不正の無い最初の候補を既定にする", async () => {
    openMock.mockResolvedValue("/tmp/a.sql");
    previewMock.mockResolvedValue({
      detected: null,
      detectError: "bad bytes",
      candidates: [
        { encoding: "utf-8", valid: false, lines: ["?"] },
        { encoding: "euc-jp", valid: true, lines: ["ok"] },
      ],
    });
    renderWithProviders(<SqlFileEncodingModal mode="open" onConfirm={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("sqlFileEncodingPreviewPick") }));
    await screen.findByText(t("sqlFileEncodingDetectFailed", { error: "bad bytes" }));
    expect(
      screen.getByRole("button", { name: t("sqlFileEncodingOpenWith", { encoding: "EUC-JP" }) }),
    ).toBeEnabled();
  });

  it("ファイル選択をキャンセルしたら何も表示しない", async () => {
    openMock.mockResolvedValue(null);
    renderWithProviders(<SqlFileEncodingModal mode="open" onConfirm={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("sqlFileEncodingPreviewPick") }));
    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(previewMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });
});

describe("SqlFileEncodingModal: 保存 (#1627)", () => {
  it("改行コードを選べ、既定はタブが覚えている値", () => {
    const onConfirm = vi.fn();
    renderWithProviders(
      <SqlFileEncodingModal
        mode="save"
        initial="shift_jis"
        initialLineEnding="crlf"
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(t("sqlFileLineEndingLabel")) as HTMLSelectElement;
    expect(select.value).toBe("crlf");
    fireEvent.change(select, { target: { value: "lf" } });
    fireEvent.click(screen.getByRole("button", { name: t("sqlFileEncodingSave") }));
    expect(onConfirm).toHaveBeenCalledWith("shift_jis", "lf");
  });

  it("開くモードには改行コードの選択を出さない", () => {
    renderWithProviders(<SqlFileEncodingModal mode="open" onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(t("sqlFileLineEndingLabel"))).not.toBeInTheDocument();
  });
});
