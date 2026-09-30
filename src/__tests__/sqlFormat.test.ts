import { afterEach, describe, expect, it, vi } from "vitest";
import { format } from "sql-formatter";

// SQL 整形の Worker 化 (#1256)。jsdom には Worker が無いので、フォールバック (メイン
// スレッド実行) が従来の同期整形と同じ結果を返すことと、Worker が使える環境では
// Worker へ依頼して結果を受け取る/失敗したらメインスレッドへ切り替えることを固定する。

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const SQL = "select a,b from t where x=1 and y in (select id from u) order by a";

describe("formatSqlAsync — Worker が無い環境 (フォールバック)", () => {
  it.each([
    ["mysql", "mysql"],
    ["postgres", "postgresql"],
    ["sqlite", "sqlite"],
  ] as const)("%s: 同期の sql-formatter と同じ結果になる", async (driver, language) => {
    const { formatSqlAsync } = await import("../components/sqlFormat");
    expect(await formatSqlAsync(SQL, driver)).toBe(format(SQL, { language }));
  });

  it("整形できない入力は reject する (メッセージは sql-formatter のもの)", async () => {
    const { formatSqlAsync } = await import("../components/sqlFormat");
    await expect(formatSqlAsync("select 'unterminated", "mysql")).rejects.toThrow();
  });
});

describe("formatSqlAsync — Worker が使える環境", () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static mode: "ok" | "crash" = "ok";
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    terminated = false;
    constructor() {
      FakeWorker.instances.push(this);
    }
    postMessage(req: { id: number; text: string; language: string }) {
      if (FakeWorker.mode === "crash") {
        queueMicrotask(() => this.onerror?.());
        return;
      }
      queueMicrotask(() =>
        this.onmessage?.({
          data: { id: req.id, ok: true, result: `worker:${req.language}:${req.text}` },
        } as MessageEvent),
      );
    }
    terminate() {
      this.terminated = true;
    }
  }

  it("Worker へ依頼して結果を受け取る (メインスレッドでは整形しない)", async () => {
    FakeWorker.instances = [];
    FakeWorker.mode = "ok";
    vi.stubGlobal("Worker", FakeWorker);
    const { formatSqlAsync } = await import("../components/sqlFormat");
    expect(await formatSqlAsync("select 1", "postgres")).toBe("worker:postgresql:select 1");
    expect(await formatSqlAsync("select 2", "sqlite")).toBe("worker:sqlite:select 2");
    // ワーカーは使い回す。
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("Worker が異常終了したら、待っていた要求をメインスレッドでやり直す", async () => {
    FakeWorker.instances = [];
    FakeWorker.mode = "crash";
    vi.stubGlobal("Worker", FakeWorker);
    const { formatSqlAsync } = await import("../components/sqlFormat");
    expect(await formatSqlAsync(SQL, "mysql")).toBe(format(SQL, { language: "mysql" }));
    expect(FakeWorker.instances[0].terminated).toBe(true);
    // 以後は Worker を作り直さずメインスレッドで実行する。
    expect(await formatSqlAsync(SQL, "sqlite")).toBe(format(SQL, { language: "sqlite" }));
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
