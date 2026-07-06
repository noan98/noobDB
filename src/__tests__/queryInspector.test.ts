import { describe, expect, it } from "vitest";

import type { LiveQuery, StatementStat } from "../api/tauri";
import {
  computeStatDelta,
  DEFAULT_N_PLUS_ONE_MIN_COUNT,
  DEFAULT_N_PLUS_ONE_WINDOW_MS,
  detectNPlusOne,
  filterLiveTail,
  formatMs,
  isPrivilegeMasked,
  mergeLiveTail,
  normalizeSqlFingerprint,
  nPlusOneFromRate,
  sanitizeNPlusOneOptions,
  supportReasonI18nKey,
  type LiveTailEntry,
} from "../components/queryInspector";

function stat(over: Partial<StatementStat>): StatementStat {
  return {
    digest: "d1",
    fingerprint: "select * from t where id = ?",
    database: "app",
    calls: 0,
    total_time_ms: 0,
    max_time_ms: 0,
    rows: null,
    ...over,
  };
}

function live(over: Partial<LiveQuery>): LiveQuery {
  return {
    key: "k1",
    query: "SELECT * FROM users WHERE id = 1",
    user: "app",
    host: "10.0.0.5:5432",
    database: "appdb",
    application: null,
    duration_ms: 1.5,
    rows_examined: null,
    running: false,
    started_at_ms: null,
    ...over,
  };
}

describe("normalizeSqlFingerprint", () => {
  it("数値・文字列リテラルを ? へ置換し、空白と大文字小文字を正規化する", () => {
    expect(normalizeSqlFingerprint("SELECT * FROM users\n WHERE id = 42")).toBe(
      "select * from users where id = ?",
    );
    expect(normalizeSqlFingerprint("select * from users where id = 7")).toBe(
      normalizeSqlFingerprint("SELECT *  FROM users WHERE id=42".replace("=", " = ")),
    );
    expect(normalizeSqlFingerprint("select * from t where name = 'alice'")).toBe(
      "select * from t where name = ?",
    );
  });

  it("エスケープを含む文字列リテラルを 1 リテラルとして畳む", () => {
    expect(normalizeSqlFingerprint("select 'a''b;c'")).toBe("select ?");
    expect(normalizeSqlFingerprint("select 'a\\'b', 2")).toBe("select ?, ?");
  });

  it("小数・指数・16 進リテラルも置換する", () => {
    expect(normalizeSqlFingerprint("select 1.5, 2e10, 0xFF from t")).toBe(
      "select ?, ?, ? from t",
    );
  });

  it("コメントを除去する", () => {
    expect(
      normalizeSqlFingerprint("select * from t -- trailing\nwhere a = 1 /* block */"),
    ).toBe("select * from t where a = ?");
    expect(normalizeSqlFingerprint("select * from t # mysql comment\nwhere a = 1")).toBe(
      "select * from t where a = ?",
    );
  });

  it("IN リストの要素数の違いを同型に畳む", () => {
    const a = normalizeSqlFingerprint("SELECT * FROM t WHERE id IN (1, 2, 3)");
    const b = normalizeSqlFingerprint("SELECT * FROM t WHERE id IN (4)");
    expect(a).toBe(b);
    expect(a).toBe("select * from t where id in (?)");
  });

  it("VALUES の複数行を 1 行に畳む (列数は保持する)", () => {
    const a = normalizeSqlFingerprint("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    const b = normalizeSqlFingerprint("INSERT INTO t VALUES (3, 'c')");
    expect(a).toBe(b);
    expect(a).toBe("insert into t values (?, ?)");
  });

  it("識別子中の数字は置換しない", () => {
    expect(normalizeSqlFingerprint("select col1 from table2")).toBe(
      "select col1 from table2",
    );
  });
});

describe("isPrivilegeMasked", () => {
  it("PostgreSQL の権限マスク行を検出する", () => {
    expect(isPrivilegeMasked("<insufficient privilege>")).toBe(true);
    expect(isPrivilegeMasked("  <insufficient privilege> ")).toBe(true);
    expect(isPrivilegeMasked("select 1")).toBe(false);
  });
});

describe("computeStatDelta", () => {
  it("記録開始時点からの差分を計算し総時間降順で返す", () => {
    const baseline = [
      stat({ digest: "a", calls: 10, total_time_ms: 100, rows: 50 }),
      stat({ digest: "b", calls: 5, total_time_ms: 500 }),
    ];
    const current = [
      stat({ digest: "a", calls: 14, total_time_ms: 140, max_time_ms: 30, rows: 70 }),
      stat({ digest: "b", calls: 6, total_time_ms: 900, max_time_ms: 400 }),
    ];
    const rows = computeStatDelta(baseline, current);
    expect(rows.map((r) => r.digest)).toEqual(["b", "a"]);
    const a = rows.find((r) => r.digest === "a");
    expect(a).toMatchObject({ calls: 4, totalTimeMs: 40, meanTimeMs: 10, rows: 20 });
    // max は高水位マークなので累積値のまま。
    expect(a?.maxTimeMs).toBe(30);
  });

  it("差分ゼロの digest は出さない", () => {
    const s = stat({ digest: "a", calls: 10, total_time_ms: 100 });
    expect(computeStatDelta([s], [s])).toEqual([]);
  });

  it("baseline に無い digest は初出として全量を差分にする", () => {
    const rows = computeStatDelta([], [stat({ digest: "new", calls: 3, total_time_ms: 30 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ calls: 3, totalTimeMs: 30, meanTimeMs: 10 });
  });

  it("カウンタ逆行 (サーバ側リセット) は baseline を 0 とみなす", () => {
    const rows = computeStatDelta(
      [stat({ digest: "a", calls: 100, total_time_ms: 1000, rows: 10 })],
      [stat({ digest: "a", calls: 4, total_time_ms: 40, rows: 2 })],
    );
    expect(rows[0]).toMatchObject({ calls: 4, totalTimeMs: 40, rows: 2 });
  });

  it("同じ digest でも database が違えば別行として扱う", () => {
    const rows = computeStatDelta(
      [stat({ digest: "a", database: "db1", calls: 5, total_time_ms: 10 })],
      [
        stat({ digest: "a", database: "db1", calls: 6, total_time_ms: 20 }),
        stat({ digest: "a", database: "db2", calls: 3, total_time_ms: 30 }),
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.database === "db1")?.calls).toBe(1);
    expect(rows.find((r) => r.database === "db2")?.calls).toBe(3);
  });

  it("rows が null のエンジン (PG activity 相当) では null を維持する", () => {
    const rows = computeStatDelta([], [stat({ digest: "a", calls: 1, rows: null })]);
    expect(rows[0].rows).toBeNull();
  });
});

describe("detectNPlusOne", () => {
  const at = (fingerprint: string, observedAtMs: number) => ({ fingerprint, observedAtMs });

  it("時間窓内に閾値以上の同型クエリがあるとフラグする", () => {
    const events = Array.from({ length: 12 }, (_, i) => at("q", 1000 + i * 100));
    const findings = detectNPlusOne(events, { minCount: 10, windowMs: 2000 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ fingerprint: "q", count: 12, windowMs: 2000 });
  });

  it("時間窓の外に散らばる場合はフラグしない", () => {
    const events = Array.from({ length: 12 }, (_, i) => at("q", i * 10_000));
    expect(detectNPlusOne(events, { minCount: 10, windowMs: 2000 })).toEqual([]);
  });

  it("入力の時刻順に依存しない", () => {
    const times = [5, 1, 3, 2, 4].map((tt) => at("q", tt * 100));
    expect(detectNPlusOne(times, { minCount: 5, windowMs: 1000 })).toHaveLength(1);
  });

  it("フィンガープリントごとに独立に判定し、回数降順で返す", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => at("a", i)),
      ...Array.from({ length: 8 }, (_, i) => at("b", i)),
      ...Array.from({ length: 3 }, (_, i) => at("c", i)),
    ];
    const findings = detectNPlusOne(events, { minCount: 5, windowMs: 1000 });
    expect(findings.map((f) => f.fingerprint)).toEqual(["b", "a"]);
  });

  it("窓境界: ちょうど windowMs 離れたイベントは同一窓に含む", () => {
    const events = [at("q", 0), at("q", 1000), at("q", 2000)];
    expect(detectNPlusOne(events, { minCount: 3, windowMs: 2000 })).toHaveLength(1);
    expect(detectNPlusOne(events, { minCount: 3, windowMs: 1999 })).toEqual([]);
  });
});

describe("sanitizeNPlusOneOptions / nPlusOneFromRate", () => {
  it("不正な閾値は既定値へフォールバックし、下限を強制する", () => {
    expect(sanitizeNPlusOneOptions({})).toEqual({
      minCount: DEFAULT_N_PLUS_ONE_MIN_COUNT,
      windowMs: DEFAULT_N_PLUS_ONE_WINDOW_MS,
    });
    expect(sanitizeNPlusOneOptions({ minCount: 0, windowMs: 1 })).toEqual({
      minCount: 2,
      windowMs: 100,
    });
    expect(sanitizeNPlusOneOptions({ minCount: NaN, windowMs: Infinity })).toEqual({
      minCount: DEFAULT_N_PLUS_ONE_MIN_COUNT,
      windowMs: DEFAULT_N_PLUS_ONE_WINDOW_MS,
    });
  });

  it("レート換算で時間窓あたりの回数が閾値以上なら true", () => {
    // 5 秒で 50 回 → 2 秒窓あたり 20 回 ≥ 10。
    expect(nPlusOneFromRate(50, 5000, { minCount: 10, windowMs: 2000 })).toBe(true);
    // 5 秒で 10 回 → 2 秒窓あたり 4 回 < 10。
    expect(nPlusOneFromRate(10, 5000, { minCount: 10, windowMs: 2000 })).toBe(false);
    expect(nPlusOneFromRate(0, 5000)).toBe(false);
    expect(nPlusOneFromRate(50, 0)).toBe(false);
  });
});

describe("mergeLiveTail", () => {
  it("新規イベントに観測時刻とフィンガープリントを刻んで先頭へ積む", () => {
    const merged = mergeLiveTail([], [live({ key: "a" }), live({ key: "b" })], 5000);
    expect(merged.map((e) => e.key)).toEqual(["a", "b"]);
    expect(merged[0].observedAtMs).toBe(5000);
    expect(merged[0].fingerprint).toBe("select * from users where id = ?");
  });

  it("既出キーは再追加せず、running → 完了の遷移だけを反映する", () => {
    const first = mergeLiveTail([], [live({ key: "a", running: true, duration_ms: 10 })], 1000);
    const second = mergeLiveTail(
      first,
      [live({ key: "a", running: false, duration_ms: 42 })],
      2000,
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ running: false, duration_ms: 42 });
    // 観測時刻は初回のまま (N+1 の窓判定がポーリングでズレない)。
    expect(second[0].observedAtMs).toBe(1000);
  });

  it("PG の開始時刻があれば観測時刻として優先する", () => {
    const merged = mergeLiveTail([], [live({ key: "a", started_at_ms: 1234 })], 9999);
    expect(merged[0].observedAtMs).toBe(1234);
  });

  it("上限超過分は最古から捨てる", () => {
    const existing = mergeLiveTail([], [live({ key: "old" })], 1000);
    const merged = mergeLiveTail(existing, [live({ key: "n1" }), live({ key: "n2" })], 2000, 2);
    expect(merged.map((e) => e.key)).toEqual(["n1", "n2"]);
  });

  it("入力配列を変更しない", () => {
    const existing = mergeLiveTail([], [live({ key: "a", running: true })], 1000);
    const snapshot = JSON.parse(JSON.stringify(existing));
    mergeLiveTail(existing, [live({ key: "a", running: false })], 2000);
    expect(existing).toEqual(snapshot);
  });
});

describe("filterLiveTail", () => {
  const entries: LiveTailEntry[] = [
    { ...live({ key: "a", user: "app", duration_ms: 5 }), observedAtMs: 0, fingerprint: "f" },
    {
      ...live({ key: "b", user: "batch", database: "warehouse", duration_ms: 200 }),
      observedAtMs: 0,
      fingerprint: "f",
    },
  ];

  it("user/host/db/クエリ本文への大小無視部分一致で絞る", () => {
    expect(filterLiveTail(entries, { text: "BATCH", minDurationMs: null })).toHaveLength(1);
    expect(filterLiveTail(entries, { text: "users", minDurationMs: null })).toHaveLength(2);
    expect(filterLiveTail(entries, { text: "", minDurationMs: null })).toHaveLength(2);
  });

  it("所要時間の下限で絞る (不明値は隠す)", () => {
    expect(filterLiveTail(entries, { text: "", minDurationMs: 100 }).map((e) => e.key)).toEqual([
      "b",
    ]);
    const unknown: LiveTailEntry[] = [
      { ...live({ key: "u", duration_ms: null }), observedAtMs: 0, fingerprint: "f" },
    ];
    expect(filterLiveTail(unknown, { text: "", minDurationMs: 1 })).toEqual([]);
  });
});

describe("supportReasonI18nKey", () => {
  it("既知の理由コードを i18n キーにマップし、未知は汎用へフォールバックする", () => {
    expect(supportReasonI18nKey("unsupported_driver")).toBe("inspectorReasonUnsupportedDriver");
    expect(supportReasonI18nKey("performance_schema_off")).toBe(
      "inspectorReasonPerformanceSchemaOff",
    );
    expect(supportReasonI18nKey("statements_consumer_off")).toBe("inspectorReasonConsumerOff");
    expect(supportReasonI18nKey("statements_digest_off")).toBe("inspectorReasonDigestOff");
    expect(supportReasonI18nKey("pg_stat_statements_missing")).toBe("inspectorReasonPgssMissing");
    expect(supportReasonI18nKey("stats_unreadable")).toBe("inspectorReasonUnreadable");
    expect(supportReasonI18nKey("some_future_code")).toBe("inspectorReasonUnknown");
  });
});

describe("formatMs", () => {
  it("レンジに応じた表示に整形する", () => {
    expect(formatMs(null)).toBe("–");
    expect(formatMs(0.123)).toBe("0.12ms");
    expect(formatMs(42)).toBe("42.0ms");
    expect(formatMs(2500)).toBe("2.50s");
    expect(formatMs(65_000)).toBe("65.0s");
    expect(formatMs(-1)).toBe("–");
  });
});
