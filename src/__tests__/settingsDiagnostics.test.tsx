import { describe, it, expect, vi } from "vitest";
import { saveDiagnosticBundle } from "../components/diagnosticBundle";

/**
 * 診断バンドルの書き出し手順 (#1622)。画面側の入口は settingsView.test.tsx で確認する。
 */
describe("saveDiagnosticBundle (#1622)", () => {
  it("選んだ場所へバンドル本文を書き、書いたパスを返す", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const build = vi.fn().mockResolvedValue("# bundle\napp_version: 1.2.3\n");
    const path = await saveDiagnosticBundle({ pickPath: async () => "/tmp/diag.txt", build, write });
    expect(path).toBe("/tmp/diag.txt");
    expect(write).toHaveBeenCalledWith("/tmp/diag.txt", expect.stringContaining("app_version: 1.2.3"));
  });

  it("保存ダイアログをキャンセルしたらバンドルを作らず、何も書かない", async () => {
    for (const picked of [null, undefined, ""]) {
      const write = vi.fn();
      const build = vi.fn();
      expect(await saveDiagnosticBundle({ pickPath: async () => picked, build, write })).toBeNull();
      expect(build).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("本文の生成に失敗したら書き込まずに例外を伝える", async () => {
    const write = vi.fn();
    await expect(
      saveDiagnosticBundle({
        pickPath: async () => "/tmp/x.txt",
        build: async () => {
          throw new Error("boom");
        },
        write,
      }),
    ).rejects.toThrow("boom");
    expect(write).not.toHaveBeenCalled();
  });
});
