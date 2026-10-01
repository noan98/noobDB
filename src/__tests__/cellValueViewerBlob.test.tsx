import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { renderWithProviders, screen, waitFor } from "./testUtils";
import { CellValueViewer } from "../components/CellValueViewer";
import type { CellBlobHandlers } from "../components/useCellBlobIo";
import { t } from "../i18n";

/**
 * BLOB プレビュー (#1258)。サイズと種別は probe だけで取り、本体のバイナリ取得は
 * 画像 (かつ上限以下) のときに限る。
 */
function handlers(over: Partial<CellBlobHandlers>): CellBlobHandlers {
  return {
    probe: vi.fn().mockResolvedValue(null),
    fetchBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    save: vi.fn(),
    ...over,
  };
}

let created: string[] = [];
beforeEach(() => {
  created = [];
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
    const url = `blob:test-${created.length}-${(b as Blob).type}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(async () => {
  // ダイアログを閉じると focus-trap (zag) が `setTimeout(fn, 0)` でフォーカス復帰を予約する。
  // 共通 setup の cleanup より先にここで閉じ、その 0ms タイマーを jsdom が生きている間に
  // 消化しておく (負荷が高いとテスト環境の破棄が先に走り `document is not defined` の
  // 未処理エラーで vitest が失敗するため)。
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.restoreAllMocks();
});

describe("CellValueViewer BLOB preview (#1258)", () => {
  it("非画像は probe だけでサイズと種別を出し、本体は取得しない", async () => {
    const blob = handlers({
      probe: vi.fn().mockResolvedValue({ size: 2048, mime: "application/pdf", ext: "pdf", image: false }),
    });
    renderWithProviders(
      <CellValueViewer columnName="doc" value="255044462d" isBinary blob={blob} onClose={() => {}} />,
    );
    expect(await screen.findByText(/application\/pdf · 2\.0 KiB/)).toBeInTheDocument();
    expect(blob.fetchBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("画像は本体をバイナリで取得して Blob URL のプレビューを出す", async () => {
    const blob = handlers({
      probe: vi.fn().mockResolvedValue({ size: 3, mime: "image/png", ext: "png", image: true }),
    });
    renderWithProviders(
      <CellValueViewer columnName="pic" value="89504e47" isBinary blob={blob} onClose={() => {}} />,
    );
    const img = await screen.findByRole("img");
    await waitFor(() => expect(img.getAttribute("src")).toContain("blob:test-0-image/png"));
    expect(blob.fetchBytes).toHaveBeenCalledOnce();
  });

  it("上限を超える画像はサイズと種別だけ出し、本体は取得しない", async () => {
    const blob = handlers({
      probe: vi
        .fn()
        .mockResolvedValue({ size: 9 * 1024 * 1024, mime: "image/jpeg", ext: "jpg", image: true }),
    });
    renderWithProviders(
      <CellValueViewer columnName="pic" value="ffd8ff" isBinary blob={blob} onClose={() => {}} />,
    );
    expect(await screen.findByText(/image\/jpeg · 9\.0 MiB/)).toBeInTheDocument();
    expect(blob.fetchBytes).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("種別不明は不明表示、probe の失敗はエラー表示", async () => {
    const unknown = handlers({
      probe: vi.fn().mockResolvedValue({ size: 10, mime: null, ext: null, image: false }),
    });
    const { unmount } = renderWithProviders(
      <CellValueViewer columnName="x" value="00" isBinary blob={unknown} onClose={() => {}} />,
    );
    expect(await screen.findByText(new RegExp(`${t("blobKindUnknown")} · 10 B`))).toBeInTheDocument();
    unmount();

    const failing = handlers({ probe: vi.fn().mockRejectedValue(new Error("boom")) });
    renderWithProviders(
      <CellValueViewer columnName="x" value="00" isBinary blob={failing} onClose={() => {}} />,
    );
    expect(
      await screen.findByText(t("blobFetchFailed", { error: "Error: boom" })),
    ).toBeInTheDocument();
  });
});
