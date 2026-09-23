import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEALTH_CHECK_CONCURRENCY,
  LATENCY_CRITICAL_MS,
  LATENCY_SLOW_MS,
  buildHealthRows,
  changedHealthSessions,
  checkAllConnections,
  createHealthProber,
  formatHealthTarget,
  healthStatusRole,
  isServerlessDriver,
  latencyLevel,
  probeConnectionHealth,
  pruneHealthResults,
  summarizeHealth,
  withTimeout,
  type HealthDeps,
  type HealthProbeResult,
  type HealthProfileLike,
  type HealthRow,
} from "../components/connectionHealth";

/**
 * 接続横断のヘルスダッシュボード (#1068) の純ロジック。
 *
 * 受け入れ条件のうち「1 接続の遅延/失敗が他接続の集計をブロックしない」
 * 「サーバを持たない接続は N/A で縮退」「未接続プロファイルへ勝手に接続しない」を
 * ここで固定する。
 */

const never = <T,>() => new Promise<T>(() => {});

function deps(overrides: Partial<HealthDeps> = {}): HealthDeps {
  let clock = 0;
  return {
    ping: async () => true,
    version: async () => "8.0.36",
    connections: async () => 12,
    // 呼ばれるたびに 7ms 進む時計 (ping の前後で 1 回ずつ = 7ms)。
    now: () => (clock += 7),
    ...overrides,
  };
}

const profile = (over: Partial<HealthProfileLike> = {}): HealthProfileLike => ({
  id: "p1",
  name: "app",
  driver: "mysql",
  host: "db.internal",
  port: 3306,
  user: "app",
  database: "shop",
  file_path: null,
  is_production: false,
  read_only: false,
  ...over,
});

const up = (over: Partial<HealthProbeResult> = {}): HealthProbeResult => ({
  status: "up",
  latencyMs: 10,
  version: "8.0",
  connections: 3,
  ...over,
});

describe("isServerlessDriver", () => {
  it("SQLite / DuckDB はサーバを持たない", () => {
    expect(isServerlessDriver("sqlite")).toBe(true);
    expect(isServerlessDriver("duckdb")).toBe(true);
  });
  it("サーバ型ドライバは false", () => {
    for (const d of ["mysql", "postgres", "mssql"]) expect(isServerlessDriver(d)).toBe(false);
  });
});

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("時間内に返れば ok", async () => {
    await expect(withTimeout(Promise.resolve(1), 100)).resolves.toEqual({ kind: "ok", value: 1 });
  });

  it("失敗は例外にせず error に畳む (エラー文面を運ばない)", async () => {
    const r = await withTimeout(Promise.reject(new Error("password=secret")), 100);
    expect(r).toEqual({ kind: "error" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  it("返らなければ timeout", async () => {
    const p = withTimeout(never<number>(), 100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toEqual({ kind: "timeout" });
  });
});

describe("probeConnectionHealth", () => {
  it("up: レイテンシ・バージョン・接続数を集約する", async () => {
    const r = await probeConnectionHealth({ sessionId: "s1", driver: "mysql" }, deps());
    expect(r).toEqual({ status: "up", latencyMs: 7, version: "8.0.36", connections: 12 });
  });

  it("ping が false なら down で、追加の問い合わせをしない", async () => {
    const version = vi.fn(async () => "x");
    const connections = vi.fn(async () => 1);
    const r = await probeConnectionHealth(
      { sessionId: "s1", driver: "postgres" },
      deps({ ping: async () => false, version, connections }),
    );
    expect(r.status).toBe("down");
    expect(r.latencyMs).toBeNull();
    expect(version).not.toHaveBeenCalled();
    expect(connections).not.toHaveBeenCalled();
  });

  it("ping が例外 (セッション不明など) でも down", async () => {
    const r = await probeConnectionHealth(
      { sessionId: "s1", driver: "mysql" },
      deps({ ping: () => Promise.reject(new Error("session not found")) }),
    );
    expect(r.status).toBe("down");
  });

  it("ping が返らなければ timeout (キャッシュ済みバージョンは保つ)", async () => {
    vi.useFakeTimers();
    try {
      const p = probeConnectionHealth(
        { sessionId: "s1", driver: "mysql" },
        deps({ ping: () => never<boolean>() }),
        { timeoutMs: 50, cachedVersion: "8.0" },
      );
      await vi.advanceTimersByTimeAsync(50);
      await expect(p).resolves.toEqual({
        status: "timeout",
        latencyMs: null,
        version: "8.0",
        connections: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("SQLite / DuckDB は server_metrics を呼ばず接続数を N/A にする", async () => {
    const connections = vi.fn(async () => 1);
    for (const driver of ["sqlite", "duckdb"]) {
      const r = await probeConnectionHealth({ sessionId: "s1", driver }, deps({ connections }));
      expect(r.status).toBe("up");
      expect(r.connections).toBe("na");
    }
    expect(connections).not.toHaveBeenCalled();
  });

  it("バージョンがキャッシュ済みなら server_info を呼ばない", async () => {
    const version = vi.fn(async () => "new");
    const r = await probeConnectionHealth({ sessionId: "s1", driver: "mysql" }, deps({ version }), {
      cachedVersion: "cached",
    });
    expect(r.version).toBe("cached");
    expect(version).not.toHaveBeenCalled();
  });

  it("メタ情報の失敗は up 判定と互いに影響しない", async () => {
    const r = await probeConnectionHealth(
      { sessionId: "s1", driver: "mysql" },
      deps({ version: () => Promise.reject(new Error("x")) }),
    );
    expect(r).toMatchObject({ status: "up", version: null, connections: 12 });

    const r2 = await probeConnectionHealth(
      { sessionId: "s1", driver: "mysql" },
      deps({ connections: () => Promise.reject(new Error("denied")) }),
    );
    expect(r2).toMatchObject({ status: "up", version: "8.0.36", connections: null });
  });

  it("空白だけのバージョンは null", async () => {
    const r = await probeConnectionHealth(
      { sessionId: "s1", driver: "mysql" },
      deps({ version: async () => "  " }),
    );
    expect(r.version).toBeNull();
  });
});

describe("createHealthProber", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("前回の ping が返っていないセッションには新しい ping を積まない", async () => {
    const ping = vi.fn(() => never<boolean>());
    const prober = createHealthProber(deps({ ping }));
    const target = { sessionId: "s1", driver: "mysql" };

    const first = prober.probe(target, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    expect((await first).status).toBe("timeout");
    expect(prober.isInFlight("s1")).toBe(true);

    // 2 回目: バックエンドの ping はまだ走っているので呼ばずに timeout。
    const second = await prober.probe(target, { timeoutMs: 20 });
    expect(second.status).toBe("timeout");
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("ping が返れば次の問い合わせは通常どおり行う", async () => {
    let resolvePing: (v: boolean) => void = () => {};
    const ping = vi
      .fn<(sid: string) => Promise<boolean>>()
      .mockImplementationOnce(() => new Promise((r) => (resolvePing = r)))
      .mockImplementation(async () => true);
    const prober = createHealthProber(deps({ ping }));
    const target = { sessionId: "s1", driver: "mysql" };

    const first = prober.probe(target, { timeoutMs: 20 });
    await vi.advanceTimersByTimeAsync(20);
    await first;
    resolvePing(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(prober.isInFlight("s1")).toBe(false);

    const second = await prober.probe(target, { timeoutMs: 20 });
    expect(second.status).toBe("up");
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it("in-flight はセッションごとに独立", async () => {
    const ping = vi.fn((sid: string) => (sid === "hung" ? never<boolean>() : Promise.resolve(true)));
    const prober = createHealthProber(deps({ ping }));
    const hung = prober.probe({ sessionId: "hung", driver: "mysql" }, { timeoutMs: 20 });
    const ok = await prober.probe({ sessionId: "ok", driver: "mysql" }, { timeoutMs: 20 });
    expect(ok.status).toBe("up");
    await vi.advanceTimersByTimeAsync(20);
    expect((await hung).status).toBe("timeout");
  });
});

describe("checkAllConnections", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("1 接続の遅延が他の接続の結果をブロックしない (個別タイムアウト)", async () => {
    const ping = (sid: string) => (sid === "slow" ? never<boolean>() : Promise.resolve(true));
    const prober = createHealthProber(deps({ ping }));
    const targets = ["a", "slow", "b", "c"].map((sessionId) => ({ sessionId, driver: "mysql" }));
    const p = checkAllConnections(targets, (tgt) => prober.probe(tgt, { timeoutMs: 30 }));
    await vi.advanceTimersByTimeAsync(30);
    const out = await p;
    expect(out.map((r) => r.status)).toEqual(["up", "timeout", "up", "up"]);
  });

  it("同時に問い合わせる本数を制限する", async () => {
    let inFlight = 0;
    let peak = 0;
    const probe = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return up();
    };
    const targets = Array.from({ length: 10 }, (_, i) => ({ sessionId: `s${i}`, driver: "mysql" }));
    const p = checkAllConnections(targets, probe);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(peak).toBe(HEALTH_CHECK_CONCURRENCY);
  });
});

describe("formatHealthTarget", () => {
  it("user@host:port · database", () => {
    expect(formatHealthTarget(profile())).toBe("app@db.internal:3306 · shop");
  });
  it("ファイル型はファイルパス", () => {
    expect(formatHealthTarget(profile({ driver: "sqlite", file_path: "/tmp/a.db" }))).toBe("/tmp/a.db");
  });
  it("欠けた部分は省く", () => {
    expect(formatHealthTarget(profile({ user: "", database: null }))).toBe("db.internal:3306");
    expect(formatHealthTarget(profile({ host: "", user: "", port: 0, database: null }))).toBe("");
  });
  it("秘密フィールドを持つオブジェクトを渡しても表示に混ざらない", () => {
    const withSecret = { ...profile(), password: "hunter2", ssh: { passphrase: "s3cr3t-pass" } };
    const s = formatHealthTarget(withSecret);
    expect(s).not.toContain("hunter2");
    expect(s).not.toContain("s3cr3t-pass");
  });
});

describe("buildHealthRows", () => {
  const open = [
    { sessionId: "s-bg", profile: profile({ id: "bg", name: "bg" }) },
    { sessionId: "s-act", profile: profile({ id: "act", name: "act", read_only: true }) },
  ];
  const saved = [
    profile({ id: "bg", name: "bg" }),
    profile({ id: "zeta", name: "zeta" }),
    profile({ id: "alpha", name: "alpha", driver: "sqlite" }),
  ];

  it("アクティブ接続を先頭に、未確認は unknown", () => {
    const rows = buildHealthRows(open, saved, new Map(), {
      activeSessionId: "s-act",
      includeSaved: false,
    });
    expect(rows.map((r) => r.profileId)).toEqual(["act", "bg"]);
    expect(rows[0]).toMatchObject({ isActive: true, readOnly: true, status: "unknown" });
  });

  it("結果を反映する", () => {
    const rows = buildHealthRows(open, saved, new Map([["s-bg", up({ latencyMs: 42 })]]), {
      activeSessionId: "s-act",
      includeSaved: false,
    });
    expect(rows.find((r) => r.profileId === "bg")).toMatchObject({ status: "up", latencyMs: 42 });
  });

  it("保存済みを含めると、開いていないものだけ notConnected で名前順に後ろへ並べる", () => {
    const rows = buildHealthRows(open, saved, new Map(), {
      activeSessionId: "s-act",
      includeSaved: true,
    });
    expect(rows.map((r) => r.profileId)).toEqual(["act", "bg", "alpha", "zeta"]);
    const alpha = rows[2];
    expect(alpha).toMatchObject({ sessionId: null, status: "notConnected", connections: "na" });
    expect(rows[3]).toMatchObject({ sessionId: null, status: "notConnected", connections: null });
  });
});

describe("latencyLevel / healthStatusRole", () => {
  it("しきい値の境界", () => {
    expect(latencyLevel(0)).toBe("good");
    expect(latencyLevel(LATENCY_SLOW_MS - 1)).toBe("good");
    expect(latencyLevel(LATENCY_SLOW_MS)).toBe("slow");
    expect(latencyLevel(LATENCY_CRITICAL_MS - 1)).toBe("slow");
    expect(latencyLevel(LATENCY_CRITICAL_MS)).toBe("critical");
  });
  it("状態 → 意味色", () => {
    expect(healthStatusRole("up")).toBe("success");
    expect(healthStatusRole("timeout")).toBe("warning");
    expect(healthStatusRole("down")).toBe("danger");
    expect(healthStatusRole("unknown")).toBeNull();
    expect(healthStatusRole("notConnected")).toBeNull();
  });
});

describe("summarizeHealth", () => {
  const row = (status: HealthRow["status"], latencyMs: number | null = null): HealthRow => ({
    profileId: Math.random().toString(),
    name: "x",
    driver: "mysql",
    target: "",
    sessionId: status === "notConnected" ? null : "s",
    isActive: false,
    isProduction: false,
    readOnly: false,
    status,
    latencyMs,
    version: null,
    connections: null,
  });

  it("空なら 0 と null", () => {
    expect(summarizeHealth([])).toEqual({
      open: 0,
      up: 0,
      down: 0,
      timeout: 0,
      unknown: 0,
      notConnected: 0,
      maxLatencyMs: null,
      medianLatencyMs: null,
    });
  });

  it("状態ごとに数え、未接続は open に含めない", () => {
    const s = summarizeHealth([
      row("up", 10),
      row("up", 30),
      row("up", 20),
      row("down"),
      row("timeout"),
      row("unknown"),
      row("notConnected"),
    ]);
    expect(s).toMatchObject({ open: 6, up: 3, down: 1, timeout: 1, unknown: 1, notConnected: 1 });
    expect(s.maxLatencyMs).toBe(30);
    expect(s.medianLatencyMs).toBe(20);
  });

  it("偶数件の中央値は中間 2 値の平均 (丸め)", () => {
    expect(summarizeHealth([row("up", 10), row("up", 15)]).medianLatencyMs).toBe(13);
  });
});

describe("changedHealthSessions", () => {
  it("初回 (前回なし) はフラッシュしない", () => {
    expect(changedHealthSessions(new Map(), new Map([["s", up()]]))).toEqual(new Set());
  });

  it("状態・バージョン・接続数・レイテンシ段階の変化を拾う", () => {
    const prev = new Map([
      ["a", up()],
      ["b", up()],
      ["c", up()],
      ["d", up({ latencyMs: 10 })],
      ["e", up({ latencyMs: 10 })],
    ]);
    const next = new Map([
      ["a", up({ status: "down", latencyMs: null })],
      ["b", up({ version: "9.0" })],
      ["c", up({ connections: 4 })],
      ["d", up({ latencyMs: 15 })], // 同じ段階の揺れは無視
      ["e", up({ latencyMs: LATENCY_SLOW_MS })],
    ]);
    expect([...changedHealthSessions(prev, next)].sort()).toEqual(["a", "b", "c", "e"]);
  });
});

describe("pruneHealthResults", () => {
  it("閉じたセッションの結果を捨てる", () => {
    const m = new Map([
      ["live", up()],
      ["gone", up()],
    ]);
    expect([...pruneHealthResults(m, ["live"]).keys()]).toEqual(["live"]);
  });
});
