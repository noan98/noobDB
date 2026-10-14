import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "../theme";
import { ToastProvider } from "../components/Toast";
import { renderHook, waitFor } from "./testUtils";
import { t } from "../i18n";
import type { Column } from "../api/tauri";

/**
 * 複数行の BLOB をフォルダへ一括保存するハンドラ (#1539)。主キーで引けない行は飛ばし、
 * フォルダ選択をキャンセルしたら何も呼ばないこと、結果の件数が通知されることを固定する。
 */
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: openMock, save: vi.fn() }));
vi.mock("../api/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/tauri")>();
  return {
    ...actual,
    api: { ...actual.api, saveCellsToFolder: vi.fn() },
  };
});

import { useCellBlobIo } from "../components/useCellBlobIo";
import { api } from "../api/tauri";

const columns: Column[] = [
  { name: "id", type_name: "INT" },
  { name: "data", type_name: "BLOB" },
];
const wrapper = ({ children }: { children: ReactNode }) => (
  <ChakraProvider value={system}>
    <ToastProvider>{children}</ToastProvider>
  </ChakraProvider>
);

function setup(rows: (number | null | string)[][]) {
  return renderHook(
    () =>
      useCellBlobIo({
        config: { sessionId: "s1" },
        database: "app",
        table: "files",
        columns,
        rows,
        pkIndices: [0],
        isBinaryColumn: (c) => c === 1,
      }),
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useCellBlobIo saveMany (#1539)", () => {
  it("主キーで引ける行だけをフォルダ保存に送り、件数を通知する", async () => {
    openMock.mockResolvedValue("/tmp/out");
    vi.mocked(api.saveCellsToFolder).mockResolvedValue({
      saved: 2,
      totalBytes: 2048,
      skippedNull: 0,
      skippedTooLarge: 0,
      failed: 0,
      errors: [],
    });
    const { result } = setup([
      [1, "00"],
      [null, "00"], // 主キーが NULL の行は引けない
      [3, "00"],
    ]);
    const handlers = result.current(0, 1);
    expect(handlers?.saveMany).toBeTypeOf("function");
    await handlers?.saveMany?.([0, 1, 2]);
    expect(api.saveCellsToFolder).toHaveBeenCalledWith(
      "s1",
      "app",
      "files",
      "data",
      [[{ column: "id", value: 1 }], [{ column: "id", value: 3 }]],
      "/tmp/out",
    );
    await waitFor(() =>
      expect(
        document.body.textContent?.includes(
          t("blobFolderSaved", { saved: 2, size: "2.0 KiB", skipped: 1, failed: 0, folder: "/tmp/out" }),
        ),
      ).toBe(true),
    );
  });

  it("フォルダ選択をキャンセルしたら何も呼ばない", async () => {
    openMock.mockResolvedValue(null);
    const { result } = setup([
      [1, "00"],
      [2, "00"],
    ]);
    await result.current(0, 1)?.saveMany?.([0, 1]);
    expect(api.saveCellsToFolder).not.toHaveBeenCalled();
  });

  it("どの行も主キーで引けないときは保存せずエラーを出す", async () => {
    const { result } = setup([
      [null, "00"],
      [null, "00"],
    ]);
    // キーが NULL の行しか無いのでハンドラ自体が作られない (導線ごと出さない)。
    expect(result.current(0, 1)).toBeUndefined();
    expect(api.saveCellsToFolder).not.toHaveBeenCalled();
  });
});
