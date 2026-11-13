import { describe, it, expect, vi } from "vitest";
import { createSessionPool } from "../sessionPool";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSessionPool (#2300)", () => {
  it("接続中の同一キー要求は 1 回の connect を共有する", async () => {
    const pool = createSessionPool(vi.fn().mockResolvedValue(undefined));
    const d = deferred<string>();
    const connect = vi.fn(() => d.promise);
    const a = pool.acquire("p", connect);
    const b = pool.acquire("p", connect);
    d.resolve("s1");
    expect(await a).toBe("s1");
    expect(await b).toBe("s1");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("失敗したキーは再要求で改めて接続する", async () => {
    const pool = createSessionPool(vi.fn().mockResolvedValue(undefined));
    const connect = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValueOnce("s2");
    await expect(pool.acquire("p", connect)).rejects.toThrow("x");
    expect(await pool.acquire("p", connect)).toBe("s2");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("release は完了済みを切断し、接続中のものは完了後に切断する", async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const pool = createSessionPool(disconnect);
    await pool.acquire("a", async () => "sa");
    const d = deferred<string>();
    const pending = pool.acquire("b", () => d.promise);
    pool.release();
    await Promise.resolve();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledWith("sa");
    d.resolve("sb");
    await expect(pending).rejects.toThrow();
    expect(disconnect).toHaveBeenCalledWith("sb");
    expect(disconnect).toHaveBeenCalledTimes(2);
  });
});
