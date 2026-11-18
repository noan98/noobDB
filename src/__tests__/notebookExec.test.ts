import { beforeEach, describe, expect, it, vi } from "vitest";

const runQueryStream = vi.fn();
vi.mock("../api/tauri", () => ({
  api: { runQueryStream: (...a: unknown[]) => runQueryStream(...a), cancelStream: vi.fn() },
  listenQueryStream: vi.fn().mockResolvedValue(() => {}),
}));

import type { ConnectionProfile } from "../api/tauri";
import { evaluateDdlGate } from "../ddlGate";
import {
  notebookInTransaction,
  NotebookRunError,
  resolveNotebookDatabase,
  resolveNotebookRunTarget,
  schemaInvalidationFor,
  runNotebookStatements,
  runStatementCollect,
  type NotebookRunIo,
  type NotebookRunOutput,
  type NotebookRunTargetState,
} from "../notebookExec";

function out(over: Partial<NotebookRunOutput> = {}): NotebookRunOutput {
  return {
    columns: [],
    rows: [],
    totalRows: 0,
    rowsAffected: 0,
    hasColumns: true,
    elapsedMs: 5,
    serverMessages: undefined,
    readOnly: false,
    schemaMayChange: false,
    appliedAutoLimit: null,
    ...over,
  };
}

function makeIo(over: Partial<NotebookRunIo> = {}): NotebookRunIo {
  return {
    gate: vi.fn().mockResolvedValue(true),
    isTransaction: () => false,
    runInTransaction: vi.fn().mockResolvedValue(out()),
    runStream: vi.fn().mockResolvedValue(out()),
    onBegin: vi.fn(),
    onEnd: vi.fn(),
    onStatementDone: vi.fn(),
    onStatementError: vi.fn(),
    ...over,
  };
}

describe("runNotebookStatements (#2380)", () => {
  it("ゲートを取りやめたら何も実行せず null", async () => {
    const io = makeIo({ gate: vi.fn().mockResolvedValue(false) });
    const r = await runNotebookStatements(
      "DELETE FROM t",
      ["DELETE FROM t"],
      { onStart: vi.fn(), isCancelled: () => false },
      io,
    );
    expect(r).toBeNull();
    expect(io.runStream).not.toHaveBeenCalled();
    expect(io.onBegin).not.toHaveBeenCalled();
    expect(io.onEnd).not.toHaveBeenCalled();
  });

  it("複数文の間で中止を見て、続きを実行しない", async () => {
    let cancelled = false;
    const io = makeIo({
      runStream: vi.fn().mockImplementation(async () => {
        cancelled = true;
        return out();
      }),
    });
    await expect(
      runNotebookStatements("a;b", ["a", "b"], { onStart: vi.fn(), isCancelled: () => cancelled }, io),
    ).rejects.toMatchObject({ cancelled: true });
    expect(io.runStream).toHaveBeenCalledTimes(1);
    expect(io.onStatementError).not.toHaveBeenCalled();
    expect(io.onBegin).toHaveBeenCalledTimes(1);
    expect(io.onEnd).toHaveBeenCalledWith("cancelled");
  });

  it("トランザクション中は runInTransaction を使う", async () => {
    const io = makeIo({ isTransaction: () => true });
    await runNotebookStatements("a", ["a"], { onStart: vi.fn(), isCancelled: () => false }, io);
    expect(io.runInTransaction).toHaveBeenCalledTimes(1);
    expect(io.runStream).not.toHaveBeenCalled();
  });

  it("経過時間は合算し、結果セットを返した最後の文の結果を返す", async () => {
    const io = makeIo({
      runStream: vi
        .fn()
        .mockResolvedValueOnce(out({ totalRows: 3, elapsedMs: 10 }))
        .mockResolvedValueOnce(out({ hasColumns: false, rowsAffected: 1, elapsedMs: 4 })),
    });
    const r = await runNotebookStatements(
      "a;b",
      ["a", "b"],
      { onStart: vi.fn(), isCancelled: () => false },
      io,
    );
    expect(r?.totalRows).toBe(3);
    expect(r?.elapsedMs).toBe(14);
  });

  it("失敗は onStatementError に通して再送出する", async () => {
    const io = makeIo({
      runStream: vi.fn().mockRejectedValue(new NotebookRunError("boom", false, false, false)),
    });
    await expect(
      runNotebookStatements("a", ["a"], { onStart: vi.fn(), isCancelled: () => false }, io),
    ).rejects.toThrow("boom");
    expect(io.onStatementError).toHaveBeenCalledTimes(1);
    expect(io.onEnd).toHaveBeenCalledWith("error");
  });

  it("ストリームが中止で返ったときも終了通知を出す (onStatementError は呼ばない)", async () => {
    const io = makeIo({
      runStream: vi.fn().mockRejectedValue(new NotebookRunError("cancelled", false, false, true)),
    });
    await expect(
      runNotebookStatements("a", ["a"], { onStart: vi.fn(), isCancelled: () => false }, io),
    ).rejects.toMatchObject({ cancelled: true });
    expect(io.onBegin).toHaveBeenCalledTimes(1);
    expect(io.onEnd).toHaveBeenCalledWith("cancelled");
    expect(io.onStatementError).not.toHaveBeenCalled();
  });
});

describe("resolveNotebookDatabase (#2380)", () => {
  it("MySQL は空ならプロファイルの DB へ寄せる (別タブの USE を引きずらない)", () => {
    expect(resolveNotebookDatabase(null, "mysql", "prod")).toBe("prod");
    expect(resolveNotebookDatabase("stg", "mysql", "prod")).toBe("stg");
  });
  it("PostgreSQL は空なら null (database 引数はスキーマなので DB 名を渡さない)", () => {
    expect(resolveNotebookDatabase(null, "postgres", "appdb")).toBeNull();
    expect(resolveNotebookDatabase("audit", "postgres", "appdb")).toBe("audit");
  });
  it("SQLite は空ならプロファイルの値、無ければ null", () => {
    expect(resolveNotebookDatabase(null, "sqlite", "main.db")).toBe("main.db");
    expect(resolveNotebookDatabase(null, "sqlite", null)).toBeNull();
    expect(resolveNotebookDatabase(null, undefined, undefined)).toBeNull();
  });
});

describe("runStatementCollect (#2380)", () => {
  beforeEach(() => {
    runQueryStream.mockReset();
    runQueryStream.mockResolvedValue(undefined);
  });

  it("フライトレコーダ用の capture と database をそのまま run_query_stream へ渡す", async () => {
    void runStatementCollect({
      sessionId: "s1",
      database: "public",
      sql: "UPDATE t SET a = 1",
      rowCap: 200,
      initialBatch: 100,
      chunkSize: 500,
      autoLimit: null,
      queryTimeoutSecs: null,
      capture: true,
      captureRowCap: 1000,
      captureRetentionDays: 7,
    }).catch(() => {});
    await vi.waitFor(() => expect(runQueryStream).toHaveBeenCalled());
    expect(runQueryStream.mock.calls[0][0]).toMatchObject({
      capture: true,
      database: "public",
      forceReadOnly: false,
    });
  });
});

describe("resolveNotebookRunTarget / notebookInTransaction (#2396)", () => {
  const mk = (id: string, driver: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      name: id,
      driver,
      database: "db",
      is_production: false,
      confirm_writes: false,
      read_only: false,
      ...over,
    }) as unknown as ConnectionProfile;
  const my = mk("my", "mysql", { is_production: true, confirm_writes: true });
  const pg = mk("pg", "postgres", { read_only: true });
  const lite = mk("lite", "sqlite");
  const open = [
    { sessionId: "s-my", profile: my },
    { sessionId: "s-pg", profile: pg },
    { sessionId: "s-lite", profile: lite },
  ];
  const state = (activeId: "s-my" | "s-pg" | "s-lite", over: Partial<NotebookRunTargetState> = {}) => {
    const entry = open.find((o) => o.sessionId === activeId);
    return {
      activeSessionId: activeId,
      activeProfile: entry?.profile ?? null,
      profiles: [] as ConnectionProfile[],
      openConnections: open,
      emergencySessions: new Set<string>(),
      txOwner: activeId,
      txActive: false,
      txBySessionHas: () => false,
      ...over,
    } satisfies NotebookRunTargetState;
  };

  it("3 ドライバの接続ごとに、そのセッションのプロファイル設定 (本番 + confirm_writes / read_only) を返す", () => {
    const t1 = resolveNotebookRunTarget({ profileId: "my", sessionId: "s-my" }, state("s-lite"));
    expect(t1).toMatchObject({ sid: "s-my", isActive: false });
    expect(t1?.profile).toMatchObject({ driver: "mysql", is_production: true, confirm_writes: true });
    const t2 = resolveNotebookRunTarget({ profileId: "pg", sessionId: "s-pg" }, state("s-lite"));
    expect(t2?.profile).toMatchObject({ driver: "postgres", read_only: true, is_production: false });
    const t3 = resolveNotebookRunTarget({ profileId: "lite", sessionId: "s-lite" }, state("s-lite"));
    expect(t3).toMatchObject({ isActive: true });
    expect(t3?.profile.driver).toBe("sqlite");
  });

  it("アクティブ接続が切り替わっても、要求した組の接続で実行する (回帰)", () => {
    const req = { profileId: "my", sessionId: "s-my" };
    expect(resolveNotebookRunTarget(req, state("s-pg"))).toMatchObject({ sid: "s-my", isActive: false });
    expect(resolveNotebookRunTarget(req, state("s-my"))).toMatchObject({ sid: "s-my", isActive: true });
  });

  it("実在しない組 (別プロファイルのセッション / 閉じたセッション / 未知の ID) は拒否する", () => {
    const s = state("s-my");
    expect(resolveNotebookRunTarget({ profileId: "pg", sessionId: "s-my" }, s)).toBeNull();
    expect(resolveNotebookRunTarget({ profileId: "my", sessionId: "s-pg" }, s)).toBeNull();
    expect(resolveNotebookRunTarget({ profileId: "my", sessionId: "s-gone" }, s)).toBeNull();
    expect(resolveNotebookRunTarget({ profileId: "nope", sessionId: "s-nope" }, s)).toBeNull();
  });

  it("両方にあるとき、判定に使うプロファイルは最新側 (アクティブは activeProfile、背景は profiles)", () => {
    // openConnections 側は接続時点の古い設定 (confirm_writes: false)、新しい側は編集保存後 (true)
    const stale = mk("x", "mysql", { confirm_writes: false, is_production: false });
    const fresh = mk("x", "mysql", { confirm_writes: true, is_production: true });
    const base = {
      ...state("s-lite"),
      openConnections: [{ sessionId: "s-x", profile: stale }],
      profiles: [fresh],
    };
    // 背景接続: 保存済み profiles の最新
    const bg = resolveNotebookRunTarget({ profileId: "x", sessionId: "s-x" }, base);
    expect(bg).toMatchObject({ isActive: false });
    expect(bg?.profile).toMatchObject({ confirm_writes: true, is_production: true });
    // アクティブ接続: activeProfile の最新 (profiles に無くても)
    const act = resolveNotebookRunTarget(
      { profileId: "x", sessionId: "s-x" },
      { ...base, activeSessionId: "s-x", activeProfile: fresh, profiles: [] },
    );
    expect(act).toMatchObject({ isActive: true });
    expect(act?.profile).toMatchObject({ confirm_writes: true, is_production: true });
    // 保存一覧に無い派生接続は開いている側
    const derived = resolveNotebookRunTarget({ profileId: "x", sessionId: "s-x" }, { ...base, profiles: [] });
    expect(derived?.profile).toMatchObject({ confirm_writes: false });
  });

  it("開いている接続に無い組は、アクティブでも拒否する", () => {
    const s = state("s-my", { openConnections: [] });
    expect(resolveNotebookRunTarget({ profileId: "my", sessionId: "s-my" }, s)).toBeNull();
  });

  it("緊急モードは接続ごと", () => {
    const s = state("s-lite", { emergencySessions: new Set(["s-pg"]) });
    expect(resolveNotebookRunTarget({ profileId: "pg", sessionId: "s-pg" }, s)?.emergency).toBe(true);
    expect(resolveNotebookRunTarget({ profileId: "my", sessionId: "s-my" }, s)?.emergency).toBe(false);
  });

  it("トランザクション判定: アクティブは state、背景は退避した状態を見る", () => {
    const s = state("s-lite", { txActive: true, txBySessionHas: (id) => id === "s-pg" });
    expect(notebookInTransaction("s-lite", s)).toBe(true);
    expect(notebookInTransaction("s-pg", s)).toBe(true);
    expect(notebookInTransaction("s-my", s)).toBe(false);
    expect(resolveNotebookRunTarget({ profileId: "pg", sessionId: "s-pg" }, s)?.inTx).toBe(true);
  });

  it("確認ゲートは解決した接続の設定で変わる (本番 + confirm_writes / read_only / 緊急)", () => {
    const sql = "DELETE FROM orders";
    const gateFor = (id: string, sid: string, emergencySessions = new Set<string>()) => {
      const t = resolveNotebookRunTarget(
        { profileId: id, sessionId: sid },
        state("s-lite", { emergencySessions }),
      );
      if (!t) throw new Error("unresolved");
      return evaluateDdlGate({
        sql,
        driver: t.profile.driver,
        isProduction: t.profile.is_production,
        confirmWrites: t.profile.confirm_writes,
        readOnly: t.profile.read_only,
        emergencyMode: t.emergency,
        confirmDangerousQueries: false,
      });
    };
    expect(gateFor("my", "s-my")?.writeApproval).toBe(true);
    expect(gateFor("pg", "s-pg")).toBeNull();
    expect(gateFor("lite", "s-lite")).toBeNull();
    expect(gateFor("lite", "s-lite", new Set(["s-lite"]))?.writeApproval).toBe(true);
  });
});

describe("schemaInvalidationFor (#2396)", () => {
  it("実行セッションが今のアクティブと同じなら、そのセッションの DB のキーだけを消す", () => {
    expect(schemaInvalidationFor("s-b", "s-b", "app")).toEqual({
      kind: "one",
      sessionId: "s-b",
      database: "app",
    });
  });

  it("実行中にアクティブが切り替わっても、開始時のセッション (A) のキーは作らない (回帰)", () => {
    // 背景の B で DDL を開始 → B がアクティブになった後に完了: 固定した sid (B) で判定する
    expect(schemaInvalidationFor("s-b", "s-b", "app")).toMatchObject({ sessionId: "s-b" });
    // 逆向き: A のセルの完了時には B がアクティブ → 別セッションなので全消し (A のキーを B のものとして扱わない)
    expect(schemaInvalidationFor("s-a", "s-b", "app")).toEqual({ kind: "all" });
  });

  it("DB が無い / アクティブが無いときは全消し", () => {
    expect(schemaInvalidationFor("s-a", "s-a", null)).toEqual({ kind: "all" });
    expect(schemaInvalidationFor("s-a", null, "app")).toEqual({ kind: "all" });
  });
});
