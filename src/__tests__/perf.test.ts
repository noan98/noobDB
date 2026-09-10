import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPerfState,
  getRecentMetrics,
  isPerfEnabled,
  markFirstRow,
  markGridCommit,
  markQueryDone,
  markQueryStart,
} from "../perf";

// 開発用パフォーマンス計測 (#1094)。既定 OFF・SQL/セルデータを保持しない・
// 計測 OFF 時は完全に no-op であることを固定する。

const STORAGE_KEY = "noobdb.perf.enabled";

function enablePerf() {
  localStorage.setItem(STORAGE_KEY, "1");
}

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  clearPerfState();
});

afterEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  clearPerfState();
});

describe("isPerfEnabled", () => {
  it("既定では無効", () => {
    expect(isPerfEnabled()).toBe(false);
  });

  it("localStorage で明示的に有効化した場合のみ true", () => {
    enablePerf();
    expect(isPerfEnabled()).toBe(true);
  });

  it("'1' 以外の値は無効として扱う", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    expect(isPerfEnabled()).toBe(false);
  });
});

describe("計測 OFF (既定)", () => {
  it("markQueryStart / markFirstRow / markQueryDone / markGridCommit を呼んでも記録は残らない", () => {
    const streamId = "s-off";
    markQueryStart(streamId);
    markFirstRow(streamId);
    markQueryDone(streamId, { rows: 10, columns: 3, elapsedMs: 42 });
    markGridCommit(10);
    expect(getRecentMetrics()).toEqual([]);
  });
});

describe("計測 ON", () => {
  beforeEach(() => {
    enablePerf();
  });

  it("start → firstRow → done → gridCommit の一連で 1 件のメトリクスが記録される", () => {
    const streamId = "s-1";
    markQueryStart(streamId);
    markFirstRow(streamId);
    markQueryDone(streamId, { rows: 5, columns: 2, elapsedMs: 12 });
    markGridCommit(5);

    const metrics = getRecentMetrics();
    expect(metrics).toHaveLength(1);
    const m = metrics[0];
    expect(m.streamId).toBe(streamId);
    expect(m.rows).toBe(5);
    expect(m.columns).toBe(2);
    expect(m.backendElapsedMs).toBe(12);
    expect(m.ttfrMs).not.toBeNull();
    expect(m.ttfrMs).toBeGreaterThanOrEqual(0);
    expect(m.totalMs).toBeGreaterThanOrEqual(0);
    expect(m.gridCommitMs).toBeGreaterThanOrEqual(0);
    expect(m.ttiMs).toBeGreaterThanOrEqual(0);
  });

  it("markFirstRow が一度も呼ばれない場合、ttfrMs は null になる", () => {
    const streamId = "s-no-rows";
    markQueryStart(streamId);
    markQueryDone(streamId, { rows: 0, columns: 0, elapsedMs: 3 });
    markGridCommit(0);

    const [m] = getRecentMetrics();
    expect(m.ttfrMs).toBeNull();
  });

  it("markFirstRow の 2 回目以降の呼び出しは無視される (最初の到達時刻のみ記録)", () => {
    const streamId = "s-multi-batch";
    markQueryStart(streamId);
    markFirstRow(streamId);
    // 2 バッチ目・3 バッチ目でも呼ばれるが、記録される TTFR は最初の 1 回のみ。
    markFirstRow(streamId);
    markFirstRow(streamId);
    markQueryDone(streamId, { rows: 30, columns: 4, elapsedMs: 8 });
    markGridCommit(30);

    expect(getRecentMetrics()).toHaveLength(1);
  });

  it("markQueryDone / markFirstRow は markQueryStart していない streamId に対しては何もしない", () => {
    markFirstRow("unknown");
    markQueryDone("unknown", { rows: 1, columns: 1, elapsedMs: 1 });
    markGridCommit(1);
    expect(getRecentMetrics()).toEqual([]);
  });

  it("done を受け取っていないクエリに対する markGridCommit は記録しない", () => {
    markQueryStart("s-pending");
    markGridCommit(0);
    expect(getRecentMetrics()).toEqual([]);
  });

  it("同じクエリに対する 2 回目の markGridCommit は再カウントしない (再レンダー対策)", () => {
    const streamId = "s-rerender";
    markQueryStart(streamId);
    markQueryDone(streamId, { rows: 1, columns: 1, elapsedMs: 1 });
    markGridCommit(1);
    markGridCommit(1);
    expect(getRecentMetrics()).toHaveLength(1);
  });

  it("直近の記録は上限件数を超えると古いものから捨てられる", () => {
    for (let i = 0; i < 55; i++) {
      const streamId = `s-${i}`;
      markQueryStart(streamId);
      markQueryDone(streamId, { rows: i, columns: 1, elapsedMs: 1 });
      markGridCommit(i);
    }
    const metrics = getRecentMetrics();
    expect(metrics.length).toBeLessThanOrEqual(50);
    // 最新のものが残っている (先頭から捨てられる)。
    expect(metrics[metrics.length - 1]?.streamId).toBe("s-54");
  });

  it("メトリクスに SQL 本文やセルデータが含まれない (件数と時間のみ)", () => {
    const streamId = "s-no-secrets";
    markQueryStart(streamId);
    markQueryDone(streamId, { rows: 2, columns: 2, elapsedMs: 5 });
    markGridCommit(2);
    const [m] = getRecentMetrics();
    const keys = Object.keys(m).sort();
    expect(keys).toEqual(
      [
        "backendElapsedMs",
        "columns",
        "gridCommitMs",
        "rows",
        "startedAt",
        "streamId",
        "totalMs",
        "ttfrMs",
        "ttiMs",
      ].sort(),
    );
  });
});

describe("clearPerfState", () => {
  it("進行中の計測と直近ログを両方クリアする", () => {
    enablePerf();
    const streamId = "s-clear";
    markQueryStart(streamId);
    markQueryDone(streamId, { rows: 1, columns: 1, elapsedMs: 1 });
    markGridCommit(1);
    expect(getRecentMetrics()).toHaveLength(1);

    clearPerfState();
    expect(getRecentMetrics()).toEqual([]);

    // start していない (クリアされた) streamId への done/gridCommit は無視される。
    markQueryDone(streamId, { rows: 1, columns: 1, elapsedMs: 1 });
    markGridCommit(1);
    expect(getRecentMetrics()).toEqual([]);
  });
});
