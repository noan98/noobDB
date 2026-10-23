import { describe, expect, it } from "vitest";
import {
  LATENCY_HISTORY_MAX,
  appendLatencyHistory,
  sparklineGeometry,
  LATENCY_CRITICAL_MS,
  LATENCY_SLOW_MS,
  buildHealthRows,
  changedHealthSessions,
  formatHealthTarget,
  healthStatusRole,
  isServerlessDriver,
  latencyLevel,
  pruneHealthResults,
  sameHealthResults,
  summarizeHealth,
  toHealthProbeResult,
  type HealthProbeItemLike,
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
  it("SQLite はサーバを持たない", () => {
    expect(isServerlessDriver("sqlite")).toBe(true);
  });
  it("サーバ型ドライバは false", () => {
    for (const d of ["mysql", "postgres"]) expect(isServerlessDriver(d)).toBe(false);
  });
});

describe("toHealthProbeResult (health_probe_all の観測値 → 表示状態, #1259)", () => {
  const item = (over: Partial<HealthProbeItemLike> = {}): HealthProbeItemLike => ({
    session_id: "s1",
    status: "up",
    latency_ms: 7,
    version: "8.0.36",
    connections: 12,
    ...over,
  });
  const mysql = { sessionId: "s1", driver: "mysql" };

  it("up: レイテンシ・バージョン・接続数をそのまま反映する", () => {
    expect(toHealthProbeResult(mysql, item())).toEqual({
      status: "up",
      latencyMs: 7,
      version: "8.0.36",
      connections: 12,
    });
  });

  it("down / timeout ではレイテンシと接続数を持たず、キャッシュ済みバージョンは保つ", () => {
    for (const status of ["down", "timeout"] as const) {
      expect(toHealthProbeResult(mysql, item({ status, latency_ms: 3, connections: 5 }))).toEqual({
        status,
        latencyMs: null,
        version: "8.0.36",
        connections: null,
      });
    }
  });

  it("SSH トンネルが閉じていれば tunnelClosed を立て、生存・トンネル無しでは立てない (#1537)", () => {
    expect(toHealthProbeResult(mysql, item({ status: "down", tunnel_alive: false }))).toMatchObject({
      status: "down",
      tunnelClosed: true,
    });
    expect(toHealthProbeResult(mysql, item({ tunnel_alive: true }))).not.toHaveProperty("tunnelClosed");
    expect(toHealthProbeResult(mysql, item({ tunnel_alive: null }))).not.toHaveProperty("tunnelClosed");
  });

  it("SQLite は接続数を常に N/A にする", () => {
    expect(
      toHealthProbeResult({ sessionId: "s1", driver: "sqlite" }, item({ connections: null })),
    ).toMatchObject({
      status: "up",
      connections: "na",
    });
    expect(
      toHealthProbeResult({ sessionId: "s1", driver: "sqlite" }, item({ status: "down" })).connections,
    ).toBe("na");
  });

  it("接続数が取れなかったサーバ型 (up) は null のまま", () => {
    expect(toHealthProbeResult(mysql, item({ connections: null })).connections).toBeNull();
  });

  it("空白だけ / 無いバージョンは null", () => {
    expect(toHealthProbeResult(mysql, item({ version: "  " })).version).toBeNull();
    expect(toHealthProbeResult(mysql, item({ version: null })).version).toBeNull();
    expect(toHealthProbeResult(mysql, item({ version: " 16.2 " })).version).toBe("16.2");
  });

  it("項目が返らなかったセッションは down 扱い", () => {
    expect(toHealthProbeResult(mysql, undefined)).toEqual({
      status: "down",
      latencyMs: null,
      version: null,
      connections: null,
    });
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

describe("tunnelClosed の伝播 (#1537)", () => {
  const base: HealthProbeResult = { status: "down", latencyMs: null, version: null, connections: null };

  it("buildHealthRows が行に引き継ぎ、変化はフラッシュ対象になる", () => {
    const p = { ...profile({ id: "p1", name: "app" }) };
    const results = new Map<string, HealthProbeResult>([["s1", { ...base, tunnelClosed: true }]]);
    const rows = buildHealthRows([{ sessionId: "s1", profile: p }], [], results, {
      activeSessionId: "s1",
      includeSaved: false,
    });
    expect(rows[0].tunnelClosed).toBe(true);
    const prev = new Map<string, HealthProbeResult>([["s1", base]]);
    expect(changedHealthSessions(prev, results).has("s1")).toBe(true);
  });
});

describe("sameHealthResults (#1617)", () => {
  const r = (over: Partial<HealthProbeResult> = {}): HealthProbeResult => ({
    status: "up",
    latencyMs: 12,
    version: "8.0",
    connections: 3,
    ...over,
  });
  it("表示がまったく同じなら true (遅延 ms の違いは false)", () => {
    expect(sameHealthResults(new Map([["a", r()]]), new Map([["a", r()]]))).toBe(true);
    expect(sameHealthResults(new Map([["a", r()]]), new Map([["a", r({ latencyMs: 13 })]]))).toBe(false);
    expect(sameHealthResults(new Map([["a", r()]]), new Map([["a", r({ connections: 4 })]]))).toBe(false);
  });
  it("件数やキーが違えば false、tunnelClosed の未指定と false は同じ", () => {
    expect(sameHealthResults(new Map([["a", r()]]), new Map())).toBe(false);
    expect(sameHealthResults(new Map([["a", r()]]), new Map([["b", r()]]))).toBe(false);
    expect(sameHealthResults(new Map([["a", r()]]), new Map([["a", r({ tunnelClosed: false })]]))).toBe(true);
  });
});

describe("レイテンシ履歴とスパークライン (#1630)", () => {
  const up = (latencyMs: number): HealthProbeResult => ({
    status: "up",
    latencyMs,
    version: null,
    connections: null,
  });
  const down: HealthProbeResult = { status: "down", latencyMs: null, version: null, connections: null };

  it("確認のたびに履歴へ足し、down は欠測 (null) として残す", () => {
    let h = appendLatencyHistory(new Map(), new Map([["s1", up(10)]]));
    h = appendLatencyHistory(h, new Map([["s1", down]]));
    h = appendLatencyHistory(h, new Map([["s1", up(30)]]));
    expect(h.get("s1")).toEqual([10, null, 30]);
  });

  it("閉じたセッションの履歴は捨て、最大件数に切り詰める", () => {
    let h = appendLatencyHistory(
      new Map(),
      new Map([
        ["a", up(1)],
        ["b", up(2)],
      ]),
    );
    h = appendLatencyHistory(h, new Map([["a", up(3)]]));
    expect(h.has("b")).toBe(false);
    for (let i = 0; i < LATENCY_HISTORY_MAX + 5; i++) {
      h = appendLatencyHistory(h, new Map([["a", up(i)]]));
    }
    expect(h.get("a")).toHaveLength(LATENCY_HISTORY_MAX);
    expect(h.get("a")?.at(-1)).toBe(LATENCY_HISTORY_MAX + 4);
  });

  it("閾値を超えた区間は slow / critical になり、新しいサンプルが右端に来る", () => {
    const g = sparklineGeometry([10, 20, LATENCY_SLOW_MS + 50, LATENCY_CRITICAL_MS + 1], 60, 20, 4);
    expect(g.segments.map((s) => s.level)).toEqual(["good", "slow", "critical"]);
    expect(g.segments.at(-1)?.x2).toBe(60);
    expect(g.segments[0].x1).toBe(0);
    expect(g.maxMs).toBe(LATENCY_CRITICAL_MS + 1);
  });

  it("欠測は区間を切って下端の印になり、孤立点は点で返す", () => {
    const g = sparklineGeometry([10, null, 12, null, 14, 15], 50, 10, 6);
    expect(g.gaps).toHaveLength(2);
    expect(g.gaps.every((p) => p.y === 10)).toBe(true);
    // 10 と 12 は欠測で分断されるので孤立点、14-15 だけが区間になる。
    expect(g.points).toHaveLength(2);
    expect(g.segments).toHaveLength(1);
  });

  it("縦軸は最低でも遅い閾値まで取り、小さな揺らぎが大きく見えない", () => {
    const g = sparklineGeometry([1, 3], 10, 20, 2);
    expect(g.maxMs).toBe(LATENCY_SLOW_MS);
    expect(g.segments[0].y1).toBeGreaterThan(19);
    expect(g.thresholdY).toBe(0);
  });
});

describe("sparklineGeometry neutral (#1833)", () => {
  it("閾値を超える値でも段階色を付けず、縦軸は最小〜最大に張る", () => {
    const g = sparklineGeometry([100, 5000], 10, 20, 2, true);
    expect(g.segments[0].level).toBe("good");
    expect(g.segments[0].y1).toBe(20);
    expect(g.segments[0].y2).toBe(0);
  });
  it("全点が同値なら中央の水平線", () => {
    const g = sparklineGeometry([7, 7, 7], 10, 20, 3, true);
    expect(g.segments.every((s) => s.y1 === 10 && s.y2 === 10)).toBe(true);
  });
  it("NaN は欠測扱いで縦軸を壊さない", () => {
    const g = sparklineGeometry([1, Number.NaN, 3], 10, 20, 3, true);
    expect(g.maxMs).toBe(3);
    expect(g.segments.every((s) => Number.isFinite(s.y1) && Number.isFinite(s.y2))).toBe(true);
  });
});
