import { describe, it, expect, vi, beforeEach } from "vitest";

// バイナリ IPC (#1258)。`write_binary_file` は raw ボディ + パスヘッダ、
// `read_binary_file` / `fetch_cell_bytes` は生バイト (ArrayBuffer) で往復する。
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { api } from "../api/tauri";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("writeBinaryFile", () => {
  it("送るのは Uint8Array のままの raw ボディで、パスは ASCII の URL エンコードでヘッダに載る", async () => {
    mockInvoke.mockResolvedValue(3);
    const data = new Uint8Array([1, 2, 255]);
    const path = "C:\\Users\\太郎\\図 1+2%.png";
    await expect(api.writeBinaryFile(path, data)).resolves.toBe(3);

    const [cmd, body, options] = mockInvoke.mock.calls[0];
    expect(cmd).toBe("write_binary_file");
    expect(body).toBe(data);
    const header = (options as { headers: Record<string, string> }).headers["x-noobdb-path"];
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(decodeURIComponent(header)).toBe(path);
  });
});

describe("writeTextFile", () => {
  it("文字列のまま path / content を送る", async () => {
    mockInvoke.mockResolvedValue(12);
    await expect(api.writeTextFile("/tmp/a.sql", "SELECT 'あ';")).resolves.toBe(12);
    expect(mockInvoke).toHaveBeenCalledWith(
      "write_text_file",
      { path: "/tmp/a.sql", content: "SELECT 'あ';" },
    );
  });
});

describe("readBinaryFile / fetchCellBytes", () => {
  it("ArrayBuffer を Uint8Array として返す", async () => {
    mockInvoke.mockResolvedValue(new Uint8Array([0, 255, 16]).buffer);
    const bytes = await api.readBinaryFile("/tmp/x.bin");
    expect(Array.from(bytes)).toEqual([0, 255, 16]);

    mockInvoke.mockResolvedValue(new Uint8Array([9, 8]).buffer);
    const cell = await api.fetchCellBytes("s1", null, "t", "data", [{ column: "id", value: 1 }]);
    expect(Array.from(cell)).toEqual([9, 8]);
    expect(mockInvoke.mock.calls[1][0]).toBe("fetch_cell_bytes");
  });

  it("バイナリでない応答は契約違反として reject する", async () => {
    mockInvoke.mockResolvedValue("00ff");
    await expect(api.readBinaryFile("/tmp/x.bin")).rejects.toThrow(/バイナリ/);
  });
});

describe("probeCellBlob / saveCellToFile", () => {
  it("probe の応答をスキーマ検証し、NULL は null", async () => {
    mockInvoke.mockResolvedValueOnce({ size: 10, mime: "image/png", ext: "png", image: true });
    await expect(api.probeCellBlob("s1", null, "t", "c", [])).resolves.toEqual({
      size: 10,
      mime: "image/png",
      ext: "png",
      image: true,
    });
    mockInvoke.mockResolvedValueOnce(null);
    await expect(api.probeCellBlob("s1", null, "t", "c", [])).resolves.toBeNull();
    mockInvoke.mockResolvedValueOnce({ size: "x" });
    await expect(api.probeCellBlob("s1", null, "t", "c", [])).rejects.toThrow();
  });

  it("save_cell_to_file はパスを含む引数を送り、書き込みバイト数を返す", async () => {
    mockInvoke.mockResolvedValue(42);
    await expect(
      api.saveCellToFile("s1", "db", "t", "c", [{ column: "id", value: 1 }], "/tmp/o.png"),
    ).resolves.toBe(42);
    expect(mockInvoke.mock.calls[0][1]).toMatchObject({ path: "/tmp/o.png", column: "c" });
  });
});
