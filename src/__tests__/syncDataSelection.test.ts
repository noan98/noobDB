import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("../api/invoke", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { syncCommands } from "../api/commands/sync";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ statements: [], warnings: [] });
});

describe("generateDataSyncSql の行の絞り込み (#1625)", () => {
  it("絞り込み無しなら kinds / onlyKeys は null (全行)", async () => {
    await syncCommands.generateDataSyncSql("d1", false);
    expect(invoke).toHaveBeenCalledWith("generate_data_sync_sql", {
      diffId: "d1",
      allowDelete: false,
      skipKeys: null,
      kinds: null,
      onlyKeys: null,
    });
  });

  it("種別と主キーをそのまま送る (空配列は 0 行の意味で null にしない)", async () => {
    await syncCommands.generateDataSyncSql("d1", true, null, {
      kinds: ["source_only"],
      onlyKeys: [],
    });
    expect(invoke).toHaveBeenCalledWith("generate_data_sync_sql", {
      diffId: "d1",
      allowDelete: true,
      skipKeys: null,
      kinds: ["source_only"],
      onlyKeys: [],
    });
  });
});
