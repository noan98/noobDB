import { describe, expect, it } from "vitest";
import { beginBatchRun, endBatchRun, isCurrentBatchRun, type BatchRunRegistry } from "../batchRunGuard";

describe("batchRunGuard (#1594)", () => {
  it("停止後に再実行すると、古い実行の通知は現在の実行として扱われない", () => {
    const reg: BatchRunRegistry = new Map();
    beginBatchRun(reg, "tab1", "old");
    endBatchRun(reg, "tab1"); // 停止
    beginBatchRun(reg, "tab1", "new"); // 再実行
    expect(isCurrentBatchRun(reg, "tab1", "old")).toBe(false);
    expect(isCurrentBatchRun(reg, "tab1", "new")).toBe(true);
  });

  it("他タブの実行や、終了済みの実行は現在ではない", () => {
    const reg: BatchRunRegistry = new Map();
    beginBatchRun(reg, "tab1", "a");
    expect(isCurrentBatchRun(reg, "tab2", "a")).toBe(false);
    endBatchRun(reg, "tab1");
    expect(isCurrentBatchRun(reg, "tab1", "a")).toBe(false);
  });
});
